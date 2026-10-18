//! Programme fürs Handy einmal nach `<models>/android` laden (nicht /tmp: oft ein kleines RAM-Dateisystem), alles mit Prüfsumme.
//! Download per curl, Entpacken per tar wie in der App.

use dw_video::ffmpeg::{Error, Result};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// sherpa-onnx für Termux (läuft auch per adb shell), fester Release + Prüfsumme. Es braucht libc++_shared.so, die weder dieses
// noch das App-Paket von sherpa mitbringt: die kommt aus Termux (Pfad und Prüfsumme aus dessen Paketindex, der Pfad wechselt
// mit jeder Version).
const TOP: &str = "sherpa-onnx-v1.13.8-android-aarch64-termux-shared";
const SHERPA_SHA: &str = "ad7bac42adc6295293fe6d36475936afb227cdc757cf293c02a706f6aca4e0a2";
const LIBS: [&str; 3] = [
    "libsherpa-onnx-c-api.so",
    "libsherpa-onnx-cxx-api.so",
    "libonnxruntime.so",
];
const TERMUX: &str = "https://packages.termux.dev/apt/termux-main/";
/// Erkennung samt Bibliotheken (die Sprecherstimme sherpa-onnx-offline-tts ist nicht portiert)
pub(crate) const BUNDLE: [&str; 5] = [
    "sherpa-onnx-offline",
    "libsherpa-onnx-c-api.so",
    "libsherpa-onnx-cxx-api.so",
    "libonnxruntime.so",
    "libc++_shared.so",
];

// mwader/static-ffmpeg 9.0.2-1 (linux/arm64, mit libass und libx264) direkt aus Docker Hub, ohne Docker: die eine Schicht per Digest
// (= SHA-256 des gzip-Tars), darin liegt ffmpeg im Wurzelverzeichnis
const REPO: &str = "mwader/static-ffmpeg";
const LAYER: &str = "b97d6d5fc8d13dca24a7b71a33f28a32836db81b22673edb4beb6020b10a0272";
const BIN_SHA: &str = "fd63f670fb1ad8a9ce069bbdf01ffcba5de9b3a33531c220df139b3c1a8f7b0a";

/// Ein Eintrag (Namensanfang) aus einem ar-Archiv, z. B. data.tar.xz aus einer .deb
pub fn ar_member<'a>(buf: &'a [u8], prefix: &str) -> Option<&'a [u8]> {
    let mut o = 8;
    while o + 60 <= buf.len() {
        let name = String::from_utf8_lossy(&buf[o..o + 16]);
        let size: usize = String::from_utf8_lossy(&buf[o + 48..o + 58])
            .trim()
            .parse()
            .ok()?;
        if name.trim().starts_with(prefix) {
            return buf.get(o + 60..o + 60 + size);
        }
        o += 60 + size + size % 2;
    }
    None
}

/// Pfad und SHA-256 des Pakets libc++ aus dem Termux-Paketindex
pub fn termux_libcxx(index: &str) -> Option<(String, String)> {
    let e = index
        .split("\n\n")
        .find(|e| e.lines().any(|l| l == "Package: libc++"))?;
    let field = |k: &str| {
        e.lines()
            .find_map(|l| l.strip_prefix(k))
            .map(|v| v.trim().to_string())
    };
    Some((field("Filename: ")?, field("SHA256: ")?))
}

fn sha256(p: &Path) -> Result<String> {
    let (mut f, mut h, mut buf) = (std::fs::File::open(p)?, Sha256::new(), vec![0u8; 1 << 20]);
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn tool(cmd: &mut Command, what: &str) -> Result<Vec<u8>> {
    let o = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Error::Missing(format!("{what}: {e}")))?;
    if !o.status.success() {
        return Err(Error::Media(format!(
            "{what} fehlgeschlagen: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        )));
    }
    Ok(o.stdout)
}

fn curl(url: &str, header: Option<&str>) -> Command {
    let mut c = Command::new("curl");
    c.args(["-fsSL", "--retry", "2", "--connect-timeout", "30"]);
    if let Some(h) = header {
        c.args(["-H", h]);
    }
    c.arg(url);
    c
}

/// Herunterladen nach `to`, nur mit passender Prüfsumme
fn download(url: &str, sha: &str, to: &Path, header: Option<&str>) -> Result<()> {
    tool(curl(url, header).arg("-o").arg(to), "Download")?;
    if sha256(to)? != sha {
        let _ = std::fs::remove_file(to);
        return Err(Error::Media(format!(
            "Download {url} beschädigt (Prüfsumme stimmt nicht). Bitte noch einmal versuchen."
        )));
    }
    Ok(())
}

/// Arbeitsordner unter models, beim Verlassen weg
struct Tmp(PathBuf);
impl Tmp {
    fn new(models: &Path) -> Result<Self> {
        let d = models.join(format!(".android-{}", crate::uniq()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d)?;
        Ok(Self(d))
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tar(archive: &Path, dir: &Path, members: &[String]) -> Result<()> {
    tool(
        Command::new("tar")
            .arg("-xf")
            .arg(archive)
            .arg("-C")
            .arg(dir)
            .args(members),
        "Entpacken",
    )
    .map(drop)
}

/// sherpa-onnx-offline, Bibliotheken und libc++ in `<models>/android`
pub(crate) fn bundle(models: &Path) -> Result<PathBuf> {
    let dir = models.join("android");
    if BUNDLE.iter().all(|f| dir.join(f).exists()) {
        return Ok(dir);
    }
    std::fs::create_dir_all(&dir)?;
    let tmp = Tmp::new(models)?;
    let t = &tmp.0;
    download(
        &format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/{TOP}.tar.bz2"),
        SHERPA_SHA,
        &t.join("sherpa.tar.bz2"),
        None,
    )?;
    let mut from: Vec<String> = std::iter::once(format!("{TOP}/bin/sherpa-onnx-offline"))
        .chain(LIBS.iter().map(|l| format!("{TOP}/lib/{l}")))
        .collect();
    tar(&t.join("sherpa.tar.bz2"), t, &from)?;
    // libc++ nur, wenn sie fehlt: ein vorhandenes Bundle behält seine (der Termux-Index hat inzwischen evtl. eine neuere)
    if !dir.join("libc++_shared.so").exists() {
        let index = tool(
            &mut curl(
                &format!("{TERMUX}dists/stable/main/binary-aarch64/Packages"),
                None,
            ),
            "Termux-Paketindex",
        )?;
        let (deb, sha) = termux_libcxx(&String::from_utf8_lossy(&index))
            .ok_or_else(|| Error::Media("libc++ nicht im Termux-Paketindex gefunden".into()))?;
        download(&format!("{TERMUX}{deb}"), &sha, &t.join("libcxx.deb"), None)?;
        let buf = std::fs::read(t.join("libcxx.deb"))?;
        let data = ar_member(&buf, "data.tar")
            .ok_or_else(|| Error::Media("data.tar fehlt im Archiv".into()))?;
        std::fs::write(t.join("data.tar.xz"), data)?;
        let so = "./data/data/com.termux/files/usr/lib/libc++_shared.so".to_string();
        tar(&t.join("data.tar.xz"), t, std::slice::from_ref(&so))?;
        from.push(so);
    }
    for f in &from {
        let p = t.join(f);
        std::fs::rename(&p, dir.join(p.file_name().unwrap()))?;
    }
    Ok(dir)
}

/// Statisches ffmpeg (arm64) in `<models>/android/ffmpeg`
pub(crate) fn ffmpeg_binary(models: &Path) -> Result<PathBuf> {
    let file = models.join("android").join("ffmpeg");
    if file.exists() {
        return Ok(file);
    }
    std::fs::create_dir_all(models.join("android"))?;
    let tmp = Tmp::new(models)?;
    let t = &tmp.0;
    let token = tool(
        &mut curl(
            &format!(
                "https://auth.docker.io/token?service=registry.docker.io&scope=repository:{REPO}:pull"
            ),
            None,
        ),
        "ffmpeg fürs Handy: Docker Hub",
    )?;
    let token = serde_json::from_slice::<serde_json::Value>(&token)
        .ok()
        .and_then(|v| v["token"].as_str().map(String::from))
        .ok_or_else(|| Error::Media("ffmpeg fürs Handy: Docker Hub liefert keinen Token".into()))?;
    download(
        &format!("https://registry-1.docker.io/v2/{REPO}/blobs/sha256:{LAYER}"),
        LAYER,
        &t.join("layer.tar.gz"),
        Some(&format!("Authorization: Bearer {token}")),
    )?;
    tar(&t.join("layer.tar.gz"), t, &["ffmpeg".into()])?;
    if sha256(&t.join("ffmpeg"))? != BIN_SHA {
        return Err(Error::Media(
            "ffmpeg fürs Handy beschädigt (Prüfsumme stimmt nicht). Bitte noch einmal versuchen."
                .into(),
        ));
    }
    std::fs::rename(t.join("ffmpeg"), &file)?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ar_entry(name: &str, data: &[u8]) -> Vec<u8> {
        let mut h = format!(
            "{name:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`\n",
            0,
            0,
            0,
            644,
            data.len()
        )
        .into_bytes();
        h.extend_from_slice(data);
        if data.len() % 2 == 1 {
            h.push(b'\n');
        }
        h
    }

    #[test]
    fn ar_archiv() {
        let mut a = b"!<arch>\n".to_vec();
        a.extend(ar_entry("debian-binary", b"2.0\n"));
        a.extend(ar_entry("control.tar.xz", b"abc"));
        a.extend(ar_entry("data.tar.xz", b"DATEN"));
        assert_eq!(ar_member(&a, "data.tar"), Some(&b"DATEN"[..]));
        assert_eq!(ar_member(&a, "control"), Some(&b"abc"[..]));
        assert_eq!(ar_member(&a, "fehlt"), None);
    }

    #[test]
    fn termux_index() {
        let idx = "Package: libc++abi\nFilename: pool/x/abi.deb\nSHA256: 11\n\nPackage: libc++\nVersion: 28\nFilename: pool/main/libc/libc++/libc++_28_aarch64.deb\nSHA256: abcd\n\nPackage: z\n";
        assert_eq!(
            termux_libcxx(idx),
            Some((
                "pool/main/libc/libc++/libc++_28_aarch64.deb".into(),
                "abcd".into()
            ))
        );
        assert_eq!(termux_libcxx("Package: x\n"), None);
    }

    #[test]
    fn pruefsumme() {
        let d = crate::tests::dir("sha");
        std::fs::write(d.join("x"), b"abc").unwrap();
        assert_eq!(
            sha256(&d.join("x")).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
