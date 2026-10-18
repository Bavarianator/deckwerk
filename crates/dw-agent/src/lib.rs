//! KI-Chat über die Anthropic-API (agent.ts): Messages-API mit SSE-Streaming, eigener Tool-Runner über dw-tools,
//! Prompt-Caching (Systemprompt und erster Zug), Abbruch. Modelle als Familien (models.ts).
//!
//! Wiederholt wird nur die Modellanfrage (§7.2 K20): Jede Anfrage schickt die History mit den Ergebnissen schon
//! gelaufener Werkzeuge, ein neuer Versuch führt also kein Werkzeug ein zweites Mal aus.

pub mod router;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use dw_guide::Route;
use dw_tools::{ToolOutput, Tools, mime_of};
use futures_util::StreamExt;
use regex::Regex;
use serde_json::{Value, json};
pub use tokio_util::sync::CancellationToken;

/// Ereignisse eines Chat-Zugs für die Oberfläche. Deck-Änderungen, Rückfragen, Storyline und Look-Auswahl kommen
/// über die Rückrufe in `ToolCtx` (on_deck, ask, storyline, choice).
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    Text(String),
    ToolStart {
        name: String,
    },
    ToolResult {
        name: String,
        ok: bool,
        summary: String,
    },
    Error(String),
    /// immer das letzte Ereignis eines Zugs
    Done,
}

pub type OnEvent<'a> = &'a mut (dyn FnMut(AgentEvent) + Send);

// ---------- Modelle (models.ts) ----------

/// fallback = serverseitiger Refusal-Fallback, updates = Notizen zwischen Tool-Aufrufen, basic_search = nur einfache Websuche
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Model {
    pub id: &'static str,
    pub latest: &'static str,
    pub name: &'static str,
    pub hint: &'static str,
    pub fallback: bool,
    pub updates: bool,
    pub basic_search: bool,
}

const fn m(
    id: &'static str,
    latest: &'static str,
    name: &'static str,
    hint: &'static str,
    big: bool,
) -> Model {
    Model {
        id,
        latest,
        name,
        hint,
        fallback: big,
        updates: big,
        basic_search: !big,
    }
}

pub const MODELS: [Model; 4] = [
    m(
        "opus",
        "claude-opus-5-5",
        "Gründlich · Opus",
        "Für neue Decks, Design und große Umbauten",
        true,
    ),
    m(
        "sonnet",
        "claude-sonnet-5-5",
        "Schnell · Sonnet",
        "Für Änderungen an bestehenden Folien, deutlich schneller",
        true,
    ),
    m(
        "fable",
        "claude-fable-5-1",
        "Maximal · Fable",
        "Stärkstes Modell, deutlich langsamer und teurer",
        true,
    ),
    m(
        "haiku",
        "claude-haiku-5-5",
        "Sehr schnell · Haiku",
        "Nur für Kleinigkeiten wie Tippfehler",
        false,
    ),
];
pub const DEFAULT_MODEL: &str = "opus";
pub const AUTO: &str = "auto";

/// Familie zu einer Auswahl („opus“ oder von früher „claude-haiku-4-5“), Unbekanntes = Standardmodell.
/// Nie mit `vibe:`/`codex:`-IDs aufrufen (dw-cli-agent `route_of` zuerst).
pub fn model_of(id: &str) -> &'static Model {
    MODELS
        .iter()
        .find(|m| m.id == id || id.starts_with(&format!("claude-{}-", m.id)))
        .unwrap_or(&MODELS[0])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Effort {
    Low,
    Medium,
    #[default]
    High,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

/// „Auto“: neue Decks, Quellmaterial und Umbauten → Opus, gezielte Änderungen → Sonnet.
/// ponytail: Stichwort-Heuristik wie models.ts; bei Fehlgriffen wählt der Nutzer das Modell von Hand
pub fn auto_pick(text: &str, has_deck: bool) -> (&'static str, Effort) {
    static BIG: OnceLock<Regex> = OnceLock::new();
    let big = BIG.get_or_init(|| {
        Regex::new(r"(?i)erstell|präsentation|neues deck|storyline|überarbeit|umbau|alle folien|jede folie|komplett|looks?\b|design|quelle|anhang").unwrap()
    });
    if !has_deck || text.encode_utf16().count() > 600 || big.is_match(text) {
        ("opus", Effort::High)
    } else {
        ("sonnet", Effort::Medium)
    }
}

/// Kurztext eines Tool-Ergebnisses für Menschen: ohne die Bitte an die KI, es erneut aufzurufen, asset://-URLs als Dateiname
pub fn summary_of(text: &str) -> String {
    static AGAIN: OnceLock<Regex> = OnceLock::new();
    static ASSET: OnceLock<Regex> = OnceLock::new();
    let first = text.split('\n').next().unwrap_or("");
    let s = AGAIN
        .get_or_init(|| Regex::new(r"\s*Rufe dasselbe Tool.*$").unwrap())
        .replace(first, "");
    let s = ASSET
        .get_or_init(|| Regex::new(r"asset://local/\S*/([^/\s]+)").unwrap())
        .replace_all(&s, |c: &regex::Captures| percent_decode(&c[1]));
    // wie JS slice(0, 120) auf UTF-16
    let mut n = 0;
    s.chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= 120
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |x: u8| (x as char).to_digit(16);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2]))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    // ungültiges UTF-8: lieber den Rohtext zeigen
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

// ---------- Agent ----------

const MAX_ITERATIONS: usize = 80;
/// Versuche je Modellanfrage (Netz, 429, 5xx, Überlastung)
const ATTEMPTS: usize = 3;

pub struct Agent {
    tools: Arc<Tools>,
    http: reqwest::Client,
    key: String,
    /// ANTHROPIC_BASE_URL oder die API (Tests: Attrappe)
    pub base_url: String,
    /// Familie (opus, sonnet, …) oder Modell-ID, pro Nachricht umschaltbar
    pub model: String,
    pub effort: Effort,
    /// Vorschaubilder der gewählten Layouts im ersten Zug
    pub thumbnails: bool,
    /// Wartezeit vor dem n-ten neuen Versuch: n × retry_delay
    pub retry_delay: Duration,
    system: String,
    history: Vec<Value>,
}

impl Agent {
    /// Werkzeuge aus `ctx` (read_guide über dw-guide); key: sonst ANTHROPIC_API_KEY
    pub fn new(ctx: dw_tools::ToolCtx, key: Option<String>) -> Result<Agent, String> {
        let key = key
            .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
            .filter(|k| !k.is_empty())
            .ok_or("Kein Anthropic-API-Key (Einstellungen oder ANTHROPIC_API_KEY).")?;
        // rustls ohne Vorgabe: ring als Krypto einmal je Prozess setzen (zweiter Aufruf scheitert harmlos)
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let tools = Arc::new(Tools::new(dw_guide::with_guide(ctx)));
        let system = dw_guide::core_prompt(&tools.ctx().store, false);
        Ok(Agent {
            tools,
            http,
            key,
            base_url: std::env::var("ANTHROPIC_BASE_URL")
                .unwrap_or_else(|_| "https://api.anthropic.com".into()),
            model: DEFAULT_MODEL.into(),
            effort: Effort::High,
            thumbnails: true,
            retry_delay: Duration::from_secs(2),
            system,
            history: vec![],
        })
    }

    pub fn tools(&self) -> &Arc<Tools> {
        &self.tools
    }

    /// Noch keine Nachricht gesendet: dann soll der Aufrufer den Router fragen
    pub fn fresh(&self) -> bool {
        self.history.is_empty()
    }

    /// Ein Chat-Zug bis end_turn. route zählt nur in der ersten Nachricht. Abbruch über `cancel`: laufende Werkzeuge
    /// enden noch (ihre Ergebnisse bleiben in der History), dann `Done` ohne Fehler.
    pub async fn turn(
        &mut self,
        text: &str,
        route: Option<&Route>,
        cancel: &CancellationToken,
        on: OnEvent<'_>,
    ) {
        if self.fresh() {
            if route.is_some_and(|r| r.video) {
                self.system = dw_guide::core_prompt(&self.tools.ctx().store, true);
            }
            let thumbs = match route {
                Some(r) if self.thumbnails => thumbnails(&self.tools, &r.modules).await,
                _ => vec![],
            };
            let lead = dw_guide::leitfaden(&self.tools.ctx().store, route);
            self.history.push(first_turn(text, &lead, thumbs));
        } else {
            push_user(
                &mut self.history,
                vec![json!({"type": "text", "text": text})],
            );
        }
        if let Err(e) = self.run(cancel, on).await {
            on(AgentEvent::Error(e));
        }
        on(AgentEvent::Done);
    }

    async fn run(&mut self, cancel: &CancellationToken, on: OnEvent<'_>) -> Result<(), String> {
        for _ in 0..MAX_ITERATIONS {
            let Some(msg) = self.request(cancel, on).await? else {
                return Ok(()); // abgebrochen
            };
            let stop = msg.stop_reason.as_deref().unwrap_or("");
            let mut content = msg.blocks;
            if stop != "tool_use" {
                // angefangene Werkzeugaufrufe (max_tokens) ohne Ergebnis würden die nächste Anfrage brechen
                content.retain(|b| b["type"] != "tool_use");
            }
            let calls: Vec<Value> = content
                .iter()
                .filter(|b| b["type"] == "tool_use")
                .cloned()
                .collect();
            self.history
                .push(json!({"role": "assistant", "content": content}));
            match stop {
                "tool_use" => {
                    let results = run_tools(&self.tools, &calls, &msg.bad_input, on).await;
                    push_user(&mut self.history, results);
                    if cancel.is_cancelled() {
                        return Ok(());
                    }
                }
                "pause_turn" => {}
                "refusal" => {
                    let why = msg
                        .stop_details
                        .as_ref()
                        .and_then(|d| d["explanation"].as_str())
                        .map(|e| format!(": {e}"));
                    return Err(format!("Anfrage abgelehnt{}", why.unwrap_or_default()));
                }
                "max_tokens" => {
                    return Err("Antwort abgeschnitten (max_tokens). Bitte „weiter“ senden.".into());
                }
                _ => return Ok(()),
            }
        }
        Err(format!(
            "Mehr als {MAX_ITERATIONS} Schritte in einem Zug, abgebrochen. Bitte „weiter“ senden."
        ))
    }

    fn body(&self) -> (Value, Vec<&'static str>) {
        let m = model_of(&self.model);
        let model = if self.model.starts_with("claude-") {
            self.model.clone()
        } else {
            m.latest.into()
        };
        let mut tools: Vec<Value> = self
            .tools
            .list()
            .iter()
            .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.schema, "eager_input_streaming": true}))
            .collect();
        // Web-Recherche serverseitig; Haiku bekommt nur die Basis-Suche
        if m.basic_search {
            tools.push(json!({"type": "web_search_20250305", "name": "web_search", "max_uses": 5}));
        } else {
            tools.push(json!({"type": "web_search_20260209", "name": "web_search", "max_uses": 5}));
            tools.push(json!({"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 5}));
        }
        let mut thinking = json!({"type": "adaptive"});
        let mut betas = vec![];
        if m.updates {
            thinking["display"] = json!("updates");
            betas.push("thinking-display-updates-2026-08-18");
        }
        let mut body = json!({
            "model": model,
            "max_tokens": 64000,
            "stream": true,
            "thinking": thinking,
            // Opus 5.5 und Haiku 5.5 haben effort-Default medium, deshalb explizit
            "output_config": {"effort": self.effort.as_str()},
            "system": [{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral"}}],
            "tools": tools,
            "messages": self.history,
        });
        if m.fallback {
            body["fallbacks"] = json!("default");
            betas.push("server-side-fallback-2026-07-01");
        }
        (body, betas)
    }

    /// Eine Modellanfrage mit Wiederholung; None = abgebrochen
    async fn request(
        &self,
        cancel: &CancellationToken,
        on: OnEvent<'_>,
    ) -> Result<Option<Message>, String> {
        let (body, betas) = self.body();
        let body = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
        let mut last = String::new();
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                tokio::select! {
                    _ = cancel.cancelled() => return Ok(None),
                    _ = tokio::time::sleep(self.retry_delay * attempt as u32) => {}
                }
            }
            let mut req = self
                .http
                .post(format!(
                    "{}/v1/messages",
                    self.base_url.trim_end_matches('/')
                ))
                .header("x-api-key", &self.key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .body(body.clone());
            if !betas.is_empty() {
                req = req.header("anthropic-beta", betas.join(","));
            }
            let res = tokio::select! {
                _ = cancel.cancelled() => return Ok(None),
                r = req.send() => r,
            };
            let res = match res {
                Ok(r) => r,
                Err(e) => {
                    last = format!("Keine Verbindung zur Anthropic-API: {e}");
                    continue;
                }
            };
            let status = res.status().as_u16();
            if status != 200 {
                let text = res.text().await.unwrap_or_default();
                let msg = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(String::from))
                    .unwrap_or(text);
                last = format!("Anthropic-API antwortet {status}: {msg}");
                if status == 429 || status >= 500 {
                    continue;
                }
                return Err(last);
            }
            match read_stream(res, cancel, on).await {
                Ok(m) => return Ok(m),
                Err(Retry(e)) => last = e,
            }
        }
        Err(last)
    }
}

fn push_user(history: &mut Vec<Value>, blocks: Vec<Value>) {
    // nach einem Abbruch endet die History mit dem Nutzer: anhängen statt zwei Nutzer-Nachrichten
    if let Some(last) = history.last_mut().filter(|m| m["role"] == "user") {
        if let Some(s) = last["content"].as_str().map(String::from) {
            last["content"] = json!([{"type": "text", "text": s}]);
        }
        if let Some(c) = last["content"].as_array_mut() {
            c.extend(blocks);
            return;
        }
    }
    history.push(json!({"role": "user", "content": blocks}));
}

/// Erste Nachricht: Router-Module und Vorschaubilder vor dem Nutzertext; zweiter Cache-Breakpoint an ihrem Ende
fn first_turn(text: &str, lead: &str, thumbs: Vec<Value>) -> Value {
    let mut blocks = vec![];
    if !lead.is_empty() {
        blocks.push(json!({"type": "text", "text": lead}));
    }
    if !thumbs.is_empty() {
        blocks.extend(thumbs);
        blocks.push(json!({"type": "text", "text": "Vorschau der gewählten Layouts (typische Füllung, Theme beratung). Zeigt nur die Anordnung; Farbe, Schrift und Struktur kommen aus deinem eigenen Design. Nicht kommentieren."}));
    }
    if blocks.is_empty() {
        return json!({"role": "user", "content": text});
    }
    blocks.push(json!({"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}));
    json!({"role": "user", "content": blocks})
}

fn image(b: &[u8]) -> Value {
    json!({"type": "image", "source": {"type": "base64", "media_type": mime_of(b), "data": base64::engine::general_purpose::STANDARD.encode(b)}})
}

/// Beispiel-Deck (typ-Sample) der Layouts unter den Modulen (layout:<id>) rendern; Fehler → keine Bilder
async fn thumbnails(tools: &Arc<Tools>, modules: &[String]) -> Vec<Value> {
    use dw_tools::catalog::Layout;
    let want: Vec<&'static Layout> = modules
        .iter()
        .filter_map(|m| m.strip_prefix("layout:"))
        .filter_map(dw_tools::catalog::get)
        .collect();
    if want.is_empty() {
        return vec![];
    }
    let tools = tools.clone();
    let res = tokio::task::spawn_blocking(move || -> Result<Vec<Value>, String> {
        // Layouts mit sizes (A4, Flyer) im eigenen Format, sonst sähe die KI sie in 16:9; ein Deck je Format
        let fmt = |l: &Layout| l.sizes.as_ref().and_then(|s| s.first().cloned()).unwrap_or_else(|| "16:9".into());
        let mut fmts: Vec<String> = vec![];
        for l in &want {
            if !fmts.contains(&fmt(l)) {
                fmts.push(fmt(l));
            }
        }
        let mut pngs: Vec<(String, Vec<u8>)> = vec![];
        for f in fmts {
            let ids: Vec<&&Layout> = want.iter().filter(|l| fmt(l) == f).collect();
            let size = dw_model::format::format(&f).map_or((1280.0, 720.0), |x| (x.w, x.h));
            let deck: dw_model::Deck = serde_json::from_value(json!({
                "title": "Katalog", "theme": {"id": "beratung"}, "transition": "none", "mode": "click",
                "size": {"w": size.0, "h": size.1},
                "slides": ids.iter().map(|l| json!({"id": format!("cat-{}", l.id), "layout": l.id, "content": l.typ})).collect::<Vec<_>>(),
            }))
            .map_err(|e| e.to_string())?;
            let out = tools.ctx().engine.render_png(&deck, &(0..ids.len()).collect::<Vec<_>>(), 512)?;
            pngs.extend(ids.iter().map(|l| l.id.clone()).zip(out));
        }
        Ok(want
            .iter()
            .filter_map(|l| pngs.iter().find(|p| p.0 == l.id))
            .flat_map(|(id, png)| [json!({"type": "text", "text": format!("Layout {id}:")}), image(png)])
            .collect())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    res.unwrap_or_else(|e| {
        eprintln!("[agent] Vorschaubilder übersprungen: {e}");
        vec![]
    })
}

fn tool_result(id: &Value, r: &Result<ToolOutput, String>) -> Value {
    match r {
        Err(e) => json!({"type": "tool_result", "tool_use_id": id, "content": e, "is_error": true}),
        Ok(o) if o.images.is_empty() => {
            json!({"type": "tool_result", "tool_use_id": id, "content": o.text})
        }
        Ok(o) => {
            let mut c = vec![json!({"type": "text", "text": o.text})];
            c.extend(o.images.iter().map(|b| image(b)));
            json!({"type": "tool_result", "tool_use_id": id, "content": c})
        }
    }
}

enum Run {
    Start(usize),
    Done(usize, Result<ToolOutput, String>),
}

/// Werkzeuge einer Antwort: lesende gleichzeitig, ändernde der Reihe nach (sonst ginge eine Deck-Änderung verloren).
/// Ergebnisse in der Reihenfolge der Aufrufe, alle in einer Nutzer-Nachricht.
async fn run_tools(
    tools: &Arc<Tools>,
    calls: &[Value],
    bad: &[(String, String)],
    on: OnEvent<'_>,
) -> Vec<Value> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Run>();
    let mut writers = vec![];
    for (i, c) in calls.iter().enumerate() {
        let name = c["name"].as_str().unwrap_or("").to_string();
        let read_only = tools.list().iter().any(|t| t.name == name && t.read_only);
        let input = c["input"].clone();
        // unvollständiges JSON (eager_input_streaming) nie ausführen
        let broken = bad
            .iter()
            .find(|b| c["id"].as_str() == Some(b.0.as_str()))
            .map(|b| b.1.clone());
        let job = move |tools: &Tools| match broken {
            Some(e) => Err(format!(
                "INVALID_JSON: Die Eingabe war kein gültiges JSON ({e}). Rufe das Werkzeug mit vollständiger Eingabe erneut auf."
            )),
            None => tools.call(&name, input),
        };
        if read_only {
            let (tools, tx) = (tools.clone(), tx.clone());
            tokio::task::spawn_blocking(move || {
                let _ = tx.send(Run::Start(i));
                let _ = tx.send(Run::Done(i, job(&tools)));
            });
        } else {
            writers.push((i, job));
        }
    }
    {
        let tools = tools.clone();
        tokio::task::spawn_blocking(move || {
            for (i, job) in writers {
                let _ = tx.send(Run::Start(i));
                let _ = tx.send(Run::Done(i, job(&tools)));
            }
        });
    }
    let mut results: Vec<Option<Value>> = vec![None; calls.len()];
    while let Some(m) = rx.recv().await {
        let (Run::Start(i) | Run::Done(i, _)) = &m;
        let name = calls[*i]["name"].as_str().unwrap_or("").to_string();
        match m {
            Run::Start(_) => on(AgentEvent::ToolStart { name }),
            Run::Done(i, r) => {
                let (ok, summary) = match &r {
                    Ok(o) => (true, summary_of(&o.text)),
                    Err(e) => (false, e.split('\n').next().unwrap_or("").into()),
                };
                on(AgentEvent::ToolResult { name, ok, summary });
                results[i] = Some(tool_result(&calls[i]["id"], &r));
            }
        }
    }
    // abgestürztes Werkzeug: trotzdem ein Ergebnis je Aufruf, sonst lehnt die API die nächste Anfrage ab
    results
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            r.unwrap_or_else(|| tool_result(&calls[i]["id"], &Err("Werkzeug abgestürzt.".into())))
        })
        .collect()
}

// ---------- SSE ----------

struct Message {
    blocks: Vec<Value>,
    stop_reason: Option<String>,
    stop_details: Option<Value>,
    /// (tool_use_id, Fehler) für Aufrufe mit unvollständigem JSON
    bad_input: Vec<(String, String)>,
}

/// Fehler, nach dem dieselbe Anfrage noch einmal gestellt werden darf
struct Retry(String);

/// Antwort lesen, Text sofort melden; None = abgebrochen
async fn read_stream(
    res: reqwest::Response,
    cancel: &CancellationToken,
    on: OnEvent<'_>,
) -> Result<Option<Message>, Retry> {
    let mut stream = res.bytes_stream();
    let mut buf: Vec<u8> = vec![];
    let mut st = Stream::default();
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Ok(None),
            c = stream.next() => c,
        };
        match chunk {
            None => return Err(Retry("Antwort der Anthropic-API brach ab.".into())),
            Some(Err(e)) => return Err(Retry(format!("Antwort der Anthropic-API brach ab: {e}"))),
            Some(Ok(b)) => buf.extend(b.iter().filter(|&&c| c != b'\r')),
        }
        while let Some(end) = buf.windows(2).position(|w| w == b"\n\n") {
            let ev: Vec<u8> = buf.drain(..end + 2).collect();
            let data: String = String::from_utf8_lossy(&ev)
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|d| d.strip_prefix(' ').unwrap_or(d))
                .collect::<Vec<_>>()
                .join("\n");
            let Ok(v) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            if let Some(done) = st.event(&v, on)? {
                return Ok(Some(done));
            }
        }
    }
}

#[derive(Default)]
struct Stream {
    blocks: Vec<Value>,
    json: Vec<String>,
    stop_reason: Option<String>,
    stop_details: Option<Value>,
    bad: Vec<(String, String)>,
    /// schon Text gezeigt (Abstand vor Zwischennotizen)
    said: bool,
}

impl Stream {
    fn event(&mut self, v: &Value, on: OnEvent<'_>) -> Result<Option<Message>, Retry> {
        let i = v["index"].as_u64().unwrap_or(0) as usize;
        match v["type"].as_str().unwrap_or("") {
            "content_block_start" => {
                let b = v["content_block"].clone();
                let t = b["type"].as_str().unwrap_or("");
                // Web-Recherche läuft serverseitig: Status-Chip aus den Blöcken
                if t == "server_tool_use"
                    && matches!(b["name"].as_str(), Some("web_search" | "web_fetch"))
                {
                    on(AgentEvent::ToolStart {
                        name: b["name"].as_str().unwrap_or("").into(),
                    });
                } else if let Some(n) = t
                    .strip_suffix("_tool_result")
                    .filter(|n| *n == "web_search" || *n == "web_fetch")
                {
                    on(AgentEvent::ToolResult {
                        name: n.into(),
                        ok: true,
                        summary: String::new(),
                    });
                }
                while self.blocks.len() <= i {
                    self.blocks.push(Value::Null);
                    self.json.push(String::new());
                }
                self.blocks[i] = b;
            }
            "content_block_delta" => {
                let d = &v["delta"];
                let Some(b) = self.blocks.get_mut(i) else {
                    return Ok(None);
                };
                match d["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let t = d["text"].as_str().unwrap_or("");
                        append(b, "text", t);
                        if !t.is_empty() {
                            self.said = true;
                            on(AgentEvent::Text(t.into()));
                        }
                    }
                    // display "updates": Zwischennotizen vor Tool-Aufrufen kommen als thinking
                    "thinking_delta" => {
                        let t = d["thinking"].as_str().unwrap_or("");
                        let first = b["thinking"].as_str().is_none_or(str::is_empty);
                        append(b, "thinking", t);
                        if !t.is_empty() {
                            on(AgentEvent::Text(if self.said && first {
                                format!("\n\n{t}")
                            } else {
                                t.into()
                            }));
                        }
                    }
                    "signature_delta" => b["signature"] = d["signature"].clone(),
                    "input_json_delta" => {
                        self.json[i].push_str(d["partial_json"].as_str().unwrap_or(""))
                    }
                    "citations_delta" => {
                        if !b["citations"].is_array() {
                            b["citations"] = json!([]);
                        }
                        if let Some(c) = b["citations"].as_array_mut() {
                            c.push(d["citation"].clone());
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let Some(b) = self.blocks.get_mut(i) else {
                    return Ok(None);
                };
                let raw = std::mem::take(&mut self.json[i]);
                if matches!(b["type"].as_str(), Some("tool_use" | "server_tool_use"))
                    && !raw.is_empty()
                {
                    match serde_json::from_str::<Value>(&raw) {
                        Ok(x) if x.is_object() => b["input"] = x,
                        r => {
                            let e = r.map_or_else(|e| e.to_string(), |_| "kein Objekt".into());
                            self.bad.push((b["id"].as_str().unwrap_or("").into(), e));
                            b["input"] = json!({});
                        }
                    }
                }
            }
            "message_delta" => {
                if let Some(s) = v["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(s.into());
                }
                if !v["delta"]["stop_details"].is_null() {
                    self.stop_details = Some(v["delta"]["stop_details"].clone());
                }
            }
            "message_stop" => {
                return Ok(Some(Message {
                    blocks: std::mem::take(&mut self.blocks)
                        .into_iter()
                        .filter(|b| !b.is_null())
                        .collect(),
                    stop_reason: self.stop_reason.take(),
                    stop_details: self.stop_details.take(),
                    bad_input: std::mem::take(&mut self.bad),
                }));
            }
            // z. B. overloaded_error mitten im Stream: dieselbe Anfrage noch einmal
            "error" => {
                return Err(Retry(format!(
                    "Anthropic-API: {}",
                    v["error"]["message"].as_str().unwrap_or("Fehler im Stream")
                )));
            }
            _ => {}
        }
        Ok(None)
    }
}

fn append(b: &mut Value, key: &str, t: &str) {
    let s = format!("{}{t}", b[key].as_str().unwrap_or(""));
    b[key] = json!(s);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modelle_und_auto() {
        assert_eq!(model_of("claude-haiku-4-5").id, "haiku");
        assert_eq!(model_of("quatsch").id, "opus");
        assert_eq!(model_of("sonnet").latest, "claude-sonnet-5-5");
        assert_eq!(
            auto_pick("Tippfehler auf Folie 3", true),
            ("sonnet", Effort::Medium)
        );
        assert_eq!(auto_pick("Tippfehler", false).0, "opus");
        assert_eq!(auto_pick("Neues DESIGN bitte", true).0, "opus");
    }

    #[test]
    fn kurztext() {
        assert_eq!(
            summary_of("Fertig. Rufe dasselbe Tool gleich nochmal auf\nRest"),
            "Fertig."
        );
        assert_eq!(
            summary_of("Bild: asset://local/home/x/M%C3%BCnchen.jpg da"),
            "Bild: München.jpg da"
        );
        assert_eq!(summary_of(&"ä".repeat(200)).chars().count(), 120);
    }
}
