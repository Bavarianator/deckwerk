//! Export über dw-daemon in-process (§3.4): Deck öffnen, `Cmd::Export` als Job, Fortschritt über `events()`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use dw_daemon::{Cmd, Daemon, Event, ExportFormat, JobState, Reply};
use dw_store::Store;

static DAEMON: Mutex<Option<Daemon>> = Mutex::new(None);

/// Ein Daemon je Datenordner; beim ersten Export gestartet (lädt Schriften).
pub fn daemon(store: &Store) -> Result<Daemon, String> {
    let mut d = DAEMON.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(d) = d.as_ref().filter(|d| d.store().root() == store.root()) {
        return Ok(d.clone());
    }
    let new = Daemon::new(store.clone()).map_err(|e| e.to_string())?;
    *d = Some(new.clone());
    Ok(new)
}

/// Exportiert das gespeicherte Deck `deck_path`. `target` außerhalb des Datenordners: der Daemon schreibt nur in den
/// Datenordner, daher entsteht der Export im Deck-Ordner und wird dann kopiert. Rückgabe: erzeugte Dateien/Ordner.
pub fn run(
    store: &Store,
    deck_path: &Path,
    formats: Vec<ExportFormat>,
    target: Option<&Path>,
    progress: &dyn Fn(f32),
) -> Result<Vec<PathBuf>, String> {
    let d = daemon(store)?;
    let events = d.events(); // vor dem Auftrag, sonst fehlen frühe Ereignisse
    if let Reply::Error { message } = d.command(Cmd::Open { path: deck_path.to_path_buf() }) {
        return Err(message);
    }
    let inside = target.filter(|t| t.canonicalize().is_ok_and(|t| t.starts_with(store.root())));
    let id = match d.command(Cmd::Export { formats, deck: None, out: inside.map(Path::to_path_buf), timeout_s: None }) {
        Reply::Job { id } => id,
        Reply::Error { message } => return Err(message),
        r => return Err(format!("unerwartete Antwort: {r:?}")),
    };
    let info = loop {
        match events.recv() {
            Ok(Event::Job(j)) if j.id == id => {
                progress(j.progress);
                if j.state.finished() {
                    break j;
                }
            }
            Ok(_) => {}
            Err(_) => return Err("Daemon beendet".into()),
        }
    };
    if info.state != JobState::Done {
        return Err(info.message.unwrap_or_else(|| format!("Export {:?}", info.state)));
    }
    match target {
        Some(t) if inside.is_none() => info.files.iter().map(|f| copy(f, t)).collect(),
        _ => Ok(info.files),
    }
}

fn copy(from: &Path, to_dir: &Path) -> Result<PathBuf, String> {
    let to = to_dir.join(from.file_name().ok_or("Dateiname fehlt")?);
    let e = |e: std::io::Error| format!("{}: {e}", to.display());
    if from.is_dir() {
        std::fs::create_dir_all(&to).map_err(e)?;
        for f in std::fs::read_dir(from).map_err(e)?.flatten() {
            std::fs::copy(f.path(), to.join(f.file_name())).map_err(e)?;
        }
    } else {
        std::fs::copy(from, &to).map_err(e)?;
    }
    Ok(to)
}

/// Ordner im Dateimanager zeigen
pub fn open_folder(p: &Path) {
    let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(windows)]
    let cmd = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = "xdg-open";
    if let Err(e) = std::process::Command::new(cmd).arg(dir).spawn() {
        eprintln!("{cmd}: {e}");
    }
}
