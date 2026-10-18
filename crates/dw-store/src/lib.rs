//! Ablage von Deckwerk: Edition, Datenordner, Decks (Laden mit Prüfung, atomares Speichern, Versionen),
//! Assets, brand.json, hausstil.md, zuletzt geöffnete Decks. Ersetzt die verstreuten Teile aus
//! ipc.ts, mcp.ts, engine.ts, tools.ts und shared/app-id.ts; jeder Weg (App, MCP, CLI) geht hier durch.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dw_model::{BrandKit, Color, Deck};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}: {1}")]
    Io(PathBuf, std::io::Error),
    #[error("{0} liegt außerhalb des Datenordners")]
    Outside(PathBuf),
    #[error("{0} ist zu groß ({1} Bytes, höchstens {2})")]
    TooLarge(PathBuf, u64, u64),
    #[error("{0}: keine gültige deck.json: {1}")]
    Invalid(PathBuf, String),
    #[error("Dateityp nicht erlaubt: {0}")]
    MediaType(String),
    #[error("kein Datenordner: weder DECKWERK_HOME noch HOME gesetzt")]
    NoHome,
    #[error("{0} ist keine deck.json eines Deck-Ordners")]
    NotDeck(PathBuf),
}

pub type Result<T> = std::result::Result<T, Error>;

fn io<T>(p: &Path, r: std::io::Result<T>) -> Result<T> {
    r.map_err(|e| Error::Io(p.to_path_buf(), e))
}

/// Edition (shared/app-id.ts). Die ID ist zugleich appData-Ordner, MCP-Servername und Skill-Name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edition {
    Deckwerk,
    Pro,
}

impl Edition {
    /// DW_EDITION=pro wie app-id.ts, sonst Basis
    pub fn from_env() -> Self {
        match std::env::var("DW_EDITION").as_deref() {
            Ok("pro") => Edition::Pro,
            _ => Edition::Deckwerk,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Edition::Deckwerk => "Deckwerk",
            Edition::Pro => "Deckwerk Pro",
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Edition::Deckwerk => "deckwerk",
            Edition::Pro => "deckwerk-pro",
        }
    }
    /// Ordnername unter ~
    pub fn home(self) -> &'static str {
        match self {
            Edition::Deckwerk => "Deckwerk",
            Edition::Pro => "DeckwerkPro",
        }
    }
    pub fn repo(self) -> &'static str {
        match self {
            Edition::Deckwerk => "Bavarianator/deckwerk",
            Edition::Pro => "Bavarianator/deckwerk-pro",
        }
    }
    /// Link-Schema <scheme>://
    pub fn scheme(self) -> &'static str {
        self.id()
    }
}

/// Plattformpfade (Electron app.getPath('home'/'appData')).
pub mod platform {
    use std::path::PathBuf;

    pub fn home_dir() -> Option<PathBuf> {
        std::env::home_dir()
    }

    #[cfg(target_os = "macos")]
    pub fn app_data_dir() -> Option<PathBuf> {
        home_dir().map(|h| h.join("Library/Application Support"))
    }

    #[cfg(target_os = "windows")]
    pub fn app_data_dir() -> Option<PathBuf> {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn app_data_dir() -> Option<PathBuf> {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| home_dir().map(|h| h.join(".config")))
    }
}

/// Eine deck.json größer als das ist kein Deck mehr (Bilder liegen als Dateien daneben).
pub const DECK_MAX: u64 = 20 << 20;
/// Bilder und Schriften (§7.1 S12); Video und Audio sind unbegrenzt, gehen aber per Stream (`import_asset`).
pub const IMAGE_MAX: u64 = 50 << 20;
const STYLE_MAX: usize = 64 << 10;
const SLIDES_MAX: usize = 1000;
/// Foliengröße in px: Grenzen von ST_SlideSizeCoordinate (dw-pptx), sonst scheitert spätestens der Export
const SIZE_PX: std::ops::RangeInclusive<f64> = 96.0..=5376.0;

pub const VERSION_EVERY: Duration = Duration::from_secs(600);
pub const VERSION_MAX: usize = 100;

/// Ordnername aus dem Decktitel: Kleinbuchstaben, Läufe aus Nicht-Buchstaben/-Ziffern → „-“, höchstens 60 Zeichen.
///
/// Übernommen von ipc.ts/mcp.ts `freeDir`, weil daraus die Ordner im Datenordner (und damit im Sync) entstehen.
/// Abweichungen von den übrigen Varianten:
/// - engine.ts (Exportnamen) und dw-cli schreiben ä→ae usw. und lassen nur a–z/0–9 übrig; hier bleiben Umlaute und
///   andere Schriften erhalten („Größe“ → „größe“ statt „groesse“). Exportdateien heißen damit künftig wie der Ordner.
/// - JS zählt beim Kürzen UTF-16-Einheiten, hier Zeichen; ein Bindestrich am Schnitt wird zusätzlich entfernt.
/// - `char::is_alphanumeric` statt `\p{L}\p{N}`: deckt zusätzlich wenige Alphabetic-Zeichen ohne L (z. B. Ⅻ) ab.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let cut: String = out.chars().take(60).collect();
    let s = cut.trim_end_matches('-');
    if s.is_empty() {
        "deck".into()
    } else if is_reserved(s) {
        format!("{s}-deck") // Windows lehnt con, nul, com1 … als Ordnernamen ab (Sync auf andere Geräte)
    } else {
        s.into()
    }
}

fn is_reserved(s: &str) -> bool {
    // assets/versions/out/models sind Ordner des Datenordners (deck_path/export_dir lehnen sie ab)
    matches!(s, "con" | "prn" | "aux" | "nul" | "assets" | "versions" | "out" | "models")
        || (s.len() == 4
            && (s.starts_with("com") || s.starts_with("lpt"))
            && s.as_bytes()[3].is_ascii_digit())
}

/// Dateiname für Exporte wie engine.ts `slug` und dw-cli: ä→ae, ö→oe, ü→ue, ß→ss, sonst nur a–z/0–9.
/// Exportdateien wandern per Mail und auf fremde Systeme, deshalb ASCII; Ordnernamen (`slug`) behalten Umlaute.
pub fn file_slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.to_lowercase().chars() {
        match c {
            'ä' => out.push_str("ae"),
            'ö' => out.push_str("oe"),
            'ü' => out.push_str("ue"),
            'ß' => out.push_str("ss"),
            'a'..='z' | '0'..='9' => out.push(c),
            _ if !out.ends_with('-') => out.push('-'),
            _ => {}
        }
    }
    let t = out.trim_matches('-');
    if t.is_empty() {
        "deck".into()
    } else {
        t.into()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
    Audio,
    Font,
}

/// MEDIA_EXT aus shared/deck.ts; .ts (MPEG-TS) bewusst nicht.
pub fn media_kind(p: &Path) -> Option<MediaKind> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp" => MediaKind::Image,
        "mp4" | "webm" | "mov" | "m4v" | "mkv" | "ogv" | "flv" => MediaKind::Video,
        "mp3" | "wav" | "m4a" | "ogg" | "oga" | "aac" | "opus" | "flac" => MediaKind::Audio,
        "ttf" | "otf" | "woff" | "woff2" => MediaKind::Font,
        _ => return None,
    })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%'
            && let (Some(h), Some(l)) = (
                b.get(i + 1).and_then(|&c| hex(c)),
                b.get(i + 2).and_then(|&c| hex(c)),
            )
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Eindeutige Punktdatei neben `file`, exklusiv angelegt (folgt keinem vorhandenen Symlink).
fn part_file(file: &Path) -> Result<(PathBuf, std::fs::File)> {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = file.parent().unwrap_or(Path::new("."));
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("datei");
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let part = dir.join(format!(".{name}.{}-{n}.part", std::process::id()));
    let f = io(
        &part,
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part),
    )?;
    Ok((part, f))
}

/// Punktdatei → fsync → rename → fsync des Ordners. rename ersetzt einen Symlink am Ziel, statt ihm zu folgen.
fn finish_part(part: &Path, file: &Path, r: std::io::Result<()>) -> Result<()> {
    let r = r.and_then(|_| std::fs::rename(part, file));
    if r.is_err() {
        let _ = std::fs::remove_file(part);
    }
    io(file, r)?;
    // ohne fsync des Ordners kann der rename einen Stromausfall nicht überleben (nur Unix kann Ordner öffnen)
    #[cfg(unix)]
    if let Some(dir) = file.parent() {
        let _ = std::fs::File::open(dir).and_then(|d| d.sync_all());
    }
    Ok(())
}

/// Schreibt über eine Punktdatei daneben und benennt um: Leser (Sync, zweiter Prozess) sehen nie eine halbe Datei.
pub fn write_atomic(file: &Path, bytes: &[u8]) -> Result<()> {
    let dir = file.parent().unwrap_or(Path::new("."));
    io(dir, std::fs::create_dir_all(dir))?;
    let (part, mut f) = part_file(file)?;
    let r = f.write_all(bytes).and_then(|_| f.sync_all());
    finish_part(&part, file, r)
}

/// Sekunden östlich von UTC zur Zeit `secs` (localtime_r, wie Electron/Node die Zeitzone sieht)
#[cfg(unix)]
fn utc_offset(secs: i64) -> i64 {
    let t = secs as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: localtime_r ist threadsicher und schreibt nur in `tm`
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return 0;
    }
    tm.tm_gmtoff as i64
}

/// ponytail: Windows nimmt UTC; Ortszeit dort per GetTimeZoneInformation, wenn dw-app für Windows kommt
#[cfg(not(unix))]
fn utc_offset(_: i64) -> i64 {
    0
}

/// Ortszeit wie toLocaleString('sv') in ipc.ts, mit „-“ statt „:“ (2026-10-18T14-03-09)
fn stamp(t: SystemTime) -> String {
    let s = t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let s = s + utc_offset(s);
    let (days, rem) = (s.div_euclid(86_400), s.rem_euclid(86_400));
    // civil_from_days (H. Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RecentDeck {
    pub path: PathBuf,
    pub title: String,
    /// ms seit 1970 wie stat().mtimeMs
    pub mtime: u64,
}

#[derive(Debug, Clone)]
pub struct Store {
    pub edition: Edition,
    root: PathBuf, // kanonisch
}

impl Store {
    /// $DECKWERK_HOME bzw. ~/Deckwerk / ~/DeckwerkPro; wird angelegt.
    pub fn open(edition: Edition) -> Result<Store> {
        let root = std::env::var_os("DECKWERK_HOME")
            .map(PathBuf::from)
            .or_else(|| platform::home_dir().map(|h| h.join(edition.home())))
            .ok_or(Error::NoHome)?;
        Store::at(edition, &root)
    }

    pub fn at(edition: Edition, root: &Path) -> Result<Store> {
        io(root, std::fs::create_dir_all(root))?;
        let root = io(root, root.canonicalize())?;
        Ok(Store { edition, root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// appData/<id>: Einstellungen, die App, Entwicklung und MCP teilen
    pub fn app_data(&self) -> Option<PathBuf> {
        platform::app_data_dir().map(|d| d.join(self.edition.id()))
    }

    pub fn assets_dir(&self) -> PathBuf {
        self.root.join("assets")
    }

    /// Kanonischer Pfad, der im Datenordner liegen muss (Symlinks aufgelöst). Fehlt die Datei, zählt ihr Ordner.
    pub fn inside(&self, p: &Path) -> Result<PathBuf> {
        let p = if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.root.join(p)
        };
        let real = match p.canonicalize() {
            Ok(r) => r,
            Err(_) => {
                let (Some(dir), Some(name)) = (p.parent(), p.file_name()) else {
                    return Err(Error::Outside(p));
                };
                match dir.canonicalize() {
                    Ok(d) => d.join(name),
                    Err(_) => return Err(Error::Outside(p)),
                }
            }
        };
        if real.starts_with(&self.root) && real != self.root {
            Ok(real)
        } else {
            Err(Error::Outside(p))
        }
    }

    /// <Datenordner>/<ordner>/deck.json, nicht unter assets/: Deck-Befehle erreichen so weder brand.json noch .jobs.json.
    pub fn deck_path(&self, p: &Path) -> Result<PathBuf> {
        let real = self.inside(p)?;
        let ok = real.file_name().is_some_and(|n| n == "deck.json")
            && real.parent().is_some_and(|d| d != self.root)
            && !real.starts_with(self.assets_dir());
        if ok {
            Ok(real)
        } else {
            Err(Error::NotDeck(real))
        }
    }

    /// Exportziel: im Datenordner, nicht in assets/ oder versions/, kein Symlink. Wird angelegt.
    pub fn export_dir(&self, p: &Path) -> Result<PathBuf> {
        let p = if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.root.join(p)
        };
        if p.components().any(|c| c == std::path::Component::ParentDir) {
            return Err(Error::Outside(p));
        }
        // erst den vorhandenen Teil prüfen: create_dir_all folgte sonst einem Symlink nach draußen
        let mut base = p.as_path();
        while !base.exists() {
            base = base.parent().ok_or_else(|| Error::Outside(p.clone()))?;
        }
        if !io(base, base.canonicalize())?.starts_with(&self.root) {
            return Err(Error::Outside(p));
        }
        let forbidden = |q: &Path| {
            let rel = q.strip_prefix(&self.root).unwrap_or(q);
            rel.starts_with("assets") || rel.components().any(|c| c.as_os_str() == "versions")
        };
        if forbidden(&p) {
            return Err(Error::Outside(p)); // vor dem Anlegen, damit kein leerer Ordner zurückbleibt
        }
        io(&p, std::fs::create_dir_all(&p))?;
        let real = self.inside(&p)?;
        if forbidden(&real) {
            return Err(Error::Outside(real));
        }
        Ok(real)
    }

    /// Die eine Ladestelle (§7.1 S1): Pfad im Datenordner, Größenlimit, Schema (dw-model) und Feldgrenzen.
    pub fn load_deck(&self, path: &Path) -> Result<Deck> {
        let path = self.deck_path(path)?;
        let len = io(&path, std::fs::metadata(&path))?.len();
        if len > DECK_MAX {
            return Err(Error::TooLarge(path, len, DECK_MAX));
        }
        let text = io(&path, std::fs::read_to_string(&path))?;
        let deck: Deck =
            serde_json::from_str(&text).map_err(|e| Error::Invalid(path.clone(), e.to_string()))?;
        check_deck(&deck).map_err(|e| Error::Invalid(path, e))?;
        Ok(deck)
    }

    /// Neuer Deck-Ordner <Datenordner>/<slug>, bei Kollision -2, -3 … (ipc.ts freeDir)
    pub fn new_deck_dir(&self, title: &str) -> Result<PathBuf> {
        let s = slug(title);
        for i in 1.. {
            let dir = if i == 1 {
                self.root.join(&s)
            } else {
                self.root.join(format!("{s}-{i}"))
            };
            // exklusiv: zwei gleichzeitige Saves bekommen nie denselben Ordner
            match std::fs::create_dir(&dir) {
                Ok(()) => return Ok(dir),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(Error::Io(dir, e)),
            }
        }
        unreachable!()
    }

    /// Speichert atomar (ipc.ts save); vorher wandert der alte Stand nach versions/ (höchstens alle 10 min).
    /// Ohne Pfad entsteht ein neuer Ordner aus dem Titel. Rückgabe: Pfad der deck.json.
    pub fn save_deck(&self, path: Option<&Path>, deck: &Deck) -> Result<PathBuf> {
        let json = serde_json::to_string_pretty(deck).expect("Deck ist immer serialisierbar");
        let shown = path.map_or_else(|| PathBuf::from(slug(&deck.title)), Path::to_path_buf);
        check_deck(deck).map_err(|e| Error::Invalid(shown.clone(), e))?;
        if json.len() as u64 > DECK_MAX {
            return Err(Error::TooLarge(shown, json.len() as u64, DECK_MAX));
        }
        let path = match path {
            Some(p) => self.deck_path(p)?,
            None => self.new_deck_dir(&deck.title)?.join("deck.json"),
        };
        self.snapshot(&path, false)?;
        write_atomic(&path, json.as_bytes())?;
        Ok(path)
    }

    /// Alter Stand nach <deck>/versions/<zeit>.json (ipc.ts snapshot). `force`: auch innerhalb von 10 min.
    pub fn snapshot(&self, file: &Path, force: bool) -> Result<Option<PathBuf>> {
        if !file.exists() {
            return Ok(None);
        }
        let all = self.versions(file)?;
        if !force
            && let Some(last) = all.last()
            && mtime(last).elapsed().is_ok_and(|age| age < VERSION_EVERY)
        {
            return Ok(None);
        }
        let dir = versions_dir(file);
        let to = dir.join(format!("{}.json", stamp(SystemTime::now())));
        write_atomic(&to, &io(file, std::fs::read(file))?)?;
        let all = self.versions(file)?;
        for old in &all[..all.len().saturating_sub(VERSION_MAX)] {
            let _ = std::fs::remove_file(old);
        }
        Ok(Some(to))
    }

    /// Versionen einer deck.json, älteste zuerst nach Änderungszeit (Namen aus Electron und aus Rust mischen sich,
    /// deshalb nicht nach Namen)
    pub fn versions(&self, deck_file: &Path) -> Result<Vec<PathBuf>> {
        let dir = versions_dir(deck_file);
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return Ok(vec![]);
        };
        let mut all: Vec<PathBuf> = rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension().is_some_and(|x| x == "json")
                    && !p
                        .file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with('.'))
            })
            .collect();
        all.sort_by_cached_key(|p| (mtime(p), p.clone()));
        Ok(all)
    }

    /// Zuletzt geänderte Decks unter <Datenordner>/*/deck.json, neueste zuerst; ungültige fallen still heraus.
    pub fn recent(&self, limit: usize) -> Vec<RecentDeck> {
        let Ok(rd) = std::fs::read_dir(&self.root) else {
            return vec![];
        };
        let mut found: Vec<RecentDeck> = rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| {
                let path = e.path().join("deck.json");
                let deck = self.load_deck(&path).ok()?;
                let mtime = std::fs::metadata(&path).ok()?.modified().ok()?;
                let mtime = mtime.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
                Some(RecentDeck {
                    path: self.inside(&path).ok()?,
                    title: deck.title,
                    mtime,
                })
            })
            .collect();
        found.sort_by_key(|r| std::cmp::Reverse(r.mtime));
        found.truncate(limit);
        found
    }

    /// Erzeugtes Bild usw. unter assets/<name>-<ms>.<ext> ablegen (ipc.ts asset:save), mit Typ- und Größenprüfung.
    pub fn save_asset(&self, name: &str, bytes: &[u8]) -> Result<PathBuf> {
        let to = self.asset_target(name, bytes.len() as u64)?;
        write_atomic(&to, bytes)?;
        Ok(to)
    }

    /// Datei in assets/ kopieren (gestreamt, daher Video/Audio ohne Limit).
    pub fn import_asset(&self, from: &Path) -> Result<PathBuf> {
        let len = io(from, std::fs::metadata(from))?.len();
        let name = from
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let to = self.asset_target(&name, len)?;
        let (part, mut f) = part_file(&to)?;
        let r = std::fs::File::open(from)
            .and_then(|mut src| std::io::copy(&mut src, &mut f))
            .and_then(|_| f.sync_all());
        finish_part(&part, &to, r)?;
        Ok(to)
    }

    fn asset_target(&self, name: &str, len: u64) -> Result<PathBuf> {
        let p = Path::new(name);
        let kind = media_kind(p).ok_or_else(|| Error::MediaType(name.into()))?;
        let to_dir = self.assets_dir();
        if matches!(kind, MediaKind::Image | MediaKind::Font) && len > IMAGE_MAX {
            return Err(Error::TooLarge(p.to_path_buf(), len, IMAGE_MAX));
        }
        let ext = p
            .extension()
            .unwrap()
            .to_string_lossy()
            .to_ascii_lowercase();
        let stem: String = p
            .file_stem()
            .map(|s| s.to_string_lossy())
            .unwrap_or_default()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .take(60)
            .collect();
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        io(&to_dir, std::fs::create_dir_all(&to_dir))?;
        Ok(to_dir.join(format!("{stem}-{ms}.{ext}")))
    }

    /// Medienpfad aus einem Deck (asset://, file://, relativ zum Deck-Ordner) zu einer Datei, die eingebunden werden darf:
    /// MEDIA_EXT und nur unter Deck- oder Asset-Ordner, damit eine fremde deck.json keine beliebigen Dateien zieht.
    pub fn resolve_media(
        &self,
        src: &str,
        deck_dir: &Path,
    ) -> std::result::Result<PathBuf, String> {
        let p = match src
            .strip_prefix("asset://")
            .or_else(|| src.strip_prefix("file://"))
        {
            // URL wie sync.ts assetPath: Host (asset://local/…) fällt weg, /C:/… → C:/…
            Some(rest) => {
                let path = rest.find('/').map_or("", |i| &rest[i..]);
                let path = percent_decode(path);
                let b = path.as_bytes();
                if b.len() > 2 && b[2] == b':' && b[1].is_ascii_alphabetic() {
                    path[1..].to_string()
                } else {
                    path
                }
            }
            None => src.to_string(),
        };
        if media_kind(Path::new(&p)).is_none() {
            return Err(format!("{src}: Dateityp nicht erlaubt"));
        }
        let path = deck_dir
            .join(&p)
            .canonicalize()
            .or_else(|_| self.local_asset(&p).ok_or(()))
            .map_err(|_| format!("{src} nicht gefunden"))?;
        let roots = [
            deck_dir.canonicalize().ok(),
            self.assets_dir().canonicalize().ok(),
        ];
        if roots.iter().flatten().any(|r| path.starts_with(r)) {
            Ok(path)
        } else {
            Err(format!("{src} liegt außerhalb von Deck- und Asset-Ordner"))
        }
    }

    /// Absoluter Pfad von einem anderen Gerät (…/Deckwerk/assets/x.png) → derselbe Pfad im eigenen Datenordner
    /// (sync.ts localAsset)
    fn local_asset(&self, p: &str) -> Option<PathBuf> {
        let mark = format!("/{}/", self.edition.home());
        let i = p.rfind(&mark)?;
        self.root.join(&p[i + mark.len()..]).canonicalize().ok()
    }

    /// brand.json; fehlt oder ungültig → None (tools.ts defaultBrand)
    pub fn brand(&self) -> Option<BrandKit> {
        let text = std::fs::read_to_string(self.root.join("brand.json")).ok()?;
        let b: BrandKit = serde_json::from_str(&text).ok()?;
        self.check_brand(&b).ok().map(|_| b)
    }

    /// Brand-Kit prüfen (§7.1 S11: Farben, Logo nur als Bild aus assets/) und atomar speichern
    pub fn set_brand(&self, b: &BrandKit) -> Result<()> {
        let f = self.root.join("brand.json");
        self.check_brand(b)
            .map_err(|e| Error::Invalid(f.clone(), e))?;
        write_atomic(&f, serde_json::to_string_pretty(b).unwrap().as_bytes())
    }

    fn check_brand(&self, b: &BrandKit) -> std::result::Result<(), String> {
        for c in std::iter::once(&b.primary).chain(&b.secondary) {
            Color::from_hex(c).ok_or_else(|| format!("ungültige Farbe {c:?}"))?;
        }
        for logo in b.logo.iter().chain(&b.logo_dark) {
            let assets = self.assets_dir();
            let p = self.resolve_media(logo, &assets)?;
            if media_kind(&p) != Some(MediaKind::Image)
                || !p.starts_with(assets.canonicalize().unwrap_or(assets))
            {
                return Err(format!("Logo {logo} muss ein Bild aus assets/ sein"));
            }
        }
        Ok(())
    }

    /// hausstil.md, getrimmt; fehlt → ""
    pub fn house_style(&self) -> String {
        std::fs::read_to_string(self.root.join("hausstil.md"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    }

    pub fn set_house_style(&self, text: &str) -> Result<()> {
        let f = self.root.join("hausstil.md");
        if text.len() > STYLE_MAX {
            return Err(Error::TooLarge(f, text.len() as u64, STYLE_MAX as u64));
        }
        write_atomic(&f, text.as_bytes())
    }
}

fn mtime(p: &Path) -> SystemTime {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .unwrap_or(UNIX_EPOCH)
}

fn versions_dir(deck_file: &Path) -> PathBuf {
    deck_file
        .parent()
        .unwrap_or(Path::new("."))
        .join("versions")
}

/// Feldgrenzen über das serde-Schema hinaus; jeder Weg, der ein Deck annimmt, ruft das auf
pub fn check_deck(d: &Deck) -> std::result::Result<(), String> {
    if let Some(s) = d.size
        && !(SIZE_PX.contains(&s.w) && SIZE_PX.contains(&s.h))
    {
        return Err(format!("Foliengröße {}×{} außerhalb 96–5376 px", s.w, s.h));
    }
    if d.slides.len() > SLIDES_MAX {
        return Err(format!("{} Folien, höchstens {SLIDES_MAX}", d.slides.len()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dw-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn deck(title: &str) -> Deck {
        serde_json::from_value(serde_json::json!({
            "title": title, "theme": { "id": "beratung" },
            "slides": [{ "id": "a", "layout": "title", "content": { "title": "Hallo" } }]
        }))
        .unwrap()
    }

    #[test]
    fn slug_wie_freedir() {
        assert_eq!(slug("Überblick: Wachstum 2027!"), "überblick-wachstum-2027");
        assert_eq!(slug("../../etc"), "etc");
        assert_eq!(slug("—"), "deck");
        assert_eq!(slug("  Quartal  Q3 "), "quartal-q3");
        let long = slug(&format!("{}-x", "a".repeat(59)));
        assert_eq!(long, "a".repeat(59)); // Bindestrich am Schnitt fällt weg
        assert_eq!(slug("CON"), "con-deck");
        assert_eq!(slug("Com1"), "com1-deck");
        assert_eq!(slug("Assets"), "assets-deck");
        assert_eq!(slug("Versions"), "versions-deck");
        assert_eq!(slug("Konzept"), "konzept");
        // Exportnamen wie engine.ts/dw-cli
        assert_eq!(
            file_slug("Überblick: Wachstum 2027!"),
            "ueberblick-wachstum-2027"
        );
        assert_eq!(file_slug("Straße"), "strasse");
        assert_eq!(file_slug("—"), "deck");
    }

    #[test]
    fn stempel_in_ortszeit() {
        // wie toLocaleString('sv'): dieselbe Ortszeit, die `date` anzeigt (Sekundenwechsel abfangen)
        let date = || {
            let o = std::process::Command::new("date")
                .arg("+%Y-%m-%dT%H-%M-%S")
                .output()
                .unwrap();
            String::from_utf8(o.stdout).unwrap().trim().to_string()
        };
        let (a, ours, b) = (date(), stamp(SystemTime::now()), date());
        assert!(ours == a || ours == b, "{ours} vs {a}/{b}");
    }

    #[test]
    fn atomar_speichern_und_versionen() {
        let root = tmp("save");
        let s = Store::at(Edition::Deckwerk, &root).unwrap();
        let p = s.save_deck(None, &deck("Mein Deck")).unwrap();
        assert_eq!(p, s.root().join("mein-deck/deck.json"));
        assert!(s.versions(&p).unwrap().is_empty()); // erster Stand: nichts zu sichern
        assert!(!p.with_file_name(".deck.json.part").exists());

        let mut d = deck("Mein Deck");
        d.title = "Neu".into();
        s.save_deck(Some(&p), &d).unwrap();
        assert_eq!(s.versions(&p).unwrap().len(), 1);
        assert_eq!(s.load_deck(&p).unwrap().title, "Neu");
        // innerhalb von 10 min keine weitere Version
        s.save_deck(Some(&p), &d).unwrap();
        assert_eq!(s.versions(&p).unwrap().len(), 1);
        // gleicher Titel → neuer Ordner -2
        assert_eq!(
            s.save_deck(None, &d).unwrap(),
            s.root().join("neu/deck.json")
        );
        assert!(
            s.save_deck(None, &deck("Mein Deck"))
                .unwrap()
                .ends_with("mein-deck-2/deck.json")
        );

        // höchstens 100 Versionen: die ältesten fallen weg
        // Reihenfolge nach Änderungszeit, nicht nach Namen (Ortszeit-Namen aus Electron sortieren nicht verlässlich)
        let vd = p.parent().unwrap().join("versions");
        for i in 0..105u64 {
            let f = vd.join(format!("2099-01-01T00-00-{:03}.json", 104 - i));
            std::fs::write(&f, "{}").unwrap();
            let f = std::fs::File::options().write(true).open(&f).unwrap();
            f.set_modified(UNIX_EPOCH + Duration::from_secs(1_000_000 + i))
                .unwrap();
        }
        let newest = s.snapshot(&p, true).unwrap().unwrap();
        let v = s.versions(&p).unwrap();
        assert_eq!(v.len(), VERSION_MAX);
        assert!(v[0].ends_with("2099-01-01T00-00-098.json"), "{:?}", v[0]);
        assert_eq!(v.last(), Some(&newest));
        // keine Punktdateien übrig
        assert!(
            std::fs::read_dir(p.parent().unwrap()).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part"))
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ausserhalb_abgelehnt() {
        let root = tmp("outside");
        let other = tmp("outside-fremd");
        let s = Store::at(Edition::Pro, &root.join("home")).unwrap();
        std::fs::write(
            other.join("deck.json"),
            serde_json::to_string(&deck("x")).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            s.load_deck(&other.join("deck.json")),
            Err(Error::Outside(_))
        ));
        assert!(matches!(
            s.load_deck(&s.root().join("../../x/deck.json")),
            Err(Error::Outside(_))
        ));
        assert!(matches!(
            s.save_deck(Some(&other.join("deck.json")), &deck("x")),
            Err(Error::Outside(_))
        ));
        // nur <ordner>/deck.json: brand.json, .jobs.json und assets/ sind keine Decks
        s.set_brand(&serde_json::from_value(serde_json::json!({ "primary": "#112233" })).unwrap())
            .unwrap();
        for p in [
            "brand.json",
            ".jobs.json",
            "deck.json",
            "assets/deck.json",
            "x/brand.json",
        ] {
            let r = s.save_deck(Some(&s.root().join(p)), &deck("x"));
            assert!(
                matches!(r, Err(Error::NotDeck(_)) | Err(Error::Outside(_))),
                "{p}"
            );
        }
        assert!(s.brand().is_some());
        // Exportziel nicht in assets/ oder versions/
        assert!(s.export_dir(&s.root().join("assets")).is_err());
        assert!(s.export_dir(&s.root().join("a/versions")).is_err());
        assert!(s.export_dir(&s.root().join("a/out")).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&other, s.root().join("raus")).unwrap();
            assert!(s.export_dir(&s.root().join("raus")).is_err());
            std::fs::create_dir_all(s.root().join("link")).unwrap();
            std::os::unix::fs::symlink(other.join("deck.json"), s.root().join("link/deck.json"))
                .unwrap();
            assert!(matches!(
                s.load_deck(&s.root().join("link/deck.json")),
                Err(Error::Outside(_))
            ));
        }
        assert!(
            s.resolve_media(&format!("file://{}/deck.json", other.display()), s.root())
                .is_err()
        );
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&other).unwrap();
    }

    #[test]
    fn groessenlimits_und_schema() {
        let root = tmp("limit");
        let s = Store::at(Edition::Deckwerk, &root).unwrap();
        let big = s.root().join("gross/deck.json");
        std::fs::create_dir_all(big.parent().unwrap()).unwrap();
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(DECK_MAX + 1).unwrap();
        assert!(matches!(s.load_deck(&big), Err(Error::TooLarge(..))));

        let bad = s.root().join("kaputt/deck.json");
        std::fs::create_dir_all(bad.parent().unwrap()).unwrap();
        std::fs::write(
            &bad,
            r#"{"title":"x","theme":{"id":"a"},"slides":[],"size":{"w":"/..","h":1}}"#,
        )
        .unwrap();
        assert!(matches!(s.load_deck(&bad), Err(Error::Invalid(..))));
        std::fs::write(
            &bad,
            r#"{"title":"x","theme":{"id":"a"},"slides":[],"size":{"w":1e9,"h":720}}"#,
        )
        .unwrap();
        assert!(matches!(s.load_deck(&bad), Err(Error::Invalid(..))));

        assert!(matches!(
            s.save_asset("x.exe", b"MZ"),
            Err(Error::MediaType(_))
        ));
        let a = s.save_asset("../Poster bild.png", b"png").unwrap();
        assert!(a.starts_with(s.assets_dir()) && a.to_string_lossy().contains("Poster-bild-"));
        assert!(
            s.resolve_media(&format!("asset://{}", a.display()), &s.root().join("gross"))
                .is_ok()
        );
        // asset://local/<pfad> (sync.ts assetPath) und Pfad von einem anderen Gerät (localAsset)
        let enc = a.display().to_string().replace(' ', "%20");
        assert_eq!(
            s.resolve_media(&format!("asset://local{enc}"), s.root())
                .unwrap(),
            a
        );
        let name = a.file_name().unwrap().to_string_lossy();
        let fremd = format!("asset://local/Users/anna/Deckwerk/assets/{name}");
        assert_eq!(s.resolve_media(&fremd, s.root()).unwrap(), a);
        // Bild über 50 MB: Größe wird vor dem Kopieren geprüft
        let huge = root.join("riesig.png");
        std::fs::File::create(&huge)
            .unwrap()
            .set_len(IMAGE_MAX + 1)
            .unwrap();
        assert!(matches!(s.import_asset(&huge), Err(Error::TooLarge(..))));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn brand_hausstil_zuletzt() {
        let root = tmp("brand");
        let s = Store::at(Edition::Deckwerk, &root).unwrap();
        assert!(s.brand().is_none());
        let mut b: BrandKit =
            serde_json::from_value(serde_json::json!({ "primary": "#112233" })).unwrap();
        s.set_brand(&b).unwrap();
        assert_eq!(s.brand().unwrap().primary, "#112233");
        b.primary = "rot\"/>".into();
        assert!(s.set_brand(&b).is_err());
        b.primary = "#112233".into();
        b.logo = Some("/etc/passwd.png".into());
        assert!(s.set_brand(&b).is_err());

        s.set_house_style("  Kurze Sätze.\n").unwrap();
        assert_eq!(s.house_style(), "Kurze Sätze.");

        let a = s.save_deck(None, &deck("A")).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        s.save_deck(None, &deck("B")).unwrap();
        std::fs::create_dir_all(s.root().join("leer")).unwrap();
        let r = s.recent(10);
        assert_eq!(
            r.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(),
            ["B", "A"]
        );
        assert_eq!(s.recent(1).len(), 1);
        assert_eq!(r[1].path, a);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
