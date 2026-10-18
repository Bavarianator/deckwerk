//! Engine-Prozess für App, MCP und CLI (§3.4, §8.2): offenes Deck, Render, Exporte als Jobs, Ereignisse.
//! Die App bindet `Daemon` in-process ein; MCP und CLI sprechen über `Server`/`Client` (Unix-Socket, eine JSON-Zeile
//! je Nachricht). Je Datenordner läuft höchstens ein Daemon (Lockfile).

pub mod export;
pub mod jobs;

use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use dw_model::{Deck, Measured, Scene};
use dw_scene::FontStore;
use dw_store::{Edition, RecentDeck, Store};
use serde::{Deserialize, Serialize};

pub use jobs::{Ctl, Jobs, Outcome, Stop};
use jobs::{lock, panic_text};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Png,
    Pdf,
    Pptx,
}

/// Befehle an den Daemon. Neue Befehle (KI-Tools, MCP) kommen als weitere Varianten dazu.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Cmd {
    Ping,
    /// deck.json im Datenordner öffnen (dw-store prüft Pfad, Größe, Schema)
    Open {
        path: PathBuf,
    },
    /// das offene Deck
    Get,
    /// offenes Deck ersetzen, ohne zu speichern
    Set {
        deck: Box<Deck>,
    },
    /// atomar speichern mit Version; ohne Pfad der bisherige bzw. ein neuer Ordner aus dem Titel
    Save {
        #[serde(default)]
        path: Option<PathBuf>,
    },
    Recent {
        #[serde(default = "twelve")]
        limit: usize,
    },
    /// eine Folie setzen und messen (Autofit, Elemente)
    Render {
        slide: usize,
    },
    /// Export als Job; `out` muss im Datenordner liegen, ohne = Ordner des Decks bzw. <Datenordner>/out
    Export {
        formats: Vec<ExportFormat>,
        #[serde(default)]
        out: Option<PathBuf>,
        #[serde(default)]
        timeout_s: Option<u64>,
    },
    Jobs,
    Cancel {
        id: u64,
    },
    /// diese Verbindung bekommt ab jetzt nur noch `Event`-Zeilen
    Subscribe,
    Shutdown,
}

fn twelve() -> usize {
    12
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "reply", rename_all = "snake_case")]
pub enum Reply {
    Ok,
    Pong {
        edition: Edition,
        root: PathBuf,
        pid: u32,
    },
    Deck {
        path: Option<PathBuf>,
        deck: Box<Deck>,
    },
    Saved {
        path: PathBuf,
    },
    Recent {
        decks: Vec<RecentDeck>,
    },
    Measured {
        measured: Measured,
    },
    Job {
        id: u64,
    },
    Jobs {
        jobs: Vec<JobInfo>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Job(JobInfo),
    /// offenes Deck geöffnet, ersetzt oder gespeichert
    Deck {
        path: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
    TimedOut,
}

impl JobState {
    pub fn finished(self) -> bool {
        !matches!(self, JobState::Queued | JobState::Running)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobInfo {
    pub id: u64,
    pub kind: String,
    pub state: JobState,
    pub progress: f32,
    pub message: Option<String>,
    pub files: Vec<PathBuf>,
}

/// Was ein Job braucht, als Kopie: Er läuft weiter, auch wenn das offene Deck sich ändert oder der Daemon neu startet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "job", rename_all = "snake_case")]
pub enum JobSpec {
    Export {
        deck: Deck,
        deck_dir: PathBuf,
        formats: Vec<ExportFormat>,
        out: PathBuf,
    },
}

impl JobSpec {
    pub fn kind(&self) -> &'static str {
        match self {
            JobSpec::Export { .. } => "export",
        }
    }
}

/// Measure-Cache: (Deck-Hash, Folie) → Szene + Messung. engine.ts hatte ihn unbegrenzt (§5.1).
/// ponytail: LRU als Vec mit linearer Suche, reicht für 64 Einträge.
struct Lru {
    cap: usize,
    items: Vec<((u64, usize), (Scene, Measured))>,
}

impl Lru {
    fn get(&mut self, k: (u64, usize)) -> Option<(Scene, Measured)> {
        let i = self.items.iter().position(|(key, _)| *key == k)?;
        let e = self.items.remove(i);
        let v = e.1.clone();
        self.items.push(e);
        Some(v)
    }
    fn put(&mut self, k: (u64, usize), v: (Scene, Measured)) {
        self.items.retain(|(key, _)| *key != k);
        if self.items.len() >= self.cap {
            self.items.remove(0);
        }
        self.items.push((k, v));
    }
}

const CACHE_SLIDES: usize = 64;
/// Eine Zeile ist höchstens ein Deck (DECK_MAX) plus Hülle
const LINE_MAX: u64 = dw_store::DECK_MAX + (1 << 20);

struct Open {
    deck: Option<Deck>,
    path: Option<PathBuf>,
}

struct Inner {
    store: Store,
    open: Mutex<Open>,
    // ponytail: eine Schriftablage für alle, Render läuft dadurch seriell; je Thread eine, wenn das bremst
    fonts: Mutex<FontStore>,
    cache: Mutex<Lru>,
    subs: Mutex<Vec<mpsc::Sender<Event>>>,
}

impl Inner {
    fn emit(&self, e: Event) {
        lock(&self.subs).retain(|tx| tx.send(e.clone()).is_ok());
    }

    fn render(&self, deck: &Deck, i: usize) -> Result<(Scene, Measured), String> {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        serde_json::to_string(deck).unwrap_or_default().hash(&mut h);
        let key = (h.finish(), i);
        if let Some(v) = lock(&self.cache).get(key) {
            return Ok(v);
        }
        let v =
            dw_scene::render_slide(deck, i, &mut lock(&self.fonts)).map_err(|e| e.to_string())?;
        lock(&self.cache).put(key, v.clone());
        Ok(v)
    }
}

#[derive(Clone)]
pub struct Daemon {
    inner: Arc<Inner>,
    jobs: Jobs,
}

impl Daemon {
    /// Schriften laden, offene Jobs aus <Datenordner>/.jobs.json übernehmen, Worker starten.
    pub fn new(store: Store) -> anyhow::Result<Daemon> {
        let fonts = FontStore::from_dir(&FontStore::default_dir())?;
        let jobs_file = store.root().join(".jobs.json");
        let inner = Arc::new(Inner {
            store,
            open: Mutex::new(Open {
                deck: None,
                path: None,
            }),
            fonts: Mutex::new(fonts),
            cache: Mutex::new(Lru {
                cap: CACHE_SLIDES,
                items: vec![],
            }),
            subs: Mutex::default(),
        });
        let (w1, w2) = (Arc::downgrade(&inner), Arc::downgrade(&inner));
        let runner: jobs::Runner = Box::new(move |spec, ctl| {
            let Some(inner) = w1.upgrade() else {
                return Outcome::Failed("Daemon beendet".into());
            };
            match spec {
                JobSpec::Export {
                    deck,
                    deck_dir,
                    formats,
                    out,
                } => {
                    // erneut prüfen: Jobs kommen auch aus .jobs.json, und Pfade können sich seit dem Auftrag geändert haben
                    let dirs = inner
                        .store
                        .inside(deck_dir)
                        .and_then(|d| Ok((d, inner.store.export_dir(out)?)));
                    let (deck_dir, out) = match dirs {
                        Ok(d) => d,
                        Err(e) => return Outcome::Failed(e.to_string()),
                    };
                    export::run(
                        &inner.store,
                        deck,
                        &deck_dir,
                        formats,
                        &out,
                        &|d, i| inner.render(d, i),
                        ctl,
                    )
                }
            }
        });
        let notify: jobs::Notify = Box::new(move |info| {
            if let Some(inner) = w2.upgrade() {
                inner.emit(Event::Job(info.clone()));
            }
        });
        let jobs = Jobs::start(jobs_file, runner, notify);
        Ok(Daemon { inner, jobs })
    }

    pub fn store(&self) -> &Store {
        &self.inner.store
    }

    pub fn events(&self) -> mpsc::Receiver<Event> {
        let (tx, rx) = mpsc::channel();
        lock(&self.inner.subs).push(tx);
        rx
    }

    /// Eine Panik wird zur Fehlerantwort, statt den Verbindungs-Thread still zu beenden.
    pub fn command(&self, cmd: Cmd) -> Reply {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.run(cmd)))
            .unwrap_or_else(|p| Err(format!("interner Fehler: {}", panic_text(&*p))))
            .unwrap_or_else(|message| Reply::Error { message })
    }

    fn run(&self, cmd: Cmd) -> Result<Reply, String> {
        let inner = &self.inner;
        let store = &inner.store;
        let err = |e: dw_store::Error| e.to_string();
        let no_deck = || "Es ist kein Deck offen.".to_string();
        Ok(match cmd {
            Cmd::Ping => Reply::Pong {
                edition: store.edition,
                root: store.root().to_path_buf(),
                pid: std::process::id(),
            },
            Cmd::Open { path } => {
                let deck = store.load_deck(&path).map_err(err)?;
                let path = Some(store.inside(&path).map_err(err)?);
                *lock(&inner.open) = Open {
                    deck: Some(deck.clone()),
                    path: path.clone(),
                };
                inner.emit(Event::Deck { path: path.clone() });
                Reply::Deck {
                    path,
                    deck: Box::new(deck),
                }
            }
            Cmd::Get => {
                let o = lock(&inner.open);
                Reply::Deck {
                    path: o.path.clone(),
                    deck: Box::new(o.deck.clone().ok_or_else(no_deck)?),
                }
            }
            Cmd::Set { deck } => {
                dw_store::check_deck(&deck)?;
                let path = {
                    let mut o = lock(&inner.open);
                    o.deck = Some(*deck);
                    o.path.clone()
                };
                inner.emit(Event::Deck { path });
                Reply::Ok
            }
            Cmd::Save { path } => {
                let mut o = lock(&inner.open);
                let deck = o.deck.as_ref().ok_or_else(no_deck)?;
                let p = store
                    .save_deck(path.as_deref().or(o.path.as_deref()), deck)
                    .map_err(err)?;
                o.path = Some(p.clone());
                drop(o);
                inner.emit(Event::Deck {
                    path: Some(p.clone()),
                });
                Reply::Saved { path: p }
            }
            Cmd::Recent { limit } => Reply::Recent {
                decks: store.recent(limit),
            },
            Cmd::Render { slide } => {
                let deck = lock(&inner.open).deck.clone().ok_or_else(no_deck)?;
                let (_, measured) = inner.render(&deck, slide)?;
                Reply::Measured { measured }
            }
            Cmd::Export {
                formats,
                out,
                timeout_s,
            } => {
                if formats.is_empty() {
                    return Err("keine Formate".into());
                }
                let (deck, path) = {
                    let o = lock(&inner.open);
                    (o.deck.clone().ok_or_else(no_deck)?, o.path.clone())
                };
                let deck_dir = path
                    .as_deref()
                    .and_then(Path::parent)
                    .map_or_else(|| store.root().to_path_buf(), Path::to_path_buf);
                let out = match out {
                    // Exportziel aus einem fremden Prozess: nie außerhalb des Datenordners schreiben
                    Some(o) => store.export_dir(&o).map_err(err)?,
                    None if path.is_some() => deck_dir.clone(),
                    None => store.export_dir(&store.root().join("out")).map_err(err)?,
                };
                let timeout = timeout_s
                    .map_or(jobs::DEFAULT_TIMEOUT, Duration::from_secs)
                    .min(jobs::MAX_TIMEOUT);
                Reply::Job {
                    id: self.jobs.submit(
                        JobSpec::Export {
                            deck,
                            deck_dir,
                            formats,
                            out,
                        },
                        timeout,
                    ),
                }
            }
            Cmd::Jobs => Reply::Jobs {
                jobs: self.jobs.list(),
            },
            Cmd::Cancel { id } => {
                if !self.jobs.cancel(id) {
                    return Err(format!("Job {id} läuft nicht oder ist unbekannt"));
                }
                Reply::Ok
            }
            // Subscribe/Shutdown betreffen die Verbindung bzw. den Server
            Cmd::Subscribe | Cmd::Shutdown => return Err("nur über den Socket".into()),
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ServeError {
    #[error("Für {0} läuft schon ein Daemon")]
    Running(PathBuf),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Start(#[from] anyhow::Error),
}

/// Privater Ordner (0700) für Lockfile und Socket; Punktordner, vom Sync ausgenommen
fn private_dir(store: &Store) -> PathBuf {
    store.root().join(".daemon")
}

/// sun_path fasst 108 Byte (macOS 104) inklusive Nullbyte
const SUN_PATH_MAX: usize = 103;

/// Socket des Daemons für diesen Datenordner. Ist der Pfad für einen Unix-Socket zu lang, liegt er unter
/// $XDG_RUNTIME_DIR/deckwerk-<hash>.sock (der Ordner ist laut Spezifikation nur für den Nutzer lesbar).
pub fn socket_path(store: &Store) -> PathBuf {
    sock_for(
        store.root(),
        std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from),
    )
}

fn sock_for(root: &Path, runtime: Option<PathBuf>) -> PathBuf {
    let p = root.join(".daemon").join("sock");
    if p.as_os_str().len() <= SUN_PATH_MAX {
        return p;
    }
    match runtime.filter(|r| r.is_absolute()) {
        Some(r) => {
            // FNV-1a: stabil über Rust-Versionen, Client und Daemon müssen denselben Namen finden
            let h = root
                .as_os_str()
                .as_encoded_bytes()
                .iter()
                .fold(0xcbf2_9ce4_8422_2325u64, |h, &b| {
                    (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
                });
            r.join(format!("deckwerk-{h:016x}.sock"))
        }
        None => p, // bind meldet den zu langen Pfad
    }
}

/// Läuft der Daemon im eigenen Prozess; Socket und Lockfile liegen in <Datenordner>/.daemon/ (0700).
pub struct Server {
    daemon: Daemon,
    _lock: std::fs::File,
    sock: PathBuf,
    listener: Listener,
}

#[cfg(unix)]
type Listener = std::os::unix::net::UnixListener;
#[cfg(not(unix))]
type Listener = ();

impl Server {
    /// Sperre nehmen, dann erst den Socket anlegen: ein zweiter Daemon am selben Datenordner scheitert hier.
    pub fn bind(store: Store) -> Result<Server, ServeError> {
        let dir = private_dir(&store);
        make_private(&dir)?;
        let lock_file = dir.join("lock");
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_file)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(ServeError::Running(store.root().to_path_buf()));
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
        }
        let sock = socket_path(&store);
        let listener = listen(&sock)?;
        Ok(Server {
            daemon: Daemon::new(store)?,
            _lock: lock,
            sock,
            listener,
        })
    }

    pub fn daemon(&self) -> &Daemon {
        &self.daemon
    }

    /// Nimmt Verbindungen an, bis ein Client `Shutdown` schickt.
    #[cfg(unix)]
    pub fn run(self) -> std::io::Result<()> {
        let stop = Arc::new(AtomicBool::new(false));
        for conn in self.listener.incoming() {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let Ok(conn) = conn else {
                // z. B. zu viele offene Dateien: nicht heiß drehen
                std::thread::sleep(Duration::from_millis(50));
                continue;
            };
            let (d, stop, sock) = (self.daemon.clone(), stop.clone(), self.sock.clone());
            std::thread::spawn(move || {
                if serve_conn(&d, conn, &stop) {
                    // accept() aufwecken, damit die Schleife das Stopp-Flag sieht
                    let _ = std::os::unix::net::UnixStream::connect(&sock);
                }
            });
        }
        let _ = std::fs::remove_file(&self.sock);
        Ok(())
    }

    #[cfg(not(unix))]
    pub fn run(self) -> std::io::Result<()> {
        unimplemented!("Named Pipe für Windows kommt mit dw-app")
    }
}

/// Ordner nur für den Nutzer: schon beim bind darf kein anderer den Socket erreichen (Rechte erst danach zu setzen
/// ließe ein Fenster offen)
#[cfg(unix)]
fn make_private(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
        _ => {}
    }
    if !std::fs::symlink_metadata(dir)?.is_dir() {
        return Err(std::io::Error::other(format!(
            "{} ist kein Ordner",
            dir.display()
        )));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn make_private(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

#[cfg(unix)]
fn listen(sock: &Path) -> std::io::Result<Listener> {
    let n = sock.as_os_str().len();
    if n > SUN_PATH_MAX {
        return Err(std::io::Error::other(format!(
            "Socket-Pfad {} ist zu lang ({n} Byte, höchstens {SUN_PATH_MAX}); kürzeren DECKWERK_HOME oder XDG_RUNTIME_DIR setzen",
            sock.display()
        )));
    }
    // Wir halten die Sperre: ein vorhandener Socket stammt von einem abgestürzten Daemon
    let _ = std::fs::remove_file(sock);
    std::os::unix::net::UnixListener::bind(sock)
}

#[cfg(not(unix))]
fn listen(_: &Path) -> std::io::Result<()> {
    unimplemented!("Named Pipe für Windows kommt mit dw-app")
}

/// Eine Verbindung: Zeile rein, Zeile raus. true = Shutdown angefordert.
#[cfg(unix)]
fn serve_conn(d: &Daemon, conn: std::os::unix::net::UnixStream, stop: &AtomicBool) -> bool {
    let Ok(mut w) = conn.try_clone() else {
        return false;
    };
    let mut r = BufReader::new(conn);
    let mut line = String::new();
    loop {
        line.clear();
        match (&mut r).take(LINE_MAX).read_line(&mut line) {
            Ok(0) | Err(_) => return false,
            Ok(_) if !line.ends_with('\n') => {
                let _ = send(
                    &mut w,
                    &Reply::Error {
                        message: "Nachricht zu groß".into(),
                    },
                );
                return false;
            }
            Ok(_) => {}
        }
        let reply = match serde_json::from_str::<Cmd>(&line) {
            Err(e) => Reply::Error {
                message: format!("ungültiger Befehl: {e}"),
            },
            Ok(Cmd::Shutdown) => {
                stop.store(true, Ordering::Relaxed);
                let _ = send(&mut w, &Reply::Ok);
                return true;
            }
            Ok(Cmd::Subscribe) => {
                let rx = d.events();
                if send(&mut w, &Reply::Ok).is_err() {
                    return false;
                }
                for e in rx {
                    if send(&mut w, &e).is_err() {
                        return false;
                    }
                }
                return false;
            }
            Ok(cmd) => d.command(cmd),
        };
        if send(&mut w, &reply).is_err() {
            return false;
        }
    }
}

fn send(w: &mut impl Write, v: &impl Serialize) -> std::io::Result<()> {
    let mut s = serde_json::to_string(v).map_err(std::io::Error::other)?;
    s.push('\n');
    w.write_all(s.as_bytes())
}

fn recv<T: for<'de> Deserialize<'de>>(r: &mut impl BufRead) -> std::io::Result<T> {
    let mut line = String::new();
    if r.take(LINE_MAX).read_line(&mut line)? == 0 {
        return Err(std::io::ErrorKind::UnexpectedEof.into());
    }
    serde_json::from_str(&line).map_err(std::io::Error::other)
}

/// Client für App, MCP und CLI: ein Befehl, eine Antwort; Ereignisse über eine eigene Verbindung.
#[cfg(unix)]
pub struct Client {
    sock: PathBuf,
    r: BufReader<std::os::unix::net::UnixStream>,
    w: std::os::unix::net::UnixStream,
}

#[cfg(unix)]
impl Client {
    pub fn connect(sock: &Path) -> std::io::Result<Client> {
        let w = std::os::unix::net::UnixStream::connect(sock)?;
        Ok(Client {
            sock: sock.to_path_buf(),
            r: BufReader::new(w.try_clone()?),
            w,
        })
    }

    pub fn command(&mut self, cmd: &Cmd) -> std::io::Result<Reply> {
        send(&mut self.w, cmd)?;
        recv(&mut self.r)
    }

    /// Ereignisse ab jetzt; das Iterator-Ende heißt: Daemon weg.
    pub fn events(&self) -> std::io::Result<impl Iterator<Item = Event> + use<>> {
        let mut c = Client::connect(&self.sock)?;
        match c.command(&Cmd::Subscribe)? {
            Reply::Ok => {}
            other => return Err(std::io::Error::other(format!("{other:?}"))),
        }
        let mut r = c.r;
        Ok(std::iter::from_fn(move || recv(&mut r).ok()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> Store {
        let d = std::env::temp_dir().join(format!("dw-daemon-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        Store::at(Edition::Deckwerk, &d).unwrap()
    }

    #[test]
    fn zweiter_daemon_abgelehnt() {
        let store = home("lock");
        let a = Server::bind(store.clone()).unwrap();
        assert!(matches!(
            Server::bind(store.clone()),
            Err(ServeError::Running(_))
        ));
        drop(a);
        // Sperre frei: ein neuer Daemon darf starten
        Server::bind(store.clone()).unwrap();
        std::fs::remove_dir_all(store.root()).unwrap();
    }

    #[test]
    fn socket_pfad_zu_lang() {
        let short = Path::new("/home/a/Deckwerk");
        assert_eq!(sock_for(short, None), short.join(".daemon/sock"));
        let long = PathBuf::from(format!("/home/{}/Deckwerk", "x".repeat(100)));
        let r = sock_for(&long, Some("/run/user/1000".into()));
        assert!(r.starts_with("/run/user/1000") && r.to_string_lossy().ends_with(".sock"));
        assert_eq!(r, sock_for(&long, Some("/run/user/1000".into())));
        // ohne Ausweichordner: bind meldet den Pfad verständlich
        let e = listen(&sock_for(&long, None)).unwrap_err().to_string();
        assert!(e.contains("zu lang"), "{e}");
    }

    #[test]
    fn socket_ordner_privat() {
        use std::os::unix::fs::PermissionsExt;
        let store = home("perm");
        let s = Server::bind(store.clone()).unwrap();
        let mode = std::fs::metadata(store.root().join(".daemon"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        // Set prüft die Feldgrenzen wie das Laden
        let mut deck: Deck = serde_json::from_value(
            serde_json::json!({ "title": "t", "theme": { "id": "beratung" }, "slides": [] }),
        )
        .unwrap();
        deck.size = Some(dw_model::Size { w: 1e9, h: 720.0 });
        assert!(matches!(
            s.daemon().command(Cmd::Set {
                deck: Box::new(deck)
            }),
            Reply::Error { .. }
        ));
        drop(s);
        std::fs::remove_dir_all(store.root()).unwrap();
    }

    #[test]
    fn lru_begrenzt() {
        let v = || {
            (
                Scene {
                    width: 1.0,
                    height: 1.0,
                    background: dw_model::Color::from_hex("#fff").unwrap(),
                    nodes: vec![],
                },
                Measured {
                    els: vec![],
                    fit: serde_json::from_value(
                        serde_json::json!({"ok":true,"head":0,"body":0,"overflow":[]}),
                    )
                    .unwrap(),
                },
            )
        };
        let mut l = Lru {
            cap: 2,
            items: vec![],
        };
        l.put((1, 0), v());
        l.put((2, 0), v());
        assert!(l.get((1, 0)).is_some()); // 1 zuletzt benutzt
        l.put((3, 0), v());
        assert!(l.get((2, 0)).is_none() && l.get((1, 0)).is_some() && l.items.len() == 2);
    }

    #[test]
    fn ende_zu_ende_export_ueber_socket() {
        let store = home("e2e");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/pitch.json");
        let deck_dir = store.root().join("pitch");
        std::fs::create_dir_all(&deck_dir).unwrap();
        std::fs::copy(&src, deck_dir.join("deck.json")).unwrap();

        let server = Server::bind(store.clone()).unwrap();
        let t = std::thread::spawn(move || server.run().unwrap());
        let sock = socket_path(&store);
        let mut c = Client::connect(&sock).unwrap();
        assert!(matches!(c.command(&Cmd::Ping).unwrap(), Reply::Pong { .. }));

        // außerhalb des Datenordners: abgelehnt
        assert!(matches!(
            c.command(&Cmd::Open { path: src.clone() }).unwrap(),
            Reply::Error { .. }
        ));
        let Reply::Deck { deck, .. } = c
            .command(&Cmd::Open {
                path: deck_dir.join("deck.json"),
            })
            .unwrap()
        else {
            panic!("kein Deck")
        };
        assert!(!deck.slides.is_empty());
        assert!(matches!(
            c.command(&Cmd::Render { slide: 0 }).unwrap(),
            Reply::Measured { .. }
        ));
        assert!(matches!(
            c.command(&Cmd::Export {
                formats: vec![ExportFormat::Png],
                out: Some("/etc".into()),
                timeout_s: None
            })
            .unwrap(),
            Reply::Error { .. }
        ));

        let events = c.events().unwrap();
        let formats = vec![ExportFormat::Png, ExportFormat::Pdf, ExportFormat::Pptx];
        let Reply::Job { id } = c
            .command(&Cmd::Export {
                formats,
                out: None,
                timeout_s: None,
            })
            .unwrap()
        else {
            panic!("kein Job")
        };
        let mut progress = 0;
        let info = events
            .filter_map(|e| match e {
                Event::Job(i) if i.id == id => Some(i),
                _ => None,
            })
            .inspect(|i| progress += usize::from(i.state == JobState::Running))
            .find(|i| i.state.finished())
            .unwrap();
        assert_eq!(info.state, JobState::Done, "{:?}", info.message);
        assert!(progress > 2, "Fortschritt gemeldet");
        let stem = dw_store::slug(&deck.title);
        assert_eq!(info.files.len(), 3);
        assert!(deck_dir.join(&stem).join("01.png").is_file());
        for ext in ["pdf", "pptx"] {
            let f = deck_dir.join(format!("{stem}.{ext}"));
            assert!(
                std::fs::metadata(&f).unwrap().len() > 1000,
                "{}",
                f.display()
            );
        }
        let Reply::Saved { path } = c.command(&Cmd::Save { path: None }).unwrap() else {
            panic!()
        };
        assert_eq!(path, deck_dir.canonicalize().unwrap().join("deck.json"));

        assert!(matches!(c.command(&Cmd::Shutdown).unwrap(), Reply::Ok));
        t.join().unwrap();
        assert!(!sock.exists());
        std::fs::remove_dir_all(store.root()).unwrap();
    }
}
