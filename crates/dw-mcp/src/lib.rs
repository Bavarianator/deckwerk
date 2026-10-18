//! MCP-Server für Claude Code, Codex und Vibe (mcp.ts, HTTP-Teil von claude-agent.ts): dieselben Werkzeuge wie der
//! App-Chat (dw-tools) plus get_deck/save_deck/open_deck. stdio für externe Agenten (`dw-mcp`), Streamable HTTP mit
//! Bearer-Token auf 127.0.0.1 für den CLI-Chat der App.
//!
//! Engine: Läuft für den Datenordner schon ein Daemon (App oder anderer MCP-Prozess), spricht der Server über dessen
//! Socket mit ihm (eine Engine je Datenordner, §3.4); sonst startet er den Daemon im eigenen Prozess und bietet ihn
//! selbst über den Socket an. So rechnet nie zweimal dieselbe Engine (Schriften, Render-Cache, eine Export-Queue).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use dw_daemon::{Client, Cmd, Daemon, ExportFormat, JobState, Reply};
use dw_model::{Deck, Measured};
use dw_store::Store;
use dw_tools::{Engine, Job, ToolCtx, ToolOutput, Tools, mime_of};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde_json::{Value, json};

/// Claude Code kürzt Server-Anweisungen auf rund 2.000 Zeichen: das Wesentliche zuerst, Module des Guides per read_guide
pub const INTRO: &str = r#"# Deckwerk: Präsentationen aus einem Layout-Katalog
Du wählst Layouts und füllst ihre Felder; Positionen, Schriftgrößen und Farben setzt die Engine. Setze nie Koordinaten.

**Lade vor der Arbeit mit `read_guide` die Module, die der Auftrag braucht.** Der Index steht unten (kommt er gekürzt an: `read_guide` ohne Eingabe). Neues Deck zum Beispiel: `read_guide({ module: ["storyline", "geruest-praesentation", "inhalt-layout", "gestaltung", "stil", "abwechslung", "text", "katalog-themes", "layout:cover", "layout:kpi-grid"] })`. Für andere Formate das passende Gerüst (geruest-social, geruest-a4, geruest-visitenkarte, geruest-stream), dazu jedes Layout, das du nutzt, als `layout:<id>`; bei Änderungen nur die betroffenen Module. Ohne das Schema eines Layouts rätst du Felder.

Ablauf: Briefing klären → Storyline als Liste der Titel → `propose_looks` oder direkt `create_deck` mit eigenem Design → `add_slides` in Batches von 4–6 Folien, Rückmeldungen (Autofit, Lint) sofort beheben → `render_overview` und `lint_deck`, schwächste Folien verbessern → `save_deck`.

Kernregeln:
- Eine Botschaft pro Folie; die Titel allein erzählen die Geschichte. Datenfolien: Aussage als Satz (max. ~80 Zeichen); Bühnenfolien (statement, big-number, photo) kurz, auch ein Wort oder eine Frage.
- Zurückhaltung statt Deko: keine Karten-Raster, keine Icons als Schmuck, keine Verläufe oder Sticker. Hierarchie über Größe und Weißraum, eine Akzentfarbe.
- Auf 4 Inhaltsfolien mindestens eine luftige Folie (statement, big-number, photo).
- Höchstens ~40 Wörter pro Folie, Details in die Speaker Notes.
- Stil (`style` in create_deck) nach Anlass wählen: mutig für Vortrag, Schule, Event, Kampagne; sachlich für Chef-Update, Antrag, Bericht. Neue Decks im Designtyp nicht wie die letzten (Modul abwechslung)."#;

// ---------- Engine über dw-daemon ----------

/// Daemon im eigenen Prozess oder fremder Daemon über den Socket
enum Conn {
    Local(Daemon),
    Remote(Client),
}

/// Engine über dw-daemon. Stirbt ein fremder Daemon (App beendet), verbindet der nächste Befehl neu
/// bzw. startet den Daemon im eigenen Prozess.
pub struct DaemonEngine {
    store: Store,
    conn: Mutex<Conn>,
}

impl DaemonEngine {
    /// true = Daemon läuft in diesem Prozess
    pub fn is_local(&self) -> bool {
        matches!(
            *self.conn.lock().unwrap_or_else(|e| e.into_inner()),
            Conn::Local(_)
        )
    }

    fn cmd(&self, c: Cmd) -> Result<Reply, String> {
        let mut conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let r = match &mut *conn {
            Conn::Local(d) => {
                let d = d.clone();
                drop(conn); // Render/Export nicht unter der Verbindungssperre
                d.command(c)
            }
            Conn::Remote(cl) => match cl.command(&c) {
                Ok(r) => r,
                Err(_) => {
                    // einmal neu: anderer Daemon, sonst eigener
                    *conn = connect(&self.store)
                        .map_err(|e| format!("Daemon nicht erreichbar: {e}"))?;
                    match &mut *conn {
                        Conn::Local(d) => {
                            let d = d.clone();
                            drop(conn);
                            d.command(c)
                        }
                        Conn::Remote(cl) => cl
                            .command(&c)
                            .map_err(|e| format!("Daemon nicht erreichbar: {e}"))?,
                    }
                }
            },
        };
        match r {
            Reply::Error { message } => Err(message),
            r => Ok(r),
        }
    }

    fn images(&self, c: Cmd) -> Result<Vec<Vec<u8>>, String> {
        match self.cmd(c)? {
            Reply::Images { png } => Ok(png),
            r => Err(format!("unerwartete Antwort: {r:?}")),
        }
    }
}

impl Engine for DaemonEngine {
    fn measure(
        &self,
        deck: &Deck,
        slides: &[usize],
    ) -> Result<Vec<Result<Measured, String>>, String> {
        match self.cmd(Cmd::Measure {
            deck: Box::new(deck.clone()),
            slides: slides.to_vec(),
        })? {
            Reply::Measures { measured } => Ok(measured),
            r => Err(format!("unerwartete Antwort: {r:?}")),
        }
    }
    fn render_png(
        &self,
        deck: &Deck,
        slides: &[usize],
        width: u32,
    ) -> Result<Vec<Vec<u8>>, String> {
        self.images(Cmd::Png {
            deck: Box::new(deck.clone()),
            slides: slides.to_vec(),
            width,
        })
    }
    fn render_overview(&self, deck: &Deck) -> Result<Vec<u8>, String> {
        self.images(Cmd::Overview {
            deck: Box::new(deck.clone()),
        })?
        .pop()
        .ok_or_else(|| "kein Bild".into())
    }
    fn export(&self, deck: &Deck, format: &str, out: &Path) -> Result<u64, String> {
        let f = match format {
            "png" => ExportFormat::Png,
            "pdf" => ExportFormat::Pdf,
            "pptx" => ExportFormat::Pptx,
            _ => return Err(format!("{format}: noch nicht verfügbar")),
        };
        match self.cmd(Cmd::Export {
            formats: vec![f],
            deck: Some(Box::new(deck.clone())),
            out: Some(out.to_path_buf()),
            timeout_s: None,
        })? {
            Reply::Job { id } => Ok(id),
            r => Err(format!("unerwartete Antwort: {r:?}")),
        }
    }
    fn job(&self, id: u64) -> Result<Job, String> {
        let Reply::Jobs { jobs } = self.cmd(Cmd::Jobs)? else {
            return Err("unerwartete Antwort".into());
        };
        let j = jobs
            .into_iter()
            .find(|j| j.id == id)
            .ok_or_else(|| format!("Job {id} ist unbekannt (Daemon neu gestartet?)"))?;
        let error = match j.state {
            JobState::Failed => Some(
                j.message
                    .clone()
                    .unwrap_or_else(|| "Export fehlgeschlagen".into()),
            ),
            JobState::Cancelled => Some("Export abgebrochen".into()),
            JobState::TimedOut => Some("Export hat das Zeitlimit überschritten".into()),
            _ => None,
        };
        let warnings = if j.state == JobState::Done {
            j.message
                .iter()
                .flat_map(|m| m.lines())
                .map(str::to_string)
                .collect()
        } else {
            vec![]
        };
        Ok(Job {
            done: j.state.finished(),
            pct: j.progress * 100.0,
            files: j.files,
            warnings,
            error,
        })
    }
}

/// Engine für den Datenordner: vorhandenen Daemon nutzen, sonst einen eigenen starten (siehe Moduldoku)
pub fn engine(store: &Store) -> anyhow::Result<DaemonEngine> {
    Ok(DaemonEngine {
        store: store.clone(),
        conn: Mutex::new(connect(store)?),
    })
}

fn connect(store: &Store) -> anyhow::Result<Conn> {
    let sock = dw_daemon::socket_path(store);
    for _ in 0..2 {
        if let Ok(mut c) = Client::connect(&sock)
            && matches!(c.command(&Cmd::Ping), Ok(Reply::Pong { .. }))
        {
            return Ok(Conn::Remote(c));
        }
        match dw_daemon::Server::bind(store.clone()) {
            Ok(server) => {
                let d = server.daemon().clone();
                std::thread::Builder::new()
                    .name("dw-daemon".into())
                    .spawn(move || {
                        if let Err(e) = server.run() {
                            eprintln!("[dw-mcp] Daemon-Socket: {e}");
                        }
                    })?;
                return Ok(Conn::Local(d));
            }
            // ein anderer Prozess war schneller: dessen Socket nehmen
            Err(dw_daemon::ServeError::Running(_)) => {
                std::thread::sleep(std::time::Duration::from_millis(300))
            }
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!(
        "Daemon für {} weder erreichbar noch startbar",
        store.root().display()
    )
}

// ---------- MCP-Server ----------

#[derive(Clone)]
pub struct Server {
    tools: Arc<Tools>,
    /// …/deck.json, None = noch nie gespeichert
    path: Arc<Mutex<Option<PathBuf>>>,
    observer: Option<Observer>,
}

/// Sieht jeden Werkzeugaufruf: (Name, None) davor, (Name, Some(Ergebnis)) danach (Status-Chips im App-Chat, dw-cli-agent)
pub type Observer = Arc<dyn Fn(&str, Option<&Result<ToolOutput, String>>) + Send + Sync>;

fn json_indent1(v: &Value) -> String {
    let mut out = vec![];
    let mut ser = serde_json::Serializer::with_formatter(
        &mut out,
        serde_json::ser::PrettyFormatter::with_indent(b" "),
    );
    serde::Serialize::serialize(v, &mut ser).ok();
    String::from_utf8(out).unwrap_or_default()
}

impl Server {
    pub fn new(ctx: ToolCtx) -> Server {
        Server {
            tools: Arc::new(Tools::new(ctx)),
            path: Arc::default(),
            observer: None,
        }
    }

    pub fn with_observer(mut self, f: Observer) -> Server {
        self.observer = Some(f);
        self
    }

    pub fn tools(&self) -> &Tools {
        &self.tools
    }

    fn store(&self) -> &Store {
        &self.tools.ctx().store
    }

    /// Server-Anweisungen: INTRO, dann der Kernprompt (Hook, sonst leer)
    pub fn instructions(&self) -> String {
        let core = self.tools.ctx().hooks.core_prompt();
        if core.is_empty() {
            INTRO.into()
        } else {
            format!("{INTRO}\n\n{core}")
        }
    }

    /// Alle Werkzeuge: dw-tools plus get_deck, save_deck, open_deck
    pub fn tool_list(&self) -> Vec<Tool> {
        let mcp = dw_tools::meta::all()
            .into_iter()
            .filter(|m| dw_tools::MCP_TOOLS.contains(&m.name))
            .map(|m| (m.name, m.description, (m.schema)(), m.read_only));
        self.tools
            .list()
            .iter()
            .map(|t| (t.name, t.description, t.schema.clone(), t.read_only))
            .chain(mcp)
            .map(|(name, d, schema, ro)| {
                let mut t = Tool::new(
                    name,
                    d,
                    Arc::new(schema.as_object().cloned().unwrap_or_default()),
                );
                if ro {
                    let mut a = ToolAnnotations::new();
                    a.read_only_hint = Some(true);
                    t.annotations = Some(a);
                }
                t
            })
            .collect()
    }

    /// Ein Werkzeugaufruf (blockiert: Engine und Jobs warten bis 240 s)
    pub fn call(&self, name: &str, args: Value) -> Result<ToolOutput, String> {
        let Some(f) = &self.observer else {
            return self.call_inner(name, args);
        };
        f(name, None);
        let r = self.call_inner(name, args);
        f(name, Some(&r));
        r
    }

    fn call_inner(&self, name: &str, args: Value) -> Result<ToolOutput, String> {
        let args = match dw_tools::meta::all()
            .into_iter()
            .find(|m| m.name == name && dw_tools::MCP_TOOLS.contains(&m.name))
        {
            Some(m) => dw_tools::check_input(name, &(m.schema)(), args)?,
            None => args,
        };
        match name {
            "get_deck" => Ok(match self.tools.deck() {
                None => ToolOutput::text("Noch kein Deck. Erst create_deck oder open_deck."),
                Some(d) => {
                    let mut v = serde_json::to_value(&d).unwrap_or_default();
                    if let Some(t) = v.get_mut("theme").and_then(Value::as_object_mut) {
                        t.remove("fontFiles");
                    }
                    let mut o = serde_json::Map::new();
                    o.insert("path".into(), json!(*self.path.lock().unwrap()));
                    o.extend(v.as_object().cloned().unwrap_or_default());
                    ToolOutput::text(json_indent1(&Value::Object(o)))
                }
            }),
            "save_deck" => {
                let _s = self.tools.serial();
                let d = self
                    .tools
                    .deck()
                    .ok_or("Es gibt noch kein Deck zum Speichern.")?;
                let name = args.get("name").and_then(Value::as_str);
                let mut path = self.path.lock().unwrap();
                let file = match (&*path, name) {
                    (Some(p), _) => self.store().save_deck(Some(p), &d),
                    (None, Some(n)) => self
                        .store()
                        .new_deck_dir(n)
                        .and_then(|dir| self.store().save_deck(Some(&dir.join("deck.json")), &d)),
                    (None, None) => self.store().save_deck(None, &d),
                }
                .map_err(|e| e.to_string())?;
                if let Some(dir) = file.parent() {
                    self.tools.set_out_dir(dir.to_path_buf());
                }
                *path = Some(file.clone());
                Ok(ToolOutput::text(format!("Gespeichert: {}", file.display())))
            }
            "open_deck" => {
                let _s = self.tools.serial();
                let p = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("path fehlt")?;
                let file = self
                    .store()
                    .deck_path(Path::new(p))
                    .map_err(|e| e.to_string())?;
                let mut d = self.store().load_deck(&file).map_err(|e| e.to_string())?;
                // fontFiles neu bestimmen: Pfade anderer Rechner, fehlende oder verwaiste Schriften
                let notes = self.tools.ctx().hooks.deck_fonts(&mut d);
                let list = d
                    .slides
                    .iter()
                    .map(|s| format!("{}:{}", s.id, s.layout))
                    .collect::<Vec<_>>()
                    .join(", ");
                let text = format!(
                    "Geladen: \"{}\", {} Folien ({list}){}",
                    d.title,
                    d.slides.len(),
                    if notes.is_empty() {
                        String::new()
                    } else {
                        format!("\nSchriften: {}", notes.join("; "))
                    }
                );
                self.tools.set_deck(d);
                if let Some(dir) = file.parent() {
                    self.tools.set_out_dir(dir.to_path_buf());
                }
                *self.path.lock().unwrap() = Some(file);
                Ok(ToolOutput::text(text))
            }
            // Neues Deck = neuer Ordner: sonst überschreibt save_deck das zuvor gespeicherte Deck
            "create_deck" | "create_episode" => self.tools.call_then(name, args, |_| {
                *self.path.lock().unwrap() = None;
                self.tools.set_out_dir(self.store().root().join("out"));
            }),
            _ => self.tools.call(name, args),
        }
    }
}

fn to_result(r: Result<ToolOutput, String>) -> CallToolResult {
    use base64::Engine as _;
    match r {
        Ok(out) => {
            let mut c = vec![ContentBlock::text(out.text)];
            c.extend(out.images.iter().map(|b| {
                ContentBlock::image(
                    base64::engine::general_purpose::STANDARD.encode(b),
                    mime_of(b),
                )
            }));
            CallToolResult::success(c)
        }
        Err(e) => CallToolResult::error(vec![ContentBlock::text(e)]),
    }
}

impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        let id = self.store().edition.id();
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(id, env!("CARGO_PKG_VERSION")))
            .with_instructions(self.instructions())
    }

    async fn list_tools(
        &self,
        _r: Option<PaginatedRequestParams>,
        _c: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: self.tool_list(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        r: CallToolRequestParams,
        _c: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let me = self.clone();
        let name = r.name.to_string();
        let args = r.arguments.map(Value::Object).unwrap_or(Value::Null);
        let res = tokio::task::spawn_blocking(move || me.call(&name, args))
            .await
            .unwrap_or_else(|e| Err(format!("Werkzeug abgestürzt: {e}")));
        Ok(to_result(res).into())
    }
}

/// stdio-Server bis der Client die Verbindung schließt
pub async fn serve_stdio(server: Server) -> anyhow::Result<()> {
    use rmcp::ServiceExt;
    let running = server.serve(rmcp::transport::stdio()).await?;
    running.waiting().await?;
    Ok(())
}

/// Bearer-Vergleich zeitkonstant (§7.1 S8)
fn authorized(header: Option<&hyper::header::HeaderValue>, token: &str) -> bool {
    use subtle::ConstantTimeEq;
    let want = format!("Bearer {token}");
    header.is_some_and(|h| h.as_bytes().ct_eq(want.as_bytes()).into())
}

/// Streamable HTTP auf 127.0.0.1 (Port frei gewählt) mit Bearer-Token; zustandslos wie claude-agent.ts.
/// Rückgabe: Adresse und die Aufgabe, die den Server bedient.
pub async fn serve_http(
    server: Server,
    token: String,
) -> anyhow::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
    use rmcp::transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService,
    };
    anyhow::ensure!(token.len() >= 32, "Token zu kurz (mindestens 32 Zeichen)");
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_max_request_body_bytes(8 << 20);
    let svc = StreamableHttpService::new(
        move || Ok(server.clone()),
        Arc::new(NeverSessionManager::default()),
        config,
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let addr = listener.local_addr()?;
    let token = Arc::new(token);
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                // z. B. zu viele offene Dateien: nicht heiß drehen
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            };
            let (svc, token) = (svc.clone(), token.clone());
            tokio::spawn(async move {
                let handler = hyper::service::service_fn(
                    move |req: hyper::Request<hyper::body::Incoming>| {
                        let (svc, token) = (svc.clone(), token.clone());
                        async move {
                            if !authorized(req.headers().get(hyper::header::AUTHORIZATION), &token)
                            {
                                use http_body_util::BodyExt;
                                let body = http_body_util::Full::new(hyper::body::Bytes::new())
                                    .map_err(|e| match e {})
                                    .boxed();
                                let mut res = hyper::Response::new(body);
                                *res.status_mut() = hyper::StatusCode::UNAUTHORIZED;
                                return Ok::<_, std::convert::Infallible>(res);
                            }
                            Ok(svc.handle(req).await)
                        }
                    },
                );
                let io = hyper_util::rt::TokioIo::new(stream);
                let _ = hyper::server::conn::http1::Builder::new()
                    .timer(hyper_util::rt::TokioTimer::new())
                    .header_read_timeout(std::time::Duration::from_secs(10))
                    .serve_connection(io, handler)
                    .await;
            });
        }
    });
    Ok((addr, task))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intro_unter_2kb_und_bearer() {
        // wörtlich wie mcp.ts INTRO (Fixture aus tools/list des TS-Servers)
        let fx: Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../dw-tools/tests/fixtures/tools-deckwerk.json"
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(fx["intro"].as_str(), Some(INTRO));
        assert!(INTRO.chars().count() < 2000, "{}", INTRO.chars().count());
        assert!(INTRO[..INTRO.len().min(2000)].contains("read_guide"));
        let tok = "a".repeat(48);
        assert!(authorized(
            Some(&format!("Bearer {tok}").parse().unwrap()),
            &tok
        ));
        assert!(!authorized(Some(&"Bearer x".parse().unwrap()), &tok));
        assert!(!authorized(None, &tok));
    }
}
