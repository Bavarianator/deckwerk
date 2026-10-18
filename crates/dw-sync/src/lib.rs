//! Cloud-Sync (sync.ts + sync-folder.ts): spiegelt den Datenordner nach <Server oder Sync-Ordner>/Deckwerk/.
//! Abgleich gegen .sync-state.json (je Datei mtime/size lokal und etag entfernt vom letzten Lauf):
//! nur eine Seite geändert → übernehmen, beide → neuere gewinnt (bei deck.json landet die ältere in versions/).
//! Format von .sync-state.json wie in Electron, damit beide Fassungen denselben Ordner abgleichen können.
// ponytail: Teilen/Live (mitarbeit.ts), testSync, createSyncer, findFolder/checkSyncFolder fehlen, kommen mit der UI

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dw_store::write_atomic;
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};

pub struct Settings {
    pub url: String,
    pub user: String,
    pub pass: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct SyncResult {
    pub up: usize,
    pub down: usize,
    pub deleted: usize,
    pub conflicts: usize,
    /// lokal überschriebene oder gelöschte Dateien (absolut, sortiert)
    pub changed: Vec<PathBuf>,
}

type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Entry {
    mtime: i64,
    size: u64,
    #[serde(default)]
    etag: String,
}

#[derive(Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    base: String,
    #[serde(default)]
    files: BTreeMap<String, Entry>,
}

const STATE: &str = ".sync-state.json";
/// Geteiltes Deck: diese Datei liegt im Deck-Ordner, nur der Live-Abgleich schreibt es
pub const SHARED_MARKER: &str = "mitarbeit.json";

/// Nicht gespiegelt: Versionen, Exporte, Modelle, Schrift-Cache, Punktdateien (auch .sync-state.json, .part),
/// Systemdateien der Cloud-Apps. `\` trennt unter Windows Ordner: x\..\..\evil.cmd schriebe sonst außerhalb.
fn skip(name: &str) -> bool {
    name.is_empty()
        || name.starts_with('.')
        || name.contains('\\')
        || ["versions", "out", "models", "fonts", "exports"].contains(&name)
        || ["desktop.ini", "thumbs.db", "icon\r"].contains(&name.to_lowercase().as_str())
}

/// file:-Adresse = Sync-Ordner einer Desktop-App (Dropbox & Co.) statt WebDAV-Server
pub fn is_folder(url: &str) -> bool {
    Url::parse(url.trim()).is_ok_and(|u| u.scheme() == "file")
}

/// WebDAV-Basis inkl. Deckwerk/. Nur ein Host → Nextcloud/ownCloud-Pfad /remote.php/dav/files/<nutzer>/.
pub fn dav_base(s: &Settings) -> Result<Url> {
    let raw = s.url.trim();
    let raw = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let mut u =
        Url::parse(&raw).map_err(|_| "Cloud-Sync: Die WebDAV-Adresse ist ungültig.".to_string())?;
    let bad = || "Cloud-Sync: Die WebDAV-Adresse ist ungültig.".to_string();
    if u.scheme() != "file" && (u.path() == "/" || u.path().is_empty()) {
        u.path_segments_mut().map_err(|_| bad())?.clear().extend([
            "remote.php",
            "dav",
            "files",
            &s.user,
        ]);
    }
    u.path_segments_mut()
        .map_err(|_| bad())?
        .pop_if_empty()
        .extend([dw_store::Edition::from_env().home(), ""]);
    Ok(u)
}

fn ms(t: SystemTime) -> i64 {
    // gerundet wie Math.round(mtimeMs) in Electron, sonst sähe jede Datei aus dem alten Stand geändert aus
    t.duration_since(UNIX_EPOCH)
        .map_or(0, |d| ((d.as_nanos() + 500_000) / 1_000_000) as i64)
}

fn stat(p: &Path) -> Option<(i64, u64)> {
    let m = std::fs::metadata(p).ok()?;
    Some((ms(m.modified().ok()?), m.len()))
}

/// RFC 1123 („Sun, 06 Nov 1994 08:49:37 GMT“) → ms; unlesbar → 0
fn http_date(s: &str) -> i64 {
    let p: Vec<&str> = s.split([' ', ':']).filter(|x| !x.is_empty()).collect();
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let (Some(d), Some(m), Some(y), Some(hh), Some(mm), Some(ss)) = (
        p.get(1).and_then(|x| x.parse::<i64>().ok()),
        p.get(2)
            .and_then(|x| months.iter().position(|m| m == x))
            .map(|m| m as i64 + 1),
        p.get(3).and_then(|x| x.parse::<i64>().ok()),
        p.get(4).and_then(|x| x.parse::<i64>().ok()),
        p.get(5).and_then(|x| x.parse::<i64>().ok()),
        p.get(6).and_then(|x| x.parse::<i64>().ok()),
    ) else {
        return 0;
    };
    // days_from_civil (H. Hinnant)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    ((days * 86_400) + hh * 3600 + mm * 60 + ss) * 1000
}

/// ETags kommen je Server mit oder ohne Anführungszeichen bzw. W/-Präfix
fn etag_of(e: &str) -> String {
    e.replace("&quot;", "\"")
        .trim_start_matches("W/")
        .replace('"', "")
        .trim()
        .to_string()
}

fn unxml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// PROPFIND-Antwort ohne XML-Bibliothek (Namensraum-Präfixe je Server verschieden): (rel, Ordner?, Eintrag)
pub fn parse_multistatus(xml: &str, base_path: &str) -> Vec<(String, bool, i64, u64, String)> {
    let tag = |s: &str, name: &str| {
        let re = regex::Regex::new(&format!(
            r"<(?:\w+:)?{name}[^>]*>([\s\S]*?)</(?:\w+:)?{name}>"
        ))
        .unwrap();
        re.captures(s)
            .map_or(String::new(), |c| c[1].trim().to_string())
    };
    let split = regex::Regex::new(r"<(?:\w+:)?response[\s>]").unwrap();
    let coll = regex::Regex::new(r"<(?:\w+:)?collection[\s/>]").unwrap();
    let root = Url::parse("http://x/").unwrap();
    let mut out = vec![];
    for part in split.split(xml).skip(1) {
        let Ok(u) = root.join(&unxml(&tag(part, "href"))) else {
            continue;
        };
        let href = percent_encoding::percent_decode_str(u.path()).decode_utf8_lossy();
        // Schlussstrich ergänzen: manche Server nennen Ordner ohne
        let href = format!("{}/", href.trim_end_matches('/'));
        let Some(rel) = href.strip_prefix(base_path) else {
            continue;
        };
        out.push((
            rel.trim_end_matches('/').to_string(),
            coll.is_match(part),
            http_date(&tag(part, "getlastmodified")),
            tag(part, "getcontentlength").parse().unwrap_or(0),
            etag_of(&tag(part, "getetag")),
        ));
    }
    out
}

/// Gegenseite: WebDAV-Server oder Ordner auf der Platte
enum Remote {
    Dav {
        client: reqwest::Client,
        base: Url,
        user: String,
        pass: String,
    },
    Folder(PathBuf),
}

/// realpath oder, wenn es den Pfad noch nicht gibt, realpath des nächsten vorhandenen Elternordners + Rest
fn real(p: &Path) -> PathBuf {
    match (std::fs::canonicalize(p), p.parent(), p.file_name()) {
        (Ok(r), ..) => r,
        (Err(_), Some(dir), Some(name)) => real(dir).join(name),
        _ => p.to_path_buf(),
    }
}

impl Remote {
    async fn req(
        &self,
        method: &str,
        rel: &str,
        body: Vec<u8>,
        headers: &[(&str, String)],
    ) -> Result<reqwest::Response> {
        let Remote::Dav {
            client,
            base,
            user,
            pass,
        } = self
        else {
            unreachable!()
        };
        let mut url = base.clone();
        url.path_segments_mut()
            .unwrap()
            .pop_if_empty()
            .extend(rel.split('/'));
        // Zeitlimit: 2 min plus Übertragung bei 50 KB/s; ein hängender Server hielte den Lauf sonst für immer auf
        let mut r = client
            .request(Method::from_bytes(method.as_bytes()).unwrap(), url)
            .basic_auth(user, Some(pass))
            .timeout(Duration::from_millis(120_000 + body.len() as u64 / 50))
            .body(body);
        for (k, v) in headers {
            r = r.header(*k, v);
        }
        let r = r.send().await.map_err(|e| {
            if e.is_timeout() {
                format!("Cloud-Sync: Der Server antwortet nicht ({rel}). Der nächste Abgleich macht weiter.")
            } else {
                format!("Cloud-Sync: {e}")
            }
        })?;
        if r.status() == 401 {
            return Err(
                "Cloud-Sync: Anmeldung abgelehnt. Nutzername und App-Passwort prüfen.".into(),
            );
        }
        Ok(r)
    }

    fn must(r: reqwest::Response, what: &str) -> Result<reqwest::Response> {
        if r.status().is_success() {
            Ok(r)
        } else {
            Err(format!(
                "Cloud-Sync: {what} fehlgeschlagen (HTTP {})",
                r.status().as_u16()
            ))
        }
    }

    async fn bytes(r: reqwest::Response) -> Result<Vec<u8>> {
        r.bytes().await.map(|b| b.to_vec()).map_err(|e| {
            if e.is_timeout() {
                "Der Server antwortet nicht. Der nächste Abgleich macht weiter.".into()
            } else {
                format!("Cloud-Sync: {e}")
            }
        })
    }

    /// Alle Dateien und Ordner. fresh = Ordner Deckwerk fehlte und ist neu angelegt
    async fn list(&self) -> Result<(HashMap<String, Entry>, HashSet<String>, bool)> {
        let (mut files, mut dirs) = (HashMap::new(), HashSet::from([String::new()]));
        match self {
            Remote::Folder(dir) => {
                if !dir.exists() {
                    if !dir.parent().is_some_and(Path::exists) {
                        return Err(
                            "Cloud-Sync: Den Sync-Ordner gibt es nicht. Adresse prüfen.".into()
                        );
                    }
                    std::fs::create_dir(dir)
                        .map_err(|e| format!("Cloud-Sync: Ordner anlegen fehlgeschlagen ({e})"))?;
                    return Ok((files, dirs, true));
                }
                let mut todo = vec![String::new()];
                while let Some(rel) = todo.pop() {
                    let rd = std::fs::read_dir(dir.join(&rel))
                        .map_err(|e| format!("Cloud-Sync: Ordner lesen fehlgeschlagen ({e})"))?;
                    for e in rd.flatten() {
                        let name = e.file_name().to_string_lossy().into_owned();
                        // iCloud lagert Dateien als .name.icloud aus; sie sähen sonst entfernt gelöscht aus
                        if name.starts_with('.') && name.ends_with(".icloud") && name.len() > 8 {
                            return Err("Cloud-Sync: iCloud hat Dateien im Ordner Deckwerk ausgelagert. Im Finder „Immer auf diesem Mac behalten“ einschalten.".into());
                        }
                        if skip(&name) {
                            continue;
                        }
                        let r = if rel.is_empty() {
                            name
                        } else {
                            format!("{rel}/{name}")
                        };
                        let Ok(m) = std::fs::metadata(e.path()) else {
                            continue;
                        }; // kaputter Link
                        if m.is_dir() {
                            dirs.insert(r.clone());
                            todo.push(r);
                        } else if let Some((mtime, size)) = stat(&e.path()) {
                            files.insert(
                                r,
                                Entry {
                                    mtime,
                                    size,
                                    etag: format!("{mtime}-{size}"),
                                },
                            );
                        }
                    }
                }
                // ponytail: alte .part-Reste im Sync-Ordner bleiben liegen (Punktdateien, stören nicht), aufräumen bei Bedarf
            }
            Remote::Dav { base, .. } => {
                let base_path = percent_encoding::percent_decode_str(base.path())
                    .decode_utf8_lossy()
                    .into_owned();
                let body = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>"#;
                // Depth 1 rekursiv, weil Nextcloud Depth infinity sperrt
                let mut todo = vec![String::new()];
                while let Some(rel) = todo.pop() {
                    let path = if rel.is_empty() {
                        String::new()
                    } else {
                        format!("{rel}/")
                    };
                    let h = [
                        ("Depth", "1".to_string()),
                        ("Content-Type", "application/xml".to_string()),
                    ];
                    let r = self.req("PROPFIND", &path, body.into(), &h).await?;
                    if r.status() == 404 && rel.is_empty() {
                        let m = self.req("MKCOL", "", vec![], &[]).await?;
                        if m.status() == 409 {
                            return Err("Cloud-Sync: Die WebDAV-Adresse gibt es auf dem Server nicht. Adresse prüfen.".into());
                        }
                        Self::must(m, "Ordner Deckwerk anlegen")?;
                        return Ok((files, dirs, true));
                    }
                    let xml = String::from_utf8_lossy(
                        &Self::bytes(Self::must(r, "Ordner lesen")?).await?,
                    )
                    .into_owned();
                    let entries = parse_multistatus(&xml, &base_path);
                    // Depth 1 nennt immer den Ordner selbst. Fehlt er, passen die hrefs nicht zur Adresse (Proxy, andere uid):
                    // eine leer gelesene Liste sähe sonst aus, als wäre auf dem Server alles gelöscht
                    if !entries.iter().any(|e| e.0 == rel) {
                        return Err("Cloud-Sync: Die Antwort des Servers passt nicht zur Adresse. WebDAV-Adresse prüfen.".into());
                    }
                    for (r, dir, mtime, size, etag) in entries {
                        if r == rel || r.split('/').any(skip) {
                            continue;
                        }
                        if dir {
                            dirs.insert(r.clone());
                            todo.push(r);
                        } else {
                            files.insert(r, Entry { mtime, size, etag });
                        }
                    }
                }
            }
        }
        Ok((files, dirs, false))
    }

    async fn get(&self, rel: &str) -> Result<Vec<u8>> {
        match self {
            Remote::Folder(dir) => std::fs::read(dir.join(rel))
                .map_err(|e| format!("Cloud-Sync: Herunterladen {rel} fehlgeschlagen ({e})")),
            _ => {
                Self::bytes(Self::must(
                    self.req("GET", rel, vec![], &[]).await?,
                    &format!("Herunterladen {rel}"),
                )?)
                .await
            }
        }
    }

    /// Lädt hoch, legt fehlende Ordner an; liefert den ETag (leer, wenn der Server keinen nennt)
    async fn put(
        &self,
        rel: &str,
        body: Vec<u8>,
        mtime: i64,
        dirs: &mut HashSet<String>,
    ) -> Result<String> {
        let parts: Vec<&str> = rel.split('/').collect();
        match self {
            Remote::Folder(dir) => {
                let file = dir.join(rel);
                // atomar über eine Punktdatei: die Cloud-App lädt nie eine halbe Datei hoch
                write_atomic(&file, &body)
                    .map_err(|e| format!("Cloud-Sync: Hochladen {rel} fehlgeschlagen ({e})"))?;
                // wie X-OC-Mtime: Bearbeitungszeit behalten, sonst gewinnt im Konflikt der letzte Upload
                let t = UNIX_EPOCH + Duration::from_millis(mtime.max(0) as u64);
                let _ = std::fs::File::options()
                    .write(true)
                    .open(&file)
                    .and_then(|f| f.set_modified(t));
                Ok(stat(&file).map_or(String::new(), |(m, s)| format!("{m}-{s}")))
            }
            _ => {
                for i in 1..parts.len() {
                    let d = parts[..i].join("/");
                    if dirs.contains(&d) {
                        continue;
                    }
                    let r = self.req("MKCOL", &format!("{d}/"), vec![], &[]).await?;
                    if r.status() != 405 {
                        Self::must(r, &format!("Ordner {d} anlegen"))?; // 405 = gibt es schon
                    }
                    dirs.insert(d);
                }
                // X-OC-Mtime: Nextcloud/ownCloud übernehmen die Bearbeitungszeit, sonst wäre getlastmodified die Upload-Zeit
                let h = [("X-OC-Mtime", (mtime / 1000).to_string())];
                let r = Self::must(
                    self.req("PUT", rel, body, &h).await?,
                    &format!("Hochladen {rel}"),
                )?;
                Ok(etag_of(
                    r.headers()
                        .get("etag")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or(""),
                ))
            }
        }
    }

    async fn delete(&self, rel: &str) -> Result<()> {
        match self {
            Remote::Folder(dir) => match std::fs::remove_file(dir.join(rel)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    Err(format!("Cloud-Sync: Löschen {rel} fehlgeschlagen ({e})"))
                }
                _ => Ok(()),
            },
            _ => {
                let r = self.req("DELETE", rel, vec![], &[]).await?;
                if r.status() == 404 {
                    Ok(())
                } else {
                    Self::must(r, &format!("Löschen {rel}")).map(|_| ())
                }
            }
        }
    }
}

fn local_list(home: &Path) -> Result<HashMap<String, Entry>> {
    // Nur ein fehlender Ordner zählt als leer; jeder andere Lesefehler bricht ab (sonst sähe alles „lokal gelöscht“ aus)
    let mut out = HashMap::new();
    let mut todo = vec![String::new()];
    while let Some(rel) = todo.pop() {
        let dir = home.join(&rel);
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(format!(
                    "Cloud-Sync: Ordner {} nicht lesbar ({e})",
                    dir.display()
                ));
            }
        };
        for e in rd {
            let e =
                e.map_err(|e| format!("Cloud-Sync: Ordner {} nicht lesbar ({e})", dir.display()))?;
            let name = e.file_name().to_string_lossy().into_owned();
            if skip(&name) {
                continue;
            }
            let r = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            if e.path().is_dir() {
                todo.push(r);
            } else if let Some((mtime, size)) = stat(&e.path()) {
                out.insert(
                    r,
                    Entry {
                        mtime,
                        size,
                        etag: String::new(),
                    },
                );
            }
        }
    }
    Ok(out)
}

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Keep,
    Same,
    Conflict,
    Up,
    Down,
    RmLocal,
    RmRemote,
    Forget,
}

/// Ein Abgleich. progress: kurzer Text für die Oberfläche (Vergleichen, Übertragen).
// ponytail: Dateien nacheinander statt 4 parallel wie sync.ts, parallel, wenn die Nextcloud-Latenz (~2 s/Datei) stört
pub async fn sync(home: &Path, s: &Settings, progress: &mut dyn FnMut(&str)) -> Result<SyncResult> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let base = dav_base(s)?;
    let remote_side = if base.scheme() == "file" {
        let dir = base
            .to_file_path()
            .map_err(|_| "Cloud-Sync: Die Ordner-Adresse ist ungültig.".to_string())?;
        // Sync-Ordner führt (auch per Link) in den Datenordner oder enthält ihn: Deckwerk spiegelte sich in sich selbst
        let (d, h) = (real(&dir), real(home));
        if d.starts_with(&h) || h.starts_with(&d) {
            return Err("Cloud-Sync: Der Sync-Ordner führt in den Deckwerk-Ordner selbst. In den Einstellungen einen anderen Ordner wählen.".into());
        }
        Remote::Folder(dir)
    } else {
        // Bewusst ohne die SSRF-Sperre aus dw-net: die Adresse wählt der Nutzer selbst, nicht die KI,
        // und eigene Nextcloud/NAS stehen oft im Heimnetz (192.168.…)
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| format!("Cloud-Sync: {e}"))?;
        Remote::Dav {
            client,
            base: base.clone(),
            user: s.user.clone(),
            pass: s.pass.clone(),
        }
    };
    let (mut remote, mut dirs, fresh) = remote_side.list().await?;
    let local = local_list(home)?;

    // Stand des letzten Laufs gilt nur für dieselbe Adresse und einen vorhandenen Server-Ordner, sonst „neu anfangen“
    let key = format!("{}@{base}", s.user);
    let state_path = home.join(STATE);
    let saved: State = std::fs::read(&state_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let old = if !fresh && saved.base == key {
        saved.files
    } else {
        BTreeMap::new()
    };
    let mut next: BTreeMap<String, Entry> = BTreeMap::new();
    let mut gone: HashSet<String> = HashSet::new();
    let mut res = SyncResult::default();
    let mut uploaded = vec![];

    let mut all: Vec<String> = local
        .keys()
        .chain(remote.keys())
        .chain(old.keys())
        .cloned()
        .collect();
    all.sort();
    all.dedup();
    // Geteilte Decks schreibt nur der Live-Abgleich: hier nur Fehlendes holen, nie hochladen oder löschen
    let shared: HashSet<&str> = all
        .iter()
        .filter(|r| r.split('/').count() == 2 && r.ends_with(&format!("/{SHARED_MARKER}")))
        .filter_map(|r| r.split('/').next())
        .collect();
    let is_shared = |r: &str| shared.contains(r.split('/').next().unwrap_or(""));
    let to_compare = all
        .iter()
        .filter(|r| {
            !is_shared(r)
                && !old.contains_key(*r)
                && matches!((local.get(*r), remote.get(*r)), (Some(l), Some(x)) if l.size == x.size)
        })
        .count();
    let mut compared = 0;
    let mut plan: Vec<(String, Op)> = vec![];
    for rel in &all {
        let (l, r, o) = (local.get(rel), remote.get(rel), old.get(rel));
        let op = if is_shared(rel) {
            if l.is_none() && r.is_some() && o.is_none() {
                Op::Down
            } else if o.is_some() && (l.is_some() || r.is_some()) {
                Op::Keep
            } else {
                Op::Forget
            }
        } else if let (Some(l), Some(r), None) = (l, r, o)
            && l.size == r.size
        {
            // zwei neue Dateien gleicher Größe (erster Abgleich): Inhalt vergleichen, sonst ginge eine Fassung verloren
            compared += 1;
            progress(&format!("Vergleicht {compared} von {to_compare} Dateien"));
            let same = remote_side.get(rel).await?
                == std::fs::read(home.join(rel))
                    .map_err(|e| format!("Cloud-Sync: {rel} nicht lesbar ({e})"))?;
            if same { Op::Same } else { Op::Conflict }
        } else {
            let lc = l.is_some_and(|l| o.is_none_or(|o| l.mtime != o.mtime || l.size != o.size));
            // ohne gemerkten ETag (Server lieferte keinen) entscheidet die Größe
            let rc = r.is_some_and(|r| {
                o.is_none_or(|o| {
                    if o.etag.is_empty() {
                        r.size != o.size
                    } else {
                        r.etag != o.etag
                    }
                })
            });
            match (l, r) {
                (Some(_), Some(_)) => match (lc, rc) {
                    (true, true) => Op::Conflict,
                    (true, false) => Op::Up,
                    (false, true) => Op::Down,
                    _ => Op::Keep,
                },
                (Some(_), None) => {
                    if o.is_some() && !lc {
                        Op::RmLocal
                    } else {
                        Op::Up
                    }
                }
                (None, Some(_)) => {
                    if o.is_some() && !rc {
                        Op::RmRemote
                    } else {
                        Op::Down
                    }
                }
                _ => Op::Forget,
            }
        };
        plan.push((rel.clone(), op));
    }
    // Löschbremse vor dem ersten Schritt: lokaler Ordner oder Server fast leer → anhalten
    let deletions = plan
        .iter()
        .filter(|(_, op)| matches!(op, Op::RmLocal | Op::RmRemote))
        .count();
    if old.len() >= 10 && deletions * 2 > old.len() {
        return Err(format!(
            "Cloud-Sync angehalten: {deletions} von {} Dateien würden gelöscht. Ist der Ordner auf dem Server oder auf dem Gerät noch vollständig? Zum Neubeginn Sync aus- und wieder einschalten.",
            old.len()
        ));
    }

    let moves = plan
        .iter()
        .filter(|(_, op)| matches!(op, Op::Up | Op::Down | Op::Conflict))
        .count();
    let mut moved = 0;
    if moves > 0 {
        progress(&format!("Überträgt 0 von {moves} Dateien"));
    }
    // ponytail: Fortschritt ohne MB-Angabe, ergänzen, wenn die UI sie zeigt
    let save = |next: &BTreeMap<String, Entry>, gone: &HashSet<String>| {
        let mut files = old.clone();
        files.extend(next.iter().map(|(k, v)| (k.clone(), v.clone())));
        files.retain(|k, _| !gone.contains(k));
        let json = serde_json::to_vec(&State {
            base: key.clone(),
            files,
        })
        .unwrap();
        write_atomic(&state_path, &json).map_err(|e| format!("Cloud-Sync: {e}"))
    };
    // Hat sich die Datei seit dem Auflisten lokal geändert (Auto-Speichern), nicht anfassen: der nächste Lauf sieht einen Konflikt
    let touched = |rel: &str| stat(&home.join(rel)) != local.get(rel).map(|l| (l.mtime, l.size));
    let deck_version = |rel: &str, tag: &str, bytes: &[u8]| {
        let dir = home.join(rel).parent().unwrap().join("versions");
        let name = format!("{}-{tag}.json", dw_store::stamp(SystemTime::now()));
        write_atomic(&dir.join(name), bytes).map_err(|e| format!("Cloud-Sync: {e}"))
    };

    let run = async {
        for (rel, op) in &plan {
            let rel = rel.as_str();
            let file = home.join(rel);
            let (l, r) = (local.get(rel), remote.get(rel));
            match op {
                Op::Same => {
                    next.insert(
                        rel.into(),
                        Entry {
                            etag: r.unwrap().etag.clone(),
                            ..l.unwrap().clone()
                        },
                    );
                }
                Op::Keep => {
                    next.insert(rel.into(), old[rel].clone());
                }
                Op::Forget => {
                    gone.insert(rel.into());
                }
                Op::RmLocal => {
                    if touched(rel) {
                        continue;
                    }
                    let _ = std::fs::remove_file(&file);
                    gone.insert(rel.into());
                    res.deleted += 1;
                    res.changed.push(file.clone());
                }
                Op::RmRemote => {
                    remote_side.delete(rel).await?;
                    gone.insert(rel.into());
                    res.deleted += 1;
                }
                Op::Up | Op::Down | Op::Conflict => {
                    let deck = rel.ends_with("/deck.json");
                    let local_wins = *op == Op::Up
                        || (*op == Op::Conflict && l.unwrap().mtime >= r.unwrap().mtime);
                    if *op == Op::Conflict {
                        res.conflicts += 1;
                    }
                    if local_wins {
                        // Konflikt: die Server-Fassung einer deck.json bleibt in versions/ erhalten
                        if *op == Op::Conflict && deck {
                            deck_version(rel, "cloud", &remote_side.get(rel).await?)?;
                        }
                        let body = std::fs::read(&file)
                            .map_err(|e| format!("Cloud-Sync: {rel} nicht lesbar ({e})"))?;
                        let etag = remote_side
                            .put(rel, body, l.unwrap().mtime, &mut dirs)
                            .await?;
                        next.insert(
                            rel.into(),
                            Entry {
                                etag,
                                ..l.unwrap().clone()
                            },
                        );
                        uploaded.push(rel.to_string());
                        res.up += 1;
                    } else if *op == Op::Conflict || !touched(rel) {
                        if *op == Op::Conflict && deck {
                            deck_version(
                                rel,
                                "lokal",
                                &std::fs::read(&file).map_err(|e| format!("Cloud-Sync: {e}"))?,
                            )?;
                        }
                        let bytes = remote_side.get(rel).await?;
                        // atomar über eine Punktdatei (vom Sync ausgenommen): ein Abbruch hinterlässt keine halbe Datei
                        write_atomic(&file, &bytes).map_err(|e| format!("Cloud-Sync: {e}"))?;
                        let (mtime, size) = stat(&file).unwrap_or_default();
                        next.insert(
                            rel.into(),
                            Entry {
                                mtime,
                                size,
                                etag: r.unwrap().etag.clone(),
                            },
                        );
                        res.down += 1;
                        res.changed.push(file.clone());
                    }
                    moved += 1;
                    progress(&format!("Überträgt {moved} von {moves} Dateien"));
                    // Zwischenstand: wird die App mitten im ersten großen Upload beendet, muss nicht alles noch einmal laufen
                    if moved % 20 == 0 {
                        save(&next, &gone)?;
                    }
                }
            }
        }
        // ETags der hochgeladenen Dateien aus einer frischen Liste: manche Server liefern beim PUT keinen oder ändern ihn danach
        if !uploaded.is_empty() {
            remote = remote_side.list().await?.0;
            for rel in &uploaded {
                if let (Some(n), Some(r)) = (next.get_mut(rel), remote.get(rel)) {
                    n.etag = r.etag.clone();
                }
            }
        }
        Ok::<(), String>(())
    };
    let r = run.await;
    // auch nach einem Abbruch (Netz weg): Erledigtes merken, Unerledigtes behält seinen alten Stand
    save(&next, &gone)?;
    r?;
    res.changed.sort();
    Ok(res)
}
