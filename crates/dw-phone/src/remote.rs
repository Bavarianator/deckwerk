//! ffmpeg auf dem Handy (`phone-ffmpeg.ts`): Quellvideos in einen Cache auf dem Handy (nichts doppelt), Arbeitsdateien in einen
//! Export-Ordner, Befehl als Skript, Fortschritt aus `-progress`, fertige Datei zurück. [`PhoneRunner`] hängt das als
//! [`Runner`] in den Clip-Export von dw-video und rechnet nach dem ersten Fehler lokal weiter.
//! libass rendert auf Android ohne fontconfig-Konfiguration („Cannot load default config file“), nimmt die Schriften aus fontsdir aber.

use crate::{LONG, PHONE_DIR, Phone, STALL, fetch, parse_stat, quote, tail};
use dw_video::ffmpeg::{self, Cancel, Error, Local, Result, Runner};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Quellvideos (Streams bis 2,4 GB) bleiben auf dem Handy für die nächste Szene, aber nur die zuletzt genutzten
const KEEP: usize = 2;

fn ff() -> String {
    format!("{PHONE_DIR}/ffmpeg")
}

/// Ein ffmpeg-Aufruf fürs Handy: Argumente mit Handy-Pfaden, was hochzuladen und was zurückzuholen ist
#[derive(Debug, Clone, PartialEq)]
pub struct Remote {
    /// Export-Ordner auf dem Handy (entfernter cwd)
    pub dir: String,
    pub args: Vec<String>,
    /// Quellen außerhalb von cwd → Pfad im Cache (`<work>/src/<hash>.<ext>`)
    pub sources: Vec<(PathBuf, String)>,
    /// Dateien/Ordner aus cwd, die der Aufruf nennt (`<id>.ass`, `fonts`) → `<dir>/<name>`
    pub files: Vec<PathBuf>,
    /// Ausgabe (Handy → PC); None bei `-f null -`
    pub out: Option<(String, PathBuf)>,
}

fn inside(dir: &Path, p: &Path) -> bool {
    p.strip_prefix(dir).is_ok_and(|r| !r.as_os_str().is_empty())
}

/// Plan für `args` (ohne `-hide_banner -nostdin -y -nostats`) im Arbeitsordner `cwd`: absolute Eingänge außerhalb von cwd
/// in den Cache (Name aus Pfad, Größe, Zeit), absolute Pfade unter cwd nach `dir`, relative (Filtergraph) bleiben.
pub fn plan_remote(cwd: &Path, args: &[String], work: &str) -> Result<Remote> {
    let cwd = std::path::absolute(cwd)?;
    let dir = format!(
        "{work}/export/{}",
        cwd.file_name().unwrap_or_default().to_string_lossy()
    );
    let mut sources: Vec<(PathBuf, String)> = Vec::new();
    for (i, a) in args.iter().enumerate() {
        let p = Path::new(a);
        if i > 0
            && args[i - 1] == "-i"
            && p.is_absolute()
            && !inside(&cwd, p)
            && !sources.iter().any(|(s, _)| s == p)
        {
            let m = std::fs::metadata(p)?;
            let t = m
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            let h: String = Sha256::digest(format!("{a}|{}|{}", m.len(), t.as_nanos()))
                .iter()
                .take(20)
                .map(|b| format!("{b:02x}"))
                .collect();
            let ext = p
                .extension()
                .map_or(String::new(), |e| format!(".{}", e.to_string_lossy()));
            sources.push((p.to_path_buf(), format!("{work}/src/{h}{ext}")));
        }
    }
    let map = |a: &String| -> String {
        if let Some((_, r)) = sources.iter().find(|(s, _)| s.as_os_str() == a.as_str()) {
            return r.clone();
        }
        let p = Path::new(a);
        match p.strip_prefix(&cwd) {
            Ok(r) if p.is_absolute() && !r.as_os_str().is_empty() => {
                format!("{dir}/{}", r.to_string_lossy())
            }
            _ => a.clone(),
        }
    };
    let mut rargs: Vec<String> = args.iter().map(map).collect();
    let out = args
        .last()
        .filter(|o| *o != "-" && !o.starts_with('-') && !o.contains("pipe:"))
        .map(|o| {
            let p = Path::new(o);
            let local = if p.is_absolute() {
                p.to_path_buf()
            } else {
                cwd.join(p)
            };
            // Ziel außerhalb von cwd: auf dem Handy in den Export-Ordner
            let remote = if inside(&cwd, &local) {
                format!(
                    "{dir}/{}",
                    local.strip_prefix(&cwd).unwrap().to_string_lossy()
                )
            } else {
                format!(
                    "{dir}/{}",
                    local.file_name().unwrap_or_default().to_string_lossy()
                )
            };
            *rargs.last_mut().unwrap() = remote.clone();
            (remote, local)
        });
    // ein Schritt braucht oft mehr als seine Pfade: was der Aufruf beim Namen nennt (ass=g.ass:fontsdir=fonts)
    let skip = out.as_ref().map(|(_, l)| l.clone());
    let mut files: Vec<PathBuf> = std::fs::read_dir(&cwd)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| Some(p) != skip.as_ref())
        .filter(|p| {
            let n = p.file_name().unwrap_or_default().to_string_lossy();
            // ganze Bestandteile (Pfad, Filteroption), nicht Teilwörter: „a“ steckt in fast jedem Argument
            !n.starts_with('.')
                && args.iter().any(|a| {
                    a.split(['/', ':', '=', ',', ';', '\'', '[', ']'])
                        .any(|w| w == n.as_ref())
                })
        })
        .collect();
    files.sort();
    Ok(Remote {
        dir,
        args: rargs,
        sources,
        files,
        out,
    })
}

/// Quellen im Cache, die weg können: alle außer den gebrauchten und den zuletzt genutzten, bis es zusammen `keep` sind
pub fn stale(cached: &[(String, u64)], used: &[String], keep: usize) -> Vec<String> {
    let mut c: Vec<&(String, u64)> = cached.iter().filter(|(p, _)| !used.contains(p)).collect();
    c.sort_by_key(|x| std::cmp::Reverse(x.1));
    c.into_iter()
        .skip(keep.saturating_sub(used.len()))
        .map(|(p, _)| p.clone())
        .collect()
}

/// Befehl als Skript: `adb shell` nimmt höchstens ~64 KB (12.10. gemessen), Filtergraphen mit 20 Ausschnitten können länger werden.
/// `exec`: ffmpeg behält die PID der Shell aus `pid`, der Abbruch beendet genau diesen Prozess.
pub fn script(r: &Remote) -> String {
    // zuletzt genutzt (push übernimmt die alte Zeit)
    let touch = if r.sources.is_empty() {
        String::new()
    } else {
        format!(
            "touch {} && ",
            r.sources
                .iter()
                .map(|(_, s)| quote(s))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    format!(
        "echo $$ > {} && {touch}cd {} && exec {} -hide_banner -nostdin -y -nostats -progress pipe:1 {}\n",
        quote(&format!("{}/pid", r.dir)),
        quote(&r.dir),
        ff(),
        r.args
            .iter()
            .map(|a| quote(a))
            .collect::<Vec<_>>()
            .join(" ")
    )
}

impl Phone {
    /// ffmpeg auf dem Handy statt auf dem PC (Plan aus [`plan_remote`]); `progress` meldet die Ausgabezeit in s wie
    /// [`ffmpeg::run_in`]. Abbruch beendet ffmpeg auf dem Handy; 120 s ohne Fortschritt → Fehler.
    pub fn run_remote_ffmpeg(
        &self,
        models: &Path,
        job: &Remote,
        progress: Option<&mut dyn FnMut(f64)>,
        cancel: &Cancel,
    ) -> Result<()> {
        self.check_abi()?;
        let (src, ff) = (format!("{}/src", self.work), ff());
        // zuerst: ohne Handy scheitert es hier, bevor das ffmpeg fürs Handy geladen wird
        let have = parse_stat(&self.shell(&format!(
            "stat -c '%Y %s %n' {ff} {}/* 2>/dev/null; true",
            quote(&src)
        ))?);
        let bin = fetch::ffmpeg_binary(models)?;
        if have.get(&ff).map(|h| h.1) != Some(std::fs::metadata(&bin)?.len()) {
            self.upload(&bin, &ff, &mut |_| {}, cancel)?;
        }
        let used: Vec<String> = job.sources.iter().map(|(_, r)| r.clone()).collect();
        let cached: Vec<(String, u64)> = have
            .iter()
            .filter(|(p, _)| p.starts_with(&format!("{src}/")))
            .map(|(p, (t, _))| (p.clone(), *t))
            .collect();
        let old = stale(&cached, &used, KEEP);
        let d = quote(&job.dir);
        // Reste abgebrochener Exporte (Handy abgesteckt) nach 12 h weg; ein laufender zweiter Export bleibt
        self.shell(&format!(
            "find {w}/export -mindepth 1 -maxdepth 1 -mmin +720 -exec rm -rf {{}} + 2>/dev/null; rm -rf {d} && mkdir -p {d} {s} && chmod 755 {ff}{}",
            if old.is_empty() { String::new() } else { format!(" && rm -f {}", old.iter().map(|o| quote(o)).collect::<Vec<_>>().join(" ")) },
            w = quote(&self.work),
            s = quote(&src),
        ))?;
        let mut started = false;
        let r = self.steps(models, job, &have, progress, cancel, &mut started);
        let kill = if started && r.is_err() {
            // ffmpeg (PID aus dem Skript) und die äußere Shell von adbd; [.]: passt nicht auf diese Shell selbst
            format!(
                "kill -9 $(cat {d}/pid) 2>/dev/null; pkill -9 -f {} ; ",
                quote(&format!("{}/run[.]sh", job.dir))
            )
        } else {
            String::new()
        };
        let _ = self.shell(&format!("{kill}rm -rf {d}"));
        r
    }

    // Hochladen, Skript, Lauf, Ausgabe zurück; started: ffmpeg wurde gestartet (beim Fehler auf dem Handy beenden)
    fn steps(
        &self,
        models: &Path,
        job: &Remote,
        have: &std::collections::HashMap<String, (u64, u64)>,
        progress: Option<&mut dyn FnMut(f64)>,
        cancel: &Cancel,
        started: &mut bool,
    ) -> Result<()> {
        for (from, to) in &job.sources {
            if have.get(to).map(|h| h.1) != Some(std::fs::metadata(from)?.len()) {
                self.upload(from, to, &mut |_| {}, cancel)?;
            }
        }
        for f in &job.files {
            let to = format!(
                "{}/{}",
                job.dir,
                f.file_name().unwrap_or_default().to_string_lossy()
            );
            self.adb(&["push", &f.to_string_lossy(), &to], LONG, cancel)?;
        }
        // Skript kurz unter models (nicht /tmp: kleines tmpfs)
        let sh = models.join(format!(".phone-run-{}.sh", crate::uniq()));
        std::fs::write(&sh, script(job))?;
        let pushed = self.adb(
            &[
                "push",
                &sh.to_string_lossy(),
                &format!("{}/run.sh", job.dir),
            ],
            LONG,
            cancel,
        );
        let _ = std::fs::remove_file(&sh);
        pushed?;
        *started = true;
        self.watched(
            &format!("sh {}", quote(&format!("{}/run.sh", job.dir))),
            progress,
            cancel,
        )?;
        if let Some((remote, local)) = &job.out {
            // erst .part, dann umbenennen: ein abgebrochener Pull hinterlässt keine halbe Ausgabe
            let mut part = local.clone().into_os_string();
            part.push(".part");
            let part = PathBuf::from(part);
            let r = self.adb(&["pull", remote, &part.to_string_lossy()], LONG, cancel);
            if r.is_err() {
                let _ = std::fs::remove_file(&part);
            }
            r?;
            std::fs::rename(&part, local)?;
        }
        Ok(())
    }

    /// `adb shell cmd` mit Fortschritt aus `-progress pipe:1`; Abbruch (auch Frist von `cancel`) oder 120 s Stillstand beendet adb
    fn watched(
        &self,
        cmd: &str,
        mut progress: Option<&mut dyn FnMut(f64)>,
        cancel: &Cancel,
    ) -> Result<()> {
        let inner = Cancel::new();
        let t0 = Instant::now();
        let seen = AtomicU64::new(0);
        let done = AtomicBool::new(false);
        let why: Mutex<Option<Error>> = Mutex::new(None);
        let args: Vec<String> = ["-s", &self.serial, "shell", cmd]
            .map(String::from)
            .to_vec();
        let r = std::thread::scope(|s| {
            s.spawn(|| {
                while !done.load(Ordering::Relaxed) {
                    let quiet = t0
                        .elapsed()
                        .saturating_sub(Duration::from_millis(seen.load(Ordering::Relaxed)));
                    let e = match cancel.check() {
                        Err(e) => Some(e),
                        Ok(()) if quiet >= STALL => Some(Error::Media(
                            "ffmpeg auf dem Handy: kein Fortschritt seit 120 s".into(),
                        )),
                        Ok(()) => None,
                    };
                    if let Some(e) = e {
                        *why.lock().unwrap() = Some(e);
                        inner.cancel();
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
            let mut cb = |t: f64| {
                seen.store(t0.elapsed().as_millis() as u64, Ordering::Relaxed);
                if let Some(p) = progress.as_deref_mut() {
                    p(t)
                }
            };
            let r = ffmpeg::exec(Path::new("adb"), &args, None, Some(&mut cb), &inner);
            done.store(true, Ordering::Relaxed);
            r
        });
        let o = match r {
            Err(Error::Cancelled) => {
                return Err(why.lock().unwrap().take().unwrap_or(Error::Cancelled));
            }
            r => r?,
        };
        if o.code != Some(0) {
            return Err(Error::Media(format!(
                "ffmpeg auf dem Handy fehlgeschlagen (Code {}):\n{}",
                o.code.map_or("null".into(), |c| c.to_string()),
                tail(&o.err, 15)
            )));
        }
        Ok(())
    }
}

/// [`Runner`] für dw-video: rechnet auf dem Handy; nach dem ersten Fehler (außer Abbruch) für den Rest des Exports der PC
pub struct PhoneRunner {
    pub phone: Phone,
    pub models: PathBuf,
    fault: Mutex<Option<String>>,
}

impl PhoneRunner {
    pub fn new(phone: Phone, models: impl Into<PathBuf>) -> Self {
        Self {
            phone,
            models: models.into(),
            fault: Mutex::new(None),
        }
    }

    /// Warum das Handy ausgestiegen ist (None = nicht): letzte Zeile der Meldung, höchstens 160 Zeichen
    pub fn fault(&self) -> Option<String> {
        self.fault.lock().unwrap().clone()
    }

    /// Wer rechnet, für KI und Arbeitsansicht
    pub fn label(&self) -> String {
        match self.fault() {
            Some(f) => format!("PC (Handy-Export gescheitert: {f})"),
            None => format!("Handy ({}, CPU)", self.phone.model),
        }
    }
}

impl Runner for PhoneRunner {
    fn run_in(
        &self,
        cwd: &Path,
        args: &[String],
        mut on_progress: Option<&mut dyn FnMut(f64)>,
        cancel: &Cancel,
    ) -> Result<()> {
        if self.fault().is_none() {
            let r = match plan_remote(cwd, args, &self.phone.work) {
                Ok(job) => {
                    let reb: Option<&mut dyn FnMut(f64)> = match on_progress.as_mut() {
                        Some(p) => Some(*p),
                        None => None,
                    };
                    self.phone
                        .run_remote_ffmpeg(&self.models, &job, reb, cancel)
                }
                Err(e) => Err(e),
            };
            match r {
                Ok(()) => return Ok(()),
                // Abbruch oder Frist des Exports: kein Rückfall
                Err(_) if cancel.check().is_err() => return cancel.check(),
                Err(e) => {
                    let msg = e.to_string();
                    eprintln!(
                        "[video] Export auf dem Handy fehlgeschlagen, der PC rechnet weiter: {msg}"
                    );
                    let last = msg.trim().lines().last().unwrap_or_default();
                    *self.fault.lock().unwrap() = Some(last.chars().take(160).collect());
                }
            }
        }
        Local.run_in(cwd, args, on_progress, cancel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn plan_und_skript() {
        let root = crate::tests::dir("plan");
        let (cwd, src) = (root.join("job x"), root.join("quelle.mp4"));
        std::fs::create_dir_all(cwd.join("fonts")).unwrap();
        std::fs::write(&src, b"video").unwrap();
        std::fs::write(cwd.join("g1.ass"), b"ass").unwrap();
        std::fs::write(cwd.join("g0.mkv"), b"alt").unwrap(); // nicht genannt: bleibt auf dem PC
        std::fs::write(cwd.join("bild.png"), b"png").unwrap();
        std::fs::write(cwd.join("a"), b"kurz").unwrap(); // Teilwort in vielen Argumenten, nie genannt
        let (q, b, o) = (
            src.to_string_lossy().to_string(),
            cwd.join("bild.png").to_string_lossy().to_string(),
            cwd.join("g1.mkv").to_string_lossy().to_string(),
        );
        let args = s(&[
            "-ss",
            "0.350",
            "-i",
            &q,
            "-ss",
            "2",
            "-i",
            &q,
            "-i",
            &b,
            "-filter_complex",
            "[0:v]ass=g1.ass:fontsdir=fonts[v]",
            "-map",
            "[v]",
            &o,
        ]);
        let r = plan_remote(&cwd, &args, "/w").unwrap();
        assert_eq!(r.dir, "/w/export/job x");
        assert_eq!(r.sources.len(), 1, "gleiche Quelle nur einmal");
        let cache = &r.sources[0].1;
        assert!(
            cache.starts_with("/w/src/")
                && cache.ends_with(".mp4")
                && cache.len() == "/w/src/".len() + 40 + 4,
            "{cache}"
        );
        assert_eq!(r.args[3], *cache);
        assert_eq!(r.args[7], *cache);
        assert_eq!(r.args[9], "/w/export/job x/bild.png");
        assert_eq!(r.args[11], "[0:v]ass=g1.ass:fontsdir=fonts[v]");
        assert_eq!(r.args.last().unwrap(), "/w/export/job x/g1.mkv");
        assert_eq!(
            r.out,
            Some(("/w/export/job x/g1.mkv".into(), cwd.join("g1.mkv")))
        );
        assert_eq!(
            r.files,
            vec![cwd.join("bild.png"), cwd.join("fonts"), cwd.join("g1.ass")]
        );
        // gleiche Datei, neue Größe → neuer Cache-Name
        std::fs::write(&src, b"video2").unwrap();
        assert_ne!(plan_remote(&cwd, &args, "/w").unwrap().sources[0].1, *cache);

        let sh = script(&r);
        assert!(sh.starts_with(&format!("echo $$ > '/w/export/job x/pid' && touch '{cache}' && cd '/w/export/job x' && exec /data/local/tmp/deckwerk/ffmpeg -hide_banner -nostdin -y -nostats -progress pipe:1 '-ss' '0.350' '-i' ")), "{sh}");
        assert!(sh.ends_with("'/w/export/job x/g1.mkv'\n"));

        // Messlauf ohne Ausgabedatei
        let m = plan_remote(&cwd, &s(&["-i", &q, "-f", "null", "-"]), "/w").unwrap();
        assert_eq!(m.out, None);
        // Ziel außerhalb von cwd landet im Export-Ordner
        let x = plan_remote(
            &cwd,
            &s(&["-i", &q, &root.join("raus.mp4").to_string_lossy()]),
            "/w",
        )
        .unwrap();
        assert_eq!(x.out.unwrap().0, "/w/export/job x/raus.mp4");
    }

    #[test]
    fn langer_filtergraph_im_skript() {
        // > 64 KB Befehl: geht als Datei aufs Handy, die Kommandozeile von adb shell bleibt kurz
        let r = Remote {
            dir: "/w/export/a".into(),
            args: vec!["-filter_complex".into(), "x".repeat(100_000)],
            sources: vec![],
            files: vec![],
            out: None,
        };
        assert!(script(&r).len() > 100_000);
        assert!(format!("sh {}", quote(&format!("{}/run.sh", r.dir))).len() < 100);
    }

    #[test]
    fn cache_aufraeumen() {
        let c: Vec<(String, u64)> = [("a", 1), ("b", 3), ("c", 2), ("d", 4)]
            .iter()
            .map(|(p, t)| (p.to_string(), *t))
            .collect();
        // gebraucht d; behalten bis zusammen 2: dazu der neueste übrige (b)
        assert_eq!(
            stale(&c, &["d".into()], 2),
            vec!["c".to_string(), "a".into()]
        );
        assert_eq!(stale(&c, &["x".into(), "y".into(), "z".into()], 2).len(), 4);
        assert!(stale(&c, &[], 4).is_empty());
    }

    #[test]
    fn rueckfall_auf_den_pc() {
        // ohne Gerät (falsche Seriennummer oder kein adb): der PC rechnet, Grund steht im Label, danach kein zweiter Versuch
        if ffmpeg::ffmpeg_bin().is_err() {
            eprintln!("übersprungen: kein ffmpeg");
            return;
        }
        let d = crate::tests::dir("rueckfall");
        let run = PhoneRunner::new(
            Phone::new("gibt-es-nicht", "Testhandy", "arm64-v8a"),
            d.join("models"),
        );
        assert_eq!(run.label(), "Handy (Testhandy, CPU)");
        let out = d.join("a.mkv");
        let args = s(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=64x64:rate=10:duration=1",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            &out.to_string_lossy(),
        ]);
        let mut last = 0.0;
        let mut cb = |t: f64| last = t;
        run.run_in(&d, &args, Some(&mut cb), &Cancel::new())
            .unwrap();
        assert!(out.exists());
        assert!(last > 0.0, "Fortschritt vom PC");
        let l = run.label();
        assert!(
            l.starts_with("PC (Handy-Export gescheitert: ") && l.len() < 220,
            "{l}"
        );
        assert!(
            !d.join("models").exists(),
            "ohne Handy kein Download des Handy-ffmpeg"
        );
        // falsche Architektur: gar nicht erst versuchen
        let x86 = PhoneRunner::new(Phone::new("x", "Alt", "armeabi-v7a"), d.join("models"));
        std::fs::remove_file(&out).unwrap();
        x86.run_in(&d, &args, None, &Cancel::new()).unwrap();
        assert!(out.exists());
        assert!(x86.fault().unwrap().contains("nur arm64-v8a"));
        // Abbruch fällt nicht auf den PC zurück
        let c = Cancel::new();
        c.cancel();
        let fresh = PhoneRunner::new(
            Phone::new("gibt-es-nicht", "T", "arm64-v8a"),
            d.join("models"),
        );
        assert!(matches!(
            fresh.run_in(&d, &args, None, &c),
            Err(Error::Cancelled)
        ));
    }
}
