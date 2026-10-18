//! Chat ohne API-Key über ein Agenten-CLI mit dem Login des Nutzers (claude-agent.ts): Claude Code (`claude -p`),
//! Codex (`codex exec`) oder Mistral Vibe (`vibe -p`). Jedes bekommt die Deck-Werkzeuge über einen lokalen MCP-Server
//! (dw-mcp, HTTP auf 127.0.0.1, Bearer-Token) im Prozess und sonst nichts: keine Shell, keine Dateiwerkzeuge. Ein
//! präpariertes Quelldokument kann so keine Befehle auf dem Rechner ausführen. Gleiche Ereignisse wie dw-agent.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dw_agent::{AgentEvent, CancellationToken, Effort, OnEvent, summary_of};
use dw_guide::Route;
use dw_mcp::Server;
use dw_tools::{ToolCtx, Tools};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cli {
    Claude,
    Codex,
    Vibe,
}

impl Cli {
    pub const ALL: [Cli; 3] = [Cli::Claude, Cli::Codex, Cli::Vibe];
    pub fn bin(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
            Cli::Vibe => "vibe",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Cli::Claude => "Claude Code",
            Cli::Codex => "Codex",
            Cli::Vibe => "Vibe",
        }
    }
}

/// Chat-Weg einer gespeicherten Modellwahl (models.ts `routeOf`): `vibe:<modell>`/`codex:<modell>` (leer = Voreinstellung
/// des CLI), sonst None = Claude (API-Key oder Claude Code). Diese IDs nie durch `model_of` schicken.
pub fn route_of(v: &str) -> Option<(Cli, String)> {
    let (cli, model) = v.split_once(':')?;
    let cli = match cli {
        "vibe" => Cli::Vibe,
        "codex" => Cli::Codex,
        _ => return None,
    };
    Some((cli, model.into()))
}

/// Programm im PATH, sonst in ~/.local/bin oder ~/.claude/local (fehlt im PATH, wenn die App vom Desktop startet)
pub fn find_cli(cli: Cli) -> Option<PathBuf> {
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(h) = home {
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join(".claude/local"));
    }
    // Windows: nur .exe, npm-Shims (.cmd) lassen sich ohne Shell nicht starten
    let file = if cfg!(windows) {
        format!("{}.exe", cli.bin())
    } else {
        cli.bin().into()
    };
    dirs.into_iter()
        .map(|d| d.join(&file))
        .find(|p| p.is_file())
}

const TOKEN_ENV: &str = "DECKWERK_MCP_TOKEN";

/// Laufender MCP-Server: Token nie auf der Kommandozeile (stünde in `ps`): für Claude Code in einer 0600-Datei,
/// für Codex und Vibe in einer Umgebungsvariable des Kindprozesses
pub struct Mcp {
    pub url: String,
    pub token: String,
    /// privater Ordner (0700) mit mcp.json und dem Systemprompt
    pub dir: PathBuf,
    task: tokio::task::JoinHandle<()>,
}

impl Mcp {
    pub fn config_file(&self) -> PathBuf {
        self.dir.join("mcp.json")
    }
    pub fn prompt_file(&self) -> PathBuf {
        self.dir.join("system.md")
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.dir); // Token-Datei nicht liegen lassen
    }
}

fn random_hex(n: usize) -> Result<String, String> {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Datei nur für den Nutzer lesbar schreiben
fn write_private(file: &Path, text: &str) -> Result<(), String> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    use std::io::Write;
    o.open(file)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| format!("{}: {e}", file.display()))
}

/// MCP-Server mit Zufallstoken starten und mcp.json (0600) in einen privaten Ordner schreiben
pub async fn serve(server: Server) -> Result<Mcp, String> {
    let token = random_hex(24)?;
    let (addr, task) = dw_mcp::serve_http(server, token.clone())
        .await
        .map_err(|e| e.to_string())?;
    let url = format!("http://{addr}/mcp");
    let dir = std::env::temp_dir().join(format!("deckwerk-{}", random_hex(8)?));
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let mcp = Mcp {
        url,
        token,
        dir,
        task,
    };
    let cfg = json!({"mcpServers": {"deckwerk": {"type": "http", "url": mcp.url, "headers": {"Authorization": format!("Bearer {}", mcp.token)}}}});
    write_private(&mcp.config_file(), &cfg.to_string())?;
    Ok(mcp)
}

/// Aufruf eines CLI
#[derive(Debug, Clone, PartialEq)]
pub struct Invocation {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// geht über stdin: kein Flag-Parsing von Nutzertext, nicht in `ps`, keine 128-KiB-Grenze je Argument
    pub stdin: String,
}

/// Aufruf je CLI. Alles, was die Werkzeuge einschränkt, steht hier; bei einer neuen CLI-Version zuerst das prüfen.
/// `msg` ist schon die fertige Nachricht (erste: mit Leitfaden); `core` der Kernprompt. Claude Code liest ihn aus
/// `mcp.prompt_file()` (der Aufrufer schreibt ihn dorthin).
#[allow(clippy::too_many_arguments)] // eine flache Liste wie invocation() in claude-agent.ts
pub fn invocation(
    cli: Cli,
    mcp: &Mcp,
    session: Option<&str>,
    model: &str,
    msg: &str,
    core: &str,
    legacy: bool,
    effort: Effort,
) -> Invocation {
    let s = |x: &str| x.to_string();
    match cli {
        // --setting-sources "": keine Hooks/Plugins aus den Settings des Nutzers, Login bleibt. --tools: nur Deck-Tools
        // plus Web-Recherche (nie `--tools ""`, das hängt). Ohne --effort nimmt Claude Code seine Voreinstellung (xhigh).
        Cli::Claude => {
            let mut a: Vec<String> = [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--setting-sources",
                "",
                "--disable-slash-commands",
                "--mcp-config",
            ]
            .map(s)
            .to_vec();
            a.push(mcp.config_file().display().to_string());
            a.extend(
                [
                    "--strict-mcp-config",
                    "--tools",
                    "WebSearch,WebFetch",
                    "--allowedTools",
                    "mcp__deckwerk,WebSearch,WebFetch",
                    "--system-prompt-file",
                ]
                .map(s),
            );
            a.push(mcp.prompt_file().display().to_string());
            a.extend([s("--model"), s(model)]);
            if let Some(id) = session {
                a.extend([s("--resume"), s(id)]);
            }
            a.extend([s("--effort"), s(effort.as_str())]);
            Invocation {
                args: a,
                env: vec![],
                stdin: msg.into(),
            }
        }
        // --ignore-user-config: weder MCP-Server noch Profile des Nutzers, nur unser Server (Login bleibt). Shell- und
        // Exec-Werkzeuge aus, Sandbox nur lesen, nie nachfragen. `exec resume` kennt --sandbox nicht, daher per -c.
        Cli::Codex => {
            let mut a = vec![s("exec")];
            if let Some(id) = session {
                a.extend([s("resume"), s(id)]);
            }
            a.extend(
                [
                    "--json",
                    "--skip-git-repo-check",
                    "--ignore-user-config",
                    "--ignore-rules",
                    "--disable",
                    "shell_tool",
                    "--disable",
                    "unified_exec",
                    "--disable",
                    "hooks",
                    "-c",
                    "sandbox_mode=\"read-only\"",
                    "-c",
                    "approval_policy=\"never\"",
                ]
                .map(s),
            );
            if !model.is_empty() {
                a.extend([s("-c"), format!("model={}", json!(model))]);
            }
            a.extend([
                s("-c"),
                format!("mcp_servers={{deckwerk={{url={},bearer_token_env_var=\"{TOKEN_ENV}\",tool_timeout_sec=300}}}}", json!(mcp.url)),
                s("-c"),
                // ponytail: Kernprompt als Argument (~17k Zeichen, Grenze 128 KiB); bei sehr langem Hausstil Datei nötig
                format!("developer_instructions={}", json!(core)),
                s("-"),
            ]);
            Invocation {
                args: a,
                env: vec![(TOKEN_ENV.into(), mcp.token.clone())],
                stdin: msg.into(),
            }
        }
        // VIBE_MCP_SERVERS ersetzt die MCP-Server des Nutzers durch unseren. --enabled-tools sperrt im -p-Modus alle
        // anderen Werkzeuge (Shell, Dateien); --auto-approve gilt nur für die freigegebenen. Einen eigenen Systemprompt nimmt
        // Vibe nur aus VIBE_HOME, daher steht er vor der ersten Nachricht. Ohne Update-Prüfung, Telemetrie und
        // Projektkontext startet Vibe in ~20 statt 30–60 s.
        Cli::Vibe => {
            let mut env: Vec<(String, String)> = [
                (TOKEN_ENV, mcp.token.as_str()),
                ("VIBE_ENABLE_CONNECTORS", "false"),
                ("VIBE_ENABLE_UPDATE_CHECKS", "false"),
                ("VIBE_ENABLE_TELEMETRY", "false"),
                ("VIBE_INCLUDE_PROJECT_CONTEXT", "false"),
                ("VIBE_ENABLE_NOTIFICATIONS", "false"),
            ]
            .map(|(k, v)| (s(k), s(v)))
            .to_vec();
            if !model.is_empty() {
                env.push((s("VIBE_ACTIVE_MODEL"), s(model)));
            }
            env.push((
                s("VIBE_MCP_SERVERS"),
                json!([{"name": "deckwerk", "transport": "streamable-http", "url": mcp.url, "api_key_env": TOKEN_ENV, "tool_timeout_sec": 300}]).to_string(),
            ));
            let mut a = vec![s("-p")];
            if legacy {
                a.push(s("--legacy-harness"));
            }
            a.extend(
                [
                    "--output",
                    "streaming",
                    "--enabled-tools",
                    "deckwerk_*",
                    "--enabled-tools",
                    "web_search",
                    "--enabled-tools",
                    "web_fetch",
                    "--auto-approve",
                    "--trust",
                ]
                .map(s),
            );
            if let Some(id) = session {
                a.extend([s("--resume"), s(id)]);
            }
            let stdin = if session.is_some() {
                msg.into()
            } else {
                format!("{core}\n\n---\n\nAnfrage:\n{msg}")
            };
            Invocation {
                args: a,
                env,
                stdin,
            }
        }
    }
}

/// Kennt dieses Programm den Schalter? (`--help`; ein CLI-Update ohne ihn darf den Chat nicht brechen)
async fn has_flag(bin: &Path, flag: &str) -> bool {
    let out = tokio::time::timeout(
        Duration::from_secs(20),
        Command::new(bin)
            .arg("--help")
            .stdin(Stdio::null())
            .output(),
    )
    .await;
    matches!(out, Ok(Ok(o)) if String::from_utf8_lossy(&o.stdout).contains(flag))
}

type Sink = Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<AgentEvent>>>>;

pub struct CliAgent {
    cli: Cli,
    bin: PathBuf,
    server: Server,
    sink: Sink,
    mcp: Option<Mcp>,
    /// Claude: Familie (opus, …); Codex/Vibe: deren Modell, leer = Voreinstellung. Pro Nachricht umschaltbar.
    pub model: String,
    /// nur Claude Code
    pub effort: Effort,
    /// Gesprächsverlauf liegt beim CLI (--resume bzw. exec resume)
    session: Option<String>,
    /// Vibe: IDs schon gezeigter Antworten; --resume spielt sie erneut aus
    seen: HashSet<String>,
    /// reiner Video-Auftrag, beim Gesprächsstart gesetzt
    video: bool,
    legacy: Option<bool>,
}

/// Zustand während eines Zugs
#[derive(Default)]
struct TurnState {
    result: bool,
    last_error: String,
    said: bool,
    web: Option<String>,
    /// Startzeit des Zugs in ms (Vibe: ältere Antworten nicht zeigen)
    since: f64,
    aborted: bool,
}

impl CliAgent {
    /// ctx wie für dw-mcp; die Werkzeuge gehören diesem Gespräch
    pub fn new(cli: Cli, bin: PathBuf, ctx: ToolCtx) -> CliAgent {
        let sink: Sink = Arc::default();
        let s = sink.clone();
        // Deck-Werkzeuge melden ihren Status selbst (withEvents in claude-agent.ts)
        let server = Server::new(dw_guide::with_guide(ctx)).with_observer(Arc::new(
            move |name: &str, r: Option<&Result<dw_tools::ToolOutput, String>>| {
                let ev = match r {
                    None => AgentEvent::ToolStart { name: name.into() },
                    Some(Ok(o)) => AgentEvent::ToolResult {
                        name: name.into(),
                        ok: true,
                        summary: summary_of(&o.text),
                    },
                    Some(Err(e)) => AgentEvent::ToolResult {
                        name: name.into(),
                        ok: false,
                        summary: e.split('\n').next().unwrap_or("").into(),
                    },
                };
                if let Some(tx) = s.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                    let _ = tx.send(ev);
                }
            },
        ));
        CliAgent {
            cli,
            bin,
            server,
            sink,
            mcp: None,
            model: if cli == Cli::Claude {
                dw_agent::DEFAULT_MODEL.into()
            } else {
                String::new()
            },
            effort: Effort::High,
            session: None,
            seen: HashSet::new(),
            video: false,
            legacy: None,
        }
    }

    pub fn tools(&self) -> &Tools {
        self.server.tools()
    }

    /// Noch keine Sitzung beim CLI: die nächste Nachricht ist die erste des Gesprächs (dann läuft der Router)
    pub fn fresh(&self) -> bool {
        self.session.is_none()
    }

    /// Ein Chat-Zug; route nur in der ersten Nachricht. Abbruch über `cancel` beendet die Prozessgruppe des CLI.
    pub async fn turn(
        &mut self,
        text: &str,
        route: Option<&Route>,
        cancel: &CancellationToken,
        on: OnEvent<'_>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        *self.sink.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        if self.cli != Cli::Claude {
            // Vibe und Codex denken oft minutenlang, bevor das erste Werkzeug läuft
            on(AgentEvent::ToolStart {
                name: "cli_run".into(),
            });
        }
        if let Err(e) = self.run(text, route, cancel, rx, on).await {
            on(AgentEvent::Error(e));
        }
        *self.sink.lock().unwrap_or_else(|e| e.into_inner()) = None;
        if self.cli != Cli::Claude {
            on(AgentEvent::ToolResult {
                name: "cli_run".into(),
                ok: true,
                summary: String::new(),
            });
        }
        on(AgentEvent::Done);
    }

    async fn run(
        &mut self,
        text: &str,
        route: Option<&Route>,
        cancel: &CancellationToken,
        mut tools_rx: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
        on: OnEvent<'_>,
    ) -> Result<(), String> {
        if self.mcp.is_none() {
            self.mcp = Some(serve(self.server.clone()).await?);
        }
        let store = &self.server.tools().ctx().store;
        if self.session.is_none() {
            self.video = route.is_some_and(|r| r.video);
        }
        let core = dw_guide::core_prompt(store, self.video);
        let msg = match (&self.session, dw_guide::leitfaden(store, route)) {
            (None, lead) if !lead.is_empty() => format!("{lead}\n\n{text}"),
            _ => text.to_string(),
        };
        if self.cli == Cli::Vibe && self.legacy.is_none() {
            self.legacy = Some(has_flag(&self.bin, "--legacy-harness").await);
        }
        let mcp = self.mcp.as_ref().ok_or("MCP-Server fehlt")?;
        if self.cli == Cli::Claude {
            write_private(&mcp.prompt_file(), &core)?;
        }
        let inv = invocation(
            self.cli,
            mcp,
            self.session.as_deref(),
            &self.model,
            &msg,
            &core,
            self.legacy == Some(true),
            self.effort,
        );
        // Sitzungen tauchen im jeweiligen CLI unter dem Datenordner auf
        let mut cmd = Command::new(&self.bin);
        cmd.args(&inv.args)
            .envs(inv.env.iter().map(|(k, v)| (k, v)))
            .current_dir(store.root())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0); // Abbruch trifft auch Kindprozesse des CLI
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("{} ließ sich nicht starten: {e}", self.cli.name()))?;
        let mut stdin = child.stdin.take().ok_or("stdin fehlt")?;
        let input = inv.stdin;
        tokio::spawn(async move {
            let _ = stdin.write_all(input.as_bytes()).await;
        });
        let mut stderr = child.stderr.take().ok_or("stderr fehlt")?;
        let err_task = tokio::spawn(async move {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s).await;
            let start = s.len().saturating_sub(2000);
            s[s.ceil_char_boundary(start)..].trim().to_string()
        });
        let mut lines = BufReader::new(child.stdout.take().ok_or("stdout fehlt")?).lines();
        let mut st = TurnState {
            since: now_ms(),
            ..Default::default()
        };
        loop {
            tokio::select! {
                // Werkzeug-Status vor der Textzeile, die danach kommt
                biased;
                _ = cancel.cancelled(), if !st.aborted => {
                    st.aborted = true;
                    stop(&mut child).await;
                }
                Some(ev) = tools_rx.recv() => on(ev),
                l = lines.next_line() => match l {
                    Ok(Some(line)) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&line) {
                            self.handle(&v, &mut st, on);
                        }
                    }
                    _ => break,
                },
            }
        }
        let code = child.wait().await.ok().and_then(|s| s.code());
        while let Ok(ev) = tools_rx.try_recv() {
            on(ev);
        }
        let stderr = err_task.await.unwrap_or_default();
        // Claude und Codex melden das Ende des Zugs selbst, Vibe nur über den Exit-Code
        if !st.result && !st.aborted && (self.cli != Cli::Vibe || code != Some(0)) {
            let why = [st.last_error, stderr]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or_else(|| "keine Ausgabe".into());
            let code = code.map_or("?".into(), |c| c.to_string());
            return Err(format!("{} beendet (Code {code}): {why}", self.cli.name()));
        }
        Ok(())
    }

    /// Eine JSON-Zeile des CLI in Ereignisse übersetzen
    fn handle(&mut self, v: &Value, st: &mut TurnState, on: OnEvent<'_>) {
        let ty = v["type"].as_str().unwrap_or("");
        match self.cli {
            Cli::Claude => {
                if let Some(id) = v["session_id"].as_str() {
                    self.session = Some(id.into());
                }
                let ev = &v["event"];
                // WebSearch/WebFetch sind eingebaute Werkzeuge, nicht über den MCP-Server: Status aus dem Stream
                if ty == "stream_event"
                    && ev["type"] == "content_block_start"
                    && ev["content_block"]["type"] == "tool_use"
                {
                    let web = match ev["content_block"]["name"].as_str() {
                        Some("WebSearch") => Some("web_search"),
                        Some("WebFetch") => Some("web_fetch"),
                        _ => None,
                    };
                    if let Some(w) = web {
                        st.web = Some(w.into());
                        on(AgentEvent::ToolStart { name: w.into() });
                    }
                }
                if ty == "user"
                    && let Some(w) = st.web.take()
                {
                    on(AgentEvent::ToolResult {
                        name: w,
                        ok: true,
                        summary: String::new(),
                    });
                }
                if ty == "stream_event"
                    && ev["type"] == "content_block_delta"
                    && ev["delta"]["type"] == "text_delta"
                {
                    on(AgentEvent::Text(
                        ev["delta"]["text"].as_str().unwrap_or("").into(),
                    ));
                }
                if ty == "result" {
                    st.result = true;
                    if v["is_error"] == true && !st.aborted {
                        let errs: Vec<&str> = v["errors"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect();
                        let msg = v["result"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                            .unwrap_or_else(|| {
                                if errs.is_empty() {
                                    format!("Claude Code: {}", v["subtype"].as_str().unwrap_or(""))
                                } else {
                                    errs.join("\n")
                                }
                            });
                        on(AgentEvent::Error(msg));
                    }
                }
            }
            Cli::Codex => {
                if ty == "thread.started"
                    && let Some(id) = v["thread_id"].as_str()
                {
                    self.session = Some(id.into());
                }
                if ty == "item.completed" && v["item"]["type"] == "agent_message" {
                    say(on, st, v["item"]["text"].as_str().unwrap_or(""));
                }
                // „Reconnecting …“ u. ä.: zählt erst, wenn der Zug scheitert
                if let ("error", Some(m)) = (ty, v["message"].as_str()) {
                    st.last_error = m.into();
                }
                if ty == "turn.completed" {
                    st.result = true;
                }
                if ty == "turn.failed" {
                    st.result = true;
                    let why = v["error"]["message"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .unwrap_or_else(|| {
                            if st.last_error.is_empty() {
                                "Anfrage fehlgeschlagen".into()
                            } else {
                                st.last_error.clone()
                            }
                        });
                    if !st.aborted {
                        on(AgentEvent::Error(
                            if why.contains("401") || why.contains("Unauthorized") {
                                "Codex ist nicht angemeldet. Einmal im Terminal `codex login` ausführen.".into()
                            } else {
                                format!("Codex: {why}")
                            },
                        ));
                    }
                }
            }
            Cli::Vibe => {
                if let Some(id) = v["sessionId"].as_str() {
                    self.session = Some(id.into());
                }
                // --resume spielt den bisherigen Verlauf erneut aus: nur Antworten aus dieser Anfrage zeigen
                let id = v["id"].as_str().unwrap_or("");
                let fresh = v["createdAt"].as_f64().is_none_or(|t| t >= st.since);
                if ty == "message"
                    && v["role"] == "assistant"
                    && v["generationStatus"] == "completed"
                    && !id.is_empty()
                    && fresh
                    && self.seen.insert(id.into())
                {
                    let t = match &v["content"] {
                        Value::String(s) => s.clone(),
                        Value::Array(a) => a.iter().filter_map(|p| p["text"].as_str()).collect(),
                        _ => String::new(),
                    };
                    say(on, st, &t);
                }
            }
        }
    }
}

fn say(on: OnEvent<'_>, st: &mut TurnState, t: &str) {
    if !t.is_empty() {
        on(AgentEvent::Text(if st.said {
            format!("\n\n{t}")
        } else {
            t.into()
        }));
        st.said = true;
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// SIGINT an die Prozessgruppe (Claude Code speichert die Sitzung), nach 5 s SIGKILL
async fn stop(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let pg = -(pid as i32);
        // SAFETY: kill() mit eigener Prozessgruppe, keine Speicherzugriffe
        unsafe { libc::kill(pg, libc::SIGINT) };
        if tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .is_err()
        {
            unsafe { libc::kill(pg, libc::SIGKILL) };
        } else {
            // Kindprozesse, die SIGINT überlebt haben
            unsafe { libc::kill(pg, libc::SIGKILL) };
        }
        return;
    }
    let _ = child.start_kill();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weg_aus_modellwahl() {
        assert_eq!(
            route_of("vibe:devstral"),
            Some((Cli::Vibe, "devstral".into()))
        );
        assert_eq!(route_of("codex:"), Some((Cli::Codex, String::new())));
        assert_eq!(route_of("claude-opus-5-5"), None);
        assert_eq!(route_of("opus"), None);
    }
}
