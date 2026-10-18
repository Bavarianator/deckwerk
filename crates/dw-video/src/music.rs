//! Freie Musik über Openverse (`main/music.ts`): die reinen Teile (Endung, Lizenz- und Längenfilter, Track aus dem Treffer).
//! Suche und Download gehören nach dw-net (eine SSRF-Prüfung statt drei, Plan §5.1).

use serde::{Deserialize, Serialize};

pub const AUDIO_EXT: [&str; 8] = ["mp3", "wav", "m4a", "ogg", "oga", "aac", "opus", "flac"];
const MIN_SECONDS: f64 = 30.0;

/// Nur Lizenzen, die Musik unter Video erlauben (kein ND/SA/NC)
pub fn license_name(l: &str) -> Option<&'static str> {
    Some(match l {
        "cc0" => "CC0",
        "pdm" => "Public Domain Mark",
        "by" => "CC BY",
        _ => return None,
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
}

/// Treffer der Openverse-API
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Hit {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub filetype: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub foreign_landing_url: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<Tag>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    /// s, 0 = unbekannt
    pub duration: f64,
    pub license: String,
    pub tags: Vec<String>,
    pub url: String,
}

/// Endung der Audiodatei (Jamendo „mp32“ = mp3, sonst aus dem URL-Pfad); nur bekannte Audio-Endungen
pub fn ext_of(h: &Hit) -> Option<String> {
    let mut e = h.filetype.clone().unwrap_or_default().to_lowercase();
    if e.len() == 4 && e.starts_with("mp3") && e.as_bytes()[3].is_ascii_digit() {
        e = "mp3".into();
    }
    if e.is_empty() {
        // ponytail: Pfad ohne vollen URL-Parser (Query/Fragment abgeschnitten); ungültige URL → keine Endung
        let u = h.url.as_deref().unwrap_or("");
        let rest = u.split_once("://")?.1;
        let path = rest.find('/').map_or("", |i| &rest[i..]);
        let path = path.split(['?', '#']).next().unwrap_or("");
        let (_, x) = path.rsplit_once('.')?;
        if !(2..=5).contains(&x.len()) || !x.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return None;
        }
        e = x.to_lowercase();
    }
    AUDIO_EXT.contains(&e.as_str()).then_some(e)
}

/// Lizenz frei genug, https, bekannte Endung, Länge passt (kurz = Soundeffekte unter 30 s)
pub fn usable(h: &Hit, kurz: bool) -> bool {
    let sec = h.duration.unwrap_or(0.0) / 1000.0;
    license_name(&h.license).is_some()
        && h.url.as_deref().is_some_and(|u| u.starts_with("https://"))
        && ext_of(h).is_some()
        && (sec == 0.0
            || if kurz {
                sec < MIN_SECONDS
            } else {
                sec >= MIN_SECONDS
            })
}

pub fn track(h: &Hit) -> Track {
    let nz = |s: &Option<String>, d: &str| {
        s.clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| d.into())
    };
    Track {
        id: h.id.clone(),
        title: nz(&h.title, "Ohne Titel"),
        artist: nz(&h.creator, "unbekannt"),
        duration: crate::round(h.duration.unwrap_or(0.0) / 1000.0),
        license: h.license.clone(),
        tags: h
            .tags
            .iter()
            .flatten()
            .take(8)
            .map(|t| t.name.clone())
            .collect(),
        url: h
            .foreign_landing_url
            .clone()
            .unwrap_or_else(|| format!("https://openverse.org/audio/{}", h.id)),
    }
}
