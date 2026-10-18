//! Android-Handy als Rechenhilfe (Pro; Quelle `main/phone.ts`, `main/phone-ffmpeg.ts`): Per adb (USB- oder WLAN-Debugging)
//! rechnet das Handy die Clip-Gruppen des Video-Exports mit einem statischen ffmpeg und die Spracherkennung mit sherpa-onnx
//! und Parakeet. Gemessen 12.10.: Galaxy S20+ libx264 1080p veryfast 52 fps, AMD A4-9125 ~10 fps; ASR RTF 0,18 statt ~0,8.
//! Scheitert das Handy, rechnet der PC ([`PhoneRunner`] für den Export, beim ASR der Aufrufer von [`Phone::decode`]).
//!
//! Große Dateien gehen per `adb push` aufs Handy (die Daten laufen ganz im adb-Prozess), mit Größenprüfung per `stat` und
//! Stillstandswache. exec-in-Streaming brach in Electron nach ~1 GB ab (12.10., „write EPIPE“).
//! Weggelassen: Sprecherstimme auf dem Handy (`phoneTts`), Standbilder vom Handy (`phoneFrames`), geschätzter ASR-Fortschritt.

mod asr;
mod fetch;
mod remote;

pub use asr::{PhoneResult, asr_cmd, parse_results, wav};
pub use fetch::{ar_member, termux_libcxx};
pub use remote::{PhoneRunner, Remote, plan_remote, script, stale};

use dw_video::ffmpeg::{self, Cancel, Error, Result};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Ablage auf dem Handy (Programme, Modelle, Quell-Cache, Export-Ordner)
pub const PHONE_DIR: &str = "/data/local/tmp/deckwerk";
/// Frist für kleine adb-Schritte: schläft das Handy oder hängt USB, rechnet bald der PC
const QUICK: Duration = Duration::from_secs(30);
/// Frist für große Schritte (Push vieler Dateien, Erkennung)
const LONG: Duration = Duration::from_secs(30 * 60);
/// Stillstandswache: so lange ohne Fortschritt (Upload-Größe bzw. `-progress`) → abbrechen
const STALL: Duration = Duration::from_secs(120);

/// Marker unter appData/<app_id> (gemeinsam für App, Entwicklung und MCP-Server): vorhanden = Option aus.
/// Ohne Marker rechnet ein verbundenes Handy, der PC ist der Rückfall.
pub fn phone_marker(app_data: &Path, app_id: &str) -> PathBuf {
    app_data.join(app_id).join("phone-off")
}

/// Option „Android-Handy als Rechenhilfe“ eingeschaltet?
pub fn phone_on(app_data: &Path, app_id: &str) -> bool {
    !phone_marker(app_data, app_id).exists()
}

/// Ein Argument für die Shell des Handys: in einfache Anführungszeichen, `'` als `'\''`
pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Verbundene Geräte aus `adb devices -l` (nur freigegebene, nicht „unauthorized“): (Seriennummer, Modell)
pub fn parse_devices(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            let serial = w.next()?;
            if w.next()? != "device" {
                return None;
            }
            let model = w
                .find_map(|x| x.strip_prefix("model:"))
                .unwrap_or(serial)
                .replace('_', " ");
            Some((serial.to_string(), model))
        })
        .collect()
}

/// `stat -c '%Y %s %n'` → Pfad → (mtime s, Größe)
pub fn parse_stat(out: &str) -> HashMap<String, (u64, u64)> {
    out.lines()
        .filter_map(|l| {
            let mut w = l.trim().splitn(3, ' ');
            let t = w.next()?.parse().ok()?;
            let size = w.next()?.parse().ok()?;
            Some((w.next()?.to_string(), (t, size)))
        })
        .collect()
}

/// `stat -c '%n %s'` → Name → Größe
pub fn parse_sizes(out: &str) -> HashMap<String, u64> {
    out.lines()
        .filter_map(|l| {
            let (n, s) = l.trim().rsplit_once(' ')?;
            Some((n.to_string(), s.parse().ok()?))
        })
        .collect()
}

fn tail(err: &str, n: usize) -> String {
    let ls: Vec<&str> = err.trim().lines().collect();
    ls[ls.len().saturating_sub(n)..].join("\n")
}

/// Eindeutiger Name je Lauf (PID + Zähler): parallele Läufe im selben Prozess teilen sich keine Ordner
pub(crate) fn uniq() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "{}-{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

/// adb mit Frist `d` und Abbruch durch den Aufrufer; Code ≠ 0 → Fehler mit dem Ende von stderr
fn adb(args: &[&str], d: Duration, cancel: &Cancel) -> Result<String> {
    cancel.check()?;
    let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let inner = Cancel::with_timeout(d);
    let done = std::sync::atomic::AtomicBool::new(false);
    // exec kennt nur ein Cancel: der Abbruch des Aufrufers wird auf das mit der Frist übertragen
    let r = std::thread::scope(|s| {
        s.spawn(|| {
            while !done.load(std::sync::atomic::Ordering::Relaxed) {
                if cancel.check().is_err() {
                    inner.cancel();
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let r = ffmpeg::exec(Path::new("adb"), &a, None, None, &inner);
        done.store(true, std::sync::atomic::Ordering::Relaxed);
        r
    });
    let r = match r {
        Err(Error::Cancelled | Error::Timeout) if cancel.check().is_err() => {
            return cancel.check().map(|_| String::new());
        }
        // eigene Frist: ein Hänger von adb ist ein Handy-Fehler (Rückfall), kein Zeitlimit des Exports
        Err(Error::Timeout) => {
            return Err(Error::Media(format!(
                "adb {}: keine Antwort in {} s",
                args.get(2).unwrap_or(&""),
                d.as_secs()
            )));
        }
        r => r?,
    };
    if r.code != Some(0) {
        return Err(Error::Media(format!(
            "adb {} (Code {}): {}",
            args.get(2).unwrap_or(&""),
            r.code.map_or("null".into(), |c| c.to_string()),
            tail(&r.err, 3)
        )));
    }
    Ok(String::from_utf8_lossy(&r.out).into_owned())
}

/// Ein verbundenes Handy
#[derive(Debug, Clone, PartialEq)]
pub struct Phone {
    pub serial: String,
    /// Modell zur Anzeige („SM G986B“)
    pub model: String,
    /// `ro.product.cpu.abi`; ffmpeg und sherpa gibt es nur für arm64-v8a
    pub abi: String,
    /// Ordner für Quell-Cache, Exporte und Erkennungsläufe (Standard [`PHONE_DIR`], Tests eigener Unterordner);
    /// Programme und Modelle liegen immer unter [`PHONE_DIR`]
    pub work: String,
}

impl Phone {
    pub fn new(serial: &str, model: &str, abi: &str) -> Self {
        Self {
            serial: serial.into(),
            model: model.into(),
            abi: abi.into(),
            work: PHONE_DIR.into(),
        }
    }

    /// Erstes freigegebenes Handy oder None (auch ohne adb)
    pub fn detect() -> Option<Phone> {
        let (serial, model) =
            parse_devices(&adb(&["devices", "-l"], Duration::from_secs(10), &Cancel::new()).ok()?)
                .into_iter()
                .next()?;
        let mut p = Phone::new(&serial, &model, "");
        p.abi = p.shell("getprop ro.product.cpu.abi").ok()?.trim().into();
        Some(p)
    }

    fn adb(&self, args: &[&str], d: Duration, cancel: &Cancel) -> Result<String> {
        let mut a = vec!["-s", &self.serial];
        a.extend_from_slice(args);
        adb(&a, d, cancel)
    }

    /// Befehl in der Shell des Handys (Frist 30 s)
    pub fn shell(&self, cmd: &str) -> Result<String> {
        self.adb(&["shell", cmd], QUICK, &Cancel::new())
    }

    fn check_abi(&self) -> Result<()> {
        if self.abi != "arm64-v8a" {
            return Err(Error::Media(format!(
                "Handy {} ({}) wird nicht unterstützt, nur arm64-v8a",
                self.model, self.abi
            )));
        }
        Ok(())
    }

    /// Datei per `adb push` aufs Handy, Fortschritt aus der wachsenden Größe auf dem Handy (`stat` alle 2 s);
    /// wächst sie 120 s nicht (USB hängt), Abbruch. Erst `.part`, dann umbenennen: kein Rest mit falscher Größe.
    fn upload(
        &self,
        from: &Path,
        to: &str,
        on_bytes: &mut dyn FnMut(u64),
        cancel: &Cancel,
    ) -> Result<()> {
        let part = format!("{to}.part");
        let size = std::fs::metadata(from)?.len();
        // Rest eines abgebrochenen Laufs: seine Größe hielte die Wache sonst für Fortschritt
        self.shell(&format!("rm -f {}", quote(&part)))?;
        let mut child = Command::new("adb")
            .args(["-s", &self.serial, "push"])
            .arg(from)
            .arg(&part)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::Media(format!("adb nicht startbar: {e}")))?;
        let mut stderr = child.stderr.take().unwrap();
        let err_t = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });
        let (mut n, mut grown, mut polled) = (0u64, Instant::now(), Instant::now());
        let mut why: Option<Error> = None;
        let status = loop {
            if let Some(s) = child.try_wait()? {
                break Some(s);
            }
            if let Err(e) = cancel.check() {
                why = Some(e);
                break None;
            }
            if polled.elapsed() >= Duration::from_secs(2) {
                polled = Instant::now();
                let k = self
                    .shell(&format!(
                        "stat -c %s {} 2>/dev/null || echo 0",
                        quote(&part)
                    ))
                    .ok()
                    .and_then(|o| o.trim().parse().ok())
                    .unwrap_or(0);
                if k > n {
                    (n, grown) = (k, Instant::now());
                    on_bytes(k);
                } else if grown.elapsed() >= STALL {
                    why = Some(Error::Media(String::new()));
                    break None;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        if status.is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let err = err_t.join().unwrap_or_default();
        let fail = match (status, why) {
            (Some(s), _) if s.success() => None,
            (_, Some(e @ (Error::Cancelled | Error::Timeout))) => Some(e),
            (s, _) => Some(Error::Media(format!(
                "{} aufs Handy übertragen fehlgeschlagen nach {:.2} von {:.2} GB ({}{})",
                from.file_name().unwrap_or_default().to_string_lossy(),
                n as f64 / 1e9,
                size as f64 / 1e9,
                s.map_or("keine Übertragung seit 120 s".into(), |s| format!(
                    "adb Code {}",
                    s.code().map_or("null".into(), |c| c.to_string())
                )),
                err.trim()
                    .lines()
                    .last()
                    .map_or(String::new(), |l| format!(": {l}"))
            ))),
        };
        if let Some(e) = fail {
            let _ = self.shell(&format!("rm -f {}", quote(&part)));
            return Err(e);
        }
        on_bytes(size);
        self.shell(&format!("mv {} {}", quote(&part), quote(to)))?;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// leerer Testordner unter target (nie /tmp: kleines tmpfs)
    pub(crate) fn dir(name: &str) -> PathBuf {
        let d = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("dw-phone-unit")
            .join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn adb_abbrechbar() {
        // wait-for-device blockiert ohne dieses Gerät endlos: der Abbruch des Aufrufers muss vor der Frist greifen
        let c = Cancel::new();
        let c2 = c.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            c2.cancel();
        });
        let t0 = Instant::now();
        let r = adb(
            &["-s", "gibt-es-nicht", "wait-for-device"],
            Duration::from_secs(60),
            &c,
        );
        t.join().unwrap();
        match r {
            Err(Error::Missing(_)) => eprintln!("übersprungen: kein adb"),
            r => assert!(
                matches!(r, Err(Error::Cancelled)) && t0.elapsed() < Duration::from_secs(10),
                "{r:?}"
            ),
        }
        assert!(
            adb(&["version"], Duration::from_secs(10), &c).is_err(),
            "schon abgebrochen"
        );
    }

    #[test]
    fn geraete() {
        let out = "List of devices attached\nR5CN30PBM0R            device usb:1-3 product:y2sxeea model:SM_G986B device:y2s transport_id:3\nabc unauthorized usb:1-4 transport_id:4\n192.168.0.5:5555 device\n\n";
        assert_eq!(
            parse_devices(out),
            vec![
                ("R5CN30PBM0R".into(), "SM G986B".into()),
                ("192.168.0.5:5555".into(), "192.168.0.5:5555".into())
            ]
        );
    }

    #[test]
    fn stat_ausgaben() {
        let m = parse_stat(
            "1760000000 113094216 /data/local/tmp/deckwerk/ffmpeg\n17 5 /x/src/a b.mp4\nstat: kaputt\n",
        );
        assert_eq!(
            m["/data/local/tmp/deckwerk/ffmpeg"],
            (1760000000, 113094216)
        );
        assert_eq!(m["/x/src/a b.mp4"], (17, 5));
        assert_eq!(m.len(), 2);
        let s = parse_sizes("ffmpeg 113094216\nparakeet-ultra/tokens.txt 93939\nkaputt\n");
        assert_eq!(s["parakeet-ultra/tokens.txt"], 93939);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn eindeutige_namen() {
        assert_ne!(uniq(), uniq());
    }

    #[test]
    fn quoting_und_marker() {
        assert_eq!(quote("a'b c"), r"'a'\''b c'");
        assert_eq!(
            phone_marker(Path::new("/cfg"), "deckwerk-pro"),
            PathBuf::from("/cfg/deckwerk-pro/phone-off")
        );
        assert!(phone_on(Path::new("/gibt/es/nicht"), "deckwerk"));
    }
}
