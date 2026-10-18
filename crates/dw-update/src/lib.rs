//! Selbst-Update (Port von update.ts, RUST-REWRITE.md §7.1 S6): statt `curl … | sh` ein signiertes
//! Release-Manifest (Version, Adresse, SHA-256) prüfen, das Artefakt laden, die Prüfsumme vergleichen
//! und erst dann atomar austauschen. Keine Shell.

use sha2::{Digest, Sha256};
use std::path::Path;

const BASE: &str = "https://github.com/Bavarianator/deckwerk/releases/latest/download";
/// Öffentlicher ed25519-Schlüssel der Release-Signatur.
// ponytail: Platzhalter, bis die Release-CI signiert; mit Nullen scheitert jede Prüfung (sicher), echten Schlüssel eintragen
const PUBKEY: [u8; 32] = [0; 32];

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Net(#[from] dw_net::Error),
    #[error("Signatur des Release-Manifests ungültig")]
    Signature,
    #[error("Prüfsumme des Downloads stimmt nicht")]
    Checksum,
    #[error("Manifest unlesbar: {0}")]
    Manifest(#[from] serde_json::Error),
    #[error("Installieren fehlgeschlagen: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub sha256: String,
}

/// Nur über `download` zu bekommen: Inhalt mit geprüfter Prüfsumme.
pub struct Verified(Vec<u8>);

/// Ist b neuer als a? Vergleicht die Zahlen von „0.1.6“ bzw. „v0.1.7“.
pub fn is_newer(a: &str, b: &str) -> bool {
    let n = |v: &str| -> Vec<u64> { v.trim_start_matches('v').split('.').map(|x| x.parse().unwrap_or(0)).collect() };
    let (x, y) = (n(a), n(b));
    (0..x.len().max(y.len()))
        .map(|i| (y.get(i).copied().unwrap_or(0), x.get(i).copied().unwrap_or(0)))
        .find(|(b, a)| b != a)
        .is_some_and(|(b, a)| b > a)
}

/// Manifest nur mit gültiger Signatur annehmen.
pub fn parse_manifest(manifest: &[u8], sig: &[u8], key: &[u8; 32]) -> Result<Release, Error> {
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(manifest, sig)
        .map_err(|_| Error::Signature)?;
    Ok(serde_json::from_slice(manifest)?)
}

/// Neuester Release, wenn neuer als `current`.
pub async fn check(current: &str) -> Result<Option<Release>, Error> {
    let lim = dw_net::Limits { max_bytes: 64 << 10, ..Default::default() };
    let m = dw_net::get(&format!("{BASE}/manifest.json"), lim).await?;
    let s = dw_net::get(&format!("{BASE}/manifest.json.sig"), lim).await?;
    let r = parse_manifest(&m, &s, &PUBKEY)?;
    Ok(is_newer(current, &r.version).then_some(r))
}

pub fn verify(r: &Release, bytes: Vec<u8>) -> Result<Verified, Error> {
    let hex: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if hex != r.sha256.to_ascii_lowercase() {
        return Err(Error::Checksum);
    }
    Ok(Verified(bytes))
}

pub async fn download(r: &Release) -> Result<Verified, Error> {
    let lim = dw_net::Limits { max_bytes: 1 << 30, timeout: std::time::Duration::from_secs(600) };
    verify(r, dw_net::get(&r.url, lim).await?)
}

/// Ersetzt `target` (die ausführbare Datei, etwa `std::env::current_exe()`) atomar durch den geprüften Inhalt.
// ponytail: Artefakt = eine ausführbare Datei, nur Unix-Rechte; Archiv/Windows (laufende .exe umbenennen) bei Bedarf
pub fn install(v: Verified, target: &Path) -> Result<(), Error> {
    let tmp = target.with_extension("update");
    std::fs::write(&tmp, &v.0)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versionen() {
        assert!(is_newer("0.1.6", "v0.1.7"));
        assert!(is_newer("0.1.9", "0.1.10"));
        assert!(is_newer("0.1", "0.1.1"));
        assert!(!is_newer("0.2.0", "0.1.9"));
        assert!(!is_newer("v1.0.0", "1.0"));
    }

    #[test]
    fn falsche_pruefsumme_wird_abgelehnt() {
        let ok = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"; // sha256("hello")
        let r = Release { version: "9".into(), url: String::new(), sha256: ok.into() };
        assert!(verify(&r, b"hello".to_vec()).is_ok());
        assert!(matches!(verify(&r, b"hellp".to_vec()), Err(Error::Checksum)));
    }

    #[test]
    fn falsche_signatur_wird_abgelehnt() {
        use ring::signature::{Ed25519KeyPair, KeyPair};
        let pk = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
        let kp = Ed25519KeyPair::from_pkcs8(pk.as_ref()).unwrap();
        let key: [u8; 32] = kp.public_key().as_ref().try_into().unwrap();
        let m = br#"{"version":"9","url":"x","sha256":"00"}"#;
        let sig = kp.sign(m);
        assert_eq!(parse_manifest(m, sig.as_ref(), &key).unwrap().version, "9");
        let boese = br#"{"version":"9","url":"y","sha256":"00"}"#;
        assert!(matches!(parse_manifest(boese, sig.as_ref(), &key), Err(Error::Signature)));
        assert!(matches!(parse_manifest(m, sig.as_ref(), &PUBKEY), Err(Error::Signature)));
    }
}
