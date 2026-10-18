//! Die KI-Werkzeuge (tools.ts `buildTools`): eine Definition für App-Chat, CLI-Chat und MCP. Gleiche Namen,
//! Beschreibungen und Schemas wie heute (meta.rs, input.rs), gleiche Rückmeldung je Folie (Autofit + Lint).
//! Rendern und Exporte laufen über [`Engine`] (dw-daemon), alles mit Netz, Medien oder KI über [`Hooks`].

pub mod catalog;
pub mod input;
pub mod meta;
mod run;
pub mod schema;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use dw_model::{Deck, Measured};
use dw_store::Store;
use serde_json::Value;

/// Deckwerk Pro (Cargo-Feature `pro`): edit_timeline, export_deck cmyk/formats, topic timeline, Pro-Layouts
pub const PRO: bool = cfg!(feature = "pro");

/// Ein Aufruf wartet höchstens so lange auf einen Job (Vibe und Codex brechen Tool-Aufrufe nach 300 s ab)
pub const JOB_WAIT: Duration = Duration::from_secs(240);

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolOutput {
    pub text: String,
    /// PNG oder JPEG (siehe [`mime_of`])
    pub images: Vec<Vec<u8>>,
}

impl ToolOutput {
    pub fn text(t: impl Into<String>) -> ToolOutput {
        ToolOutput {
            text: t.into(),
            images: vec![],
        }
    }
}

pub fn mime_of(b: &[u8]) -> &'static str {
    if b.starts_with(&[0xff, 0xd8]) {
        "image/jpeg"
    } else {
        "image/png"
    }
}

/// asset://local/<Pfad> wie ipc.ts (`pathToFileURL(abs).pathname`, prozentkodiert)
pub fn asset_url(abs: &Path) -> String {
    let mut out = String::from("asset://local");
    for b in abs.to_string_lossy().bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'/'
            | b'-'
            | b'.'
            | b'_'
            | b'~'
            | b'!'
            | b'$'
            | b'&'
            | b'\''
            | b'('
            | b')'
            | b'*'
            | b'+'
            | b','
            | b';'
            | b'='
            | b':'
            | b'@' => out.push(b as char),
            _ => out += &format!("%{b:02X}"),
        }
    }
    out
}

/// Pfad hinter asset://local (prozentdekodiert); andere Werte unverändert
pub fn asset_path(src: &str) -> PathBuf {
    let Some(p) = src.strip_prefix("asset://local") else {
        return PathBuf::from(src);
    };
    let b = p.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (
            b[i],
            b.get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()),
        ) {
            (b'%', Some(x)) => {
                out.push(x);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    PathBuf::from(String::from_utf8_lossy(&out).into_owned())
}

/// Stand eines Hintergrund-Jobs
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Job {
    pub done: bool,
    /// 0..100
    pub pct: f32,
    pub files: Vec<PathBuf>,
    pub warnings: Vec<String>,
    /// fertig, aber gescheitert (Fehler, Abbruch, Zeitlimit)
    pub error: Option<String>,
}

/// Rendern und Exportieren (engine.ts): umgesetzt über dw-daemon (dw-mcp), in Tests als Attrappe.
pub trait Engine: Send + Sync {
    /// je Folie Messung (Autofit, Elemente) oder Fehlertext
    fn measure(
        &self,
        deck: &Deck,
        slides: &[usize],
    ) -> Result<Vec<Result<Measured, String>>, String>;
    fn render_png(&self, deck: &Deck, slides: &[usize], width: u32)
    -> Result<Vec<Vec<u8>>, String>;
    /// Kontaktbogen aller Folien
    fn render_overview(&self, deck: &Deck) -> Result<Vec<u8>, String>;
    /// Export (png, pdf, pptx) als Job nach `out`
    fn export(&self, deck: &Deck, format: &str, out: &Path) -> Result<u64, String>;
    fn job(&self, id: u64) -> Result<Job, String>;
}

/// Was die Video-Tools über eine Quelle schon wissen (engine.ts `video.cached`), ohne zu rechnen
#[derive(Debug, Clone, Default)]
pub struct VideoCache {
    pub duration: Option<f64>,
    pub transcript: Option<dw_lint::video::Transcript>,
    /// Musik im Hintergrund je Quellsekunde (Highlight-Signale)
    pub music: Option<Vec<f64>>,
}

/// Ergebnis eines Hook-Werkzeugs; `deck` = neues Deck (z. B. create_episode)
pub struct HookOut {
    pub out: ToolOutput,
    pub deck: Option<Deck>,
}

/// Werkzeuge und Daten, die Netz, Medien oder KI brauchen (Bildsuche im Netz, Bild-KI, Video, Podcast, Timeline,
/// Guide). Ohne Umsetzung melden sie „noch nicht verfügbar“; Name, Beschreibung und Schema stehen trotzdem in der Liste.
pub trait Hooks: Send + Sync {
    /// `input` ist schon gegen das Schema geprüft. None = nicht umgesetzt.
    fn call(
        &self,
        _tool: &str,
        _input: &Value,
        _deck: Option<&Deck>,
    ) -> Option<Result<HookOut, String>> {
        None
    }
    /// Kernprompt mit Modul-Index (guide-modules.ts `corePrompt`) für die MCP-Anweisungen
    fn core_prompt(&self) -> String {
        String::new()
    }
    /// Katalogschriften laden und fontFiles eintragen (webfonts.ts `withDeckFonts`); Rückgabe: Hinweise
    fn deck_fonts(&self, _deck: &mut Deck) -> Vec<String> {
        vec![]
    }
    /// Zeitachse einer Film-Szene in Worten (film-lint.ts `sceneEstimate`)
    fn scene_line(&self, _deck: &Deck, _i: usize, _m: Option<&Measured>) -> Option<String> {
        None
    }
    fn video_cache(&self, _file: &Path) -> Option<VideoCache> {
        None
    }
}

/// Keine Hooks: alle Netz-, Medien- und KI-Werkzeuge melden „noch nicht verfügbar“
pub struct NoHooks;
impl Hooks for NoHooks {}

/// jede Änderung am Deck
pub type OnDeck = Box<dyn Fn(&Deck) + Send + Sync>;
pub type Ask = Box<dyn Fn(&str, &[String]) + Send + Sync>;
/// (Titel, Layout) je Folie
pub type Storyline = Box<dyn Fn(&[(String, String)]) + Send + Sync>;
/// Auswahl-Karten: Frage, (Name, Bild als data:-URL)
pub type Choice = Box<dyn Fn(&str, &[(String, String)]) + Send + Sync>;

pub struct ToolCtx {
    pub engine: Box<dyn Engine>,
    pub hooks: Box<dyn Hooks>,
    /// Datenordner: Brand-Kit, Hausstil, letzte Decks, Assets
    pub store: Store,
    /// Exportziel; [`Tools::set_out_dir`] ändert es (nach save_deck/open_deck der Ordner des Decks)
    pub out_dir: PathBuf,
    /// false: Bildsuche ohne Vorschaubilder (UI)
    pub previews: bool,
    /// nur im App-Chat: Rückfrage mit Antwort-Buttons
    pub ask: Option<Ask>,
    /// nur im App-Chat: geplante Folien
    pub storyline: Option<Storyline>,
    /// nur im App-Chat: Look-Auswahl
    pub choice: Option<Choice>,
    /// jede Änderung am Deck (Live-Vorschau)
    pub on_deck: Option<OnDeck>,
}

impl ToolCtx {
    pub fn new(engine: Box<dyn Engine>, store: Store) -> ToolCtx {
        let out_dir = store.root().join("out");
        ToolCtx {
            engine,
            hooks: Box::new(NoHooks),
            store,
            out_dir,
            previews: true,
            ask: None,
            storyline: None,
            choice: None,
            on_deck: None,
        }
    }
}

/// Werkzeug, wie es ein Client sieht
#[derive(Debug, Clone)]
pub struct ToolInfo {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
    pub read_only: bool,
}

pub struct Tools {
    ctx: ToolCtx,
    deck: Mutex<Option<Deck>>,
    out_dir: Mutex<PathBuf>,
    /// Job-Schlüssel → Job-ID: derselbe Aufruf hängt sich an den laufenden Job
    jobs: Mutex<HashMap<String, u64>>,
    /// Deck-Werkzeuge strikt nacheinander, sonst geht eine Änderung verloren
    serial: Mutex<()>,
    /// wie lange ein Aufruf auf einen Job wartet (Tests kürzer)
    pub job_wait: Duration,
    list: Vec<ToolInfo>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Werkzeuge, die nur Deckwerk Pro anbietet
const PRO_TOOLS: [&str; 1] = ["edit_timeline"];
/// MCP-Zusätze (setzt dw-mcp um, Schema und Beschreibung in meta.rs)
pub const MCP_TOOLS: [&str; 3] = ["get_deck", "save_deck", "open_deck"];

impl Tools {
    pub fn new(ctx: ToolCtx) -> Tools {
        let list = meta::all()
            .into_iter()
            .filter(|m| PRO || !PRO_TOOLS.contains(&m.name))
            .filter(|m| !MCP_TOOLS.contains(&m.name))
            .filter(|m| match m.name {
                "plan_storyline" => ctx.storyline.is_some(),
                "ask_user" => ctx.ask.is_some(),
                _ => true,
            })
            .map(|m| ToolInfo {
                name: m.name,
                description: m.description,
                schema: (m.schema)(),
                read_only: m.read_only,
            })
            .collect();
        let out = ctx.out_dir.clone();
        Tools {
            ctx,
            deck: Mutex::new(None),
            out_dir: Mutex::new(out),
            jobs: Mutex::default(),
            serial: Mutex::new(()),
            job_wait: JOB_WAIT,
            list,
        }
    }

    /// buildTools: die Werkzeuge dieser Edition und dieses Kontexts
    pub fn list(&self) -> &[ToolInfo] {
        &self.list
    }

    pub fn ctx(&self) -> &ToolCtx {
        &self.ctx
    }

    pub fn deck(&self) -> Option<Deck> {
        lock(&self.deck).clone()
    }

    /// einziger Schreibpfad
    pub fn set_deck(&self, d: Deck) {
        if let Some(f) = &self.ctx.on_deck {
            f(&d);
        }
        *lock(&self.deck) = Some(d);
    }

    pub fn set_out_dir(&self, p: PathBuf) {
        *lock(&self.out_dir) = p;
    }

    pub fn out_dir(&self) -> PathBuf {
        lock(&self.out_dir).clone()
    }

    /// Deck-ändernde Aufrufe (auch save/open in dw-mcp) laufen unter dieser Sperre nacheinander
    pub fn serial(&self) -> MutexGuard<'_, ()> {
        lock(&self.serial)
    }

    /// Prüft die Eingabe gegen das Schema und führt das Werkzeug aus. Err = Fehlertext für isError.
    pub fn call(&self, name: &str, args: Value) -> Result<ToolOutput, String> {
        self.call_then(name, args, |_| {})
    }

    /// Wie `call`; `after` läuft bei Erfolg noch unter derselben Sperre (dw-mcp: Pfad nach create_deck zurücksetzen)
    pub fn call_then(
        &self,
        name: &str,
        args: Value,
        after: impl FnOnce(&ToolOutput),
    ) -> Result<ToolOutput, String> {
        let info = self
            .list
            .iter()
            .find(|t| t.name == name)
            .ok_or_else(|| format!("Unbekanntes Werkzeug \"{name}\"."))?;
        let args = check_input(name, &info.schema, args)?;
        let _serial = (!info.read_only).then(|| self.serial());
        let out = run::run(self, name, &args)?;
        after(&out);
        Ok(out)
    }
}

/// Eingabe gegen das Schema prüfen (zod-Meldungen); null = leeres Objekt, 3.0 = 3
pub fn check_input(name: &str, schema: &Value, args: Value) -> Result<Value, String> {
    let mut args = if args.is_null() {
        Value::Object(Default::default())
    } else {
        args
    };
    schema::ints(&mut args);
    let issues = schema::validate(schema, &args);
    if !issues.is_empty() {
        return Err(format!(
            "Eingabe für {name} ungültig:\n{}",
            schema::pretty(&issues)
        ));
    }
    Ok(args)
}
