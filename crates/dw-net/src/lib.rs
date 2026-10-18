//! Netz von Deckwerk: ein HTTP-Client, eine SSRF-Prüfung. Ersetzt die drei Regex-Sperren aus
//! tools.ts (:1534), music.ts (:59) und das Laden in download.ts. Geprüft wird die Adresse (check_url)
//! und jede per DNS aufgelöste IP (Resolver), damit ein öffentlicher Name nicht auf 127.0.0.1 zeigen kann;
//! Weiterleitungen folgen wir selbst und prüfen jeden Schritt neu.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

pub use reqwest::Url;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Adresse ungültig: {0}")]
    BadUrl(String),
    #[error("Adressen im eigenen Netz sind gesperrt: {0}")]
    Blocked(String),
    #[error("Zu viele Weiterleitungen")]
    Redirects,
    #[error("Antwort zu groß (höchstens {0} Bytes)")]
    TooLarge(u64),
    #[error("Zeitüberschreitung")]
    Timeout,
    #[error("Abruf fehlgeschlagen ({0})")]
    Status(u16),
    #[error("Netzfehler: {0}")]
    Http(#[from] reqwest::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_bytes: u64,
    /// Gesamtzeit über alle Weiterleitungen
    pub timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_bytes: 20 << 20, timeout: Duration::from_secs(30) }
    }
}

const MAX_HOPS: usize = 5;

/// Nur http(s) ohne Zugangsdaten, kein Name und keine IP aus dem eigenen Netz.
pub fn check_url(url: &Url) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Error::BadUrl(format!("nur http/https, nicht {}", url.scheme())));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Error::BadUrl("Zugangsdaten in der Adresse".into()));
    }
    let blocked = || Err(Error::Blocked(url.host_str().unwrap_or("").into()));
    match url.host() {
        None => Err(Error::BadUrl("ohne Host".into())),
        Some(url::Host::Ipv4(ip)) if !public_ip(IpAddr::V4(ip)) => blocked(),
        Some(url::Host::Ipv6(ip)) if !public_ip(IpAddr::V6(ip)) => blocked(),
        Some(url::Host::Domain(d)) => {
            // Punkt am Ende („localhost.“) ist derselbe Name
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            let local = ["localhost", "local", "internal", "home.arpa"]
                .iter()
                .any(|s| d == *s || d.ends_with(&format!(".{s}")));
            if local || d.is_empty() || !d.contains('.') { blocked() } else { Ok(()) }
        }
        _ => Ok(()),
    }
}

/// true nur für öffentlich routbare Adressen. Bei Sicherheit lieber eine Sperre zu viel.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => {
            // ::ffff:a.b.c.d (gemappt) und ::a.b.c.d (kompatibel) wie IPv4 behandeln
            if let Some(v4) = v6.to_ipv4() {
                return public_v4(v4); // :: und ::1 landen in 0.0.0.0/8
            }
            let s = v6.segments();
            // 64:ff9b::/96 (NAT64) und 2002::/16 (6to4) tragen eine IPv4 in sich
            if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4] {
                return public_v4(Ipv4Addr::from(((s[6] as u32) << 16) | s[7] as u32));
            }
            if s[0] == 0x2002 {
                return public_v4(Ipv4Addr::from(((s[1] as u32) << 16) | s[2] as u32));
            }
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (s[0] & 0xffc0) == 0xfec0 // site-local fec0::/10 (veraltet)
                || (s[0] == 0x2001 && s[1] == 0x0db8) // Dokumentation
                || s[0] == 0x0100 && s[1..4] == [0; 3]) // Discard 100::/64
        }
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0 // 0.0.0.0/8, unter Linux = localhost
        || a == 10
        || a == 127
        || (a == 100 && (b & 0xc0) == 64) // CGNAT 100.64/10 (Tailscale & Co.)
        || (a == 169 && b == 254)
        || (a == 172 && (b & 0xf0) == 16)
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0) // IETF 192.0.0/24
        || (a == 198 && (b & 0xfe) == 18) // Benchmark 198.18/15
        || a >= 224) // Multicast, reserviert, Broadcast
}

/// Löst Namen auf und verwirft das Ziel, wenn eine der IPs nicht öffentlich ist (gegen DNS-Rebinding).
struct PublicResolver;

impl reqwest::dns::Resolve for PublicResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if addrs.is_empty() || addrs.iter().any(|a| !public_ip(a.ip())) {
                return Err(Box::new(Error::Blocked(host)) as _);
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Lädt eine öffentliche Adresse vollständig in den Speicher, mit Größen- und Zeitlimit.
pub async fn get(url: &str, limits: Limits) -> Result<Vec<u8>> {
    tokio::time::timeout(limits.timeout, fetch(url, limits.max_bytes)).await.map_err(|_| Error::Timeout)?
}

async fn fetch(url: &str, max: u64) -> Result<Vec<u8>> {
    // rustls ohne Vorgabe: ring einmal je Prozess setzen (zweiter Aufruf scheitert harmlos)
    let _ = rustls::crypto::ring::default_provider().install_default();
    // ponytail: Client je Aufruf, teilen, sobald viele Abrufe hintereinander laufen
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy() // ein Proxy löste den Namen selbst auf, am Resolver vorbei
        .dns_resolver(std::sync::Arc::new(PublicResolver))
        .build()?;
    let mut url = Url::parse(url).map_err(|e| Error::BadUrl(e.to_string()))?;
    for _ in 0..=MAX_HOPS {
        check_url(&url)?;
        let mut res = client.get(url.clone()).send().await?;
        if res.status().is_redirection() {
            let loc = res.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok());
            let loc = loc.ok_or(Error::Status(res.status().as_u16()))?;
            url = url.join(loc).map_err(|e| Error::BadUrl(e.to_string()))?;
            continue;
        }
        if !res.status().is_success() {
            return Err(Error::Status(res.status().as_u16()));
        }
        if res.content_length().is_some_and(|n| n > max) {
            return Err(Error::TooLarge(max));
        }
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await? {
            body.extend_from_slice(&chunk);
            if body.len() as u64 > max {
                return Err(Error::TooLarge(max));
            }
        }
        return Ok(body);
    }
    Err(Error::Redirects)
}
