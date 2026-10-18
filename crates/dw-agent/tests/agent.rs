//! Agent gegen eine Attrappe der Messages-API (SSE) und der Engine: Streaming, Werkzeuge, Wiederholung ohne doppelte
//! Ausführung, Abbruch, Anfrage-Inhalt. Keine echten API-Anfragen.

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dw_agent::{Agent, AgentEvent, CancellationToken, Effort};
use dw_model::{Deck, Measured};
use dw_store::{Edition, Store};
use dw_tools::{Engine, Job, ToolCtx};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Mock;
impl Engine for Mock {
    fn measure(&self, _: &Deck, s: &[usize]) -> Result<Vec<Result<Measured, String>>, String> {
        Ok(s.iter()
            .map(|_| {
                Ok(serde_json::from_value(
                    json!({"els": [], "fit": {"ok": true, "head": 0, "body": 1, "overflow": []}}),
                )
                .unwrap())
            })
            .collect())
    }
    fn render_png(&self, _: &Deck, s: &[usize], _: u32) -> Result<Vec<Vec<u8>>, String> {
        Ok(s.iter().map(|_| vec![0x89, 0x50, 0x4e, 0x47]).collect())
    }
    fn render_overview(&self, _: &Deck) -> Result<Vec<u8>, String> {
        Ok(vec![0x89, 0x50])
    }
    fn export(&self, _: &Deck, _: &str, _: &Path) -> Result<u64, String> {
        Err("nein".into())
    }
    fn job(&self, _: u64) -> Result<Job, String> {
        Err("nein".into())
    }
}

/// Antwort der Attrappe: Status und Rumpf (SSE oder JSON); `hang` = Stream bleibt offen
#[derive(Clone)]
struct Reply {
    status: u16,
    body: String,
    hang: bool,
}

fn sse(events: &[Value]) -> Reply {
    let body = events
        .iter()
        .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
        .collect();
    Reply {
        status: 200,
        body,
        hang: false,
    }
}

fn text_reply(t: &str) -> Reply {
    sse(&[
        json!({"type": "message_start", "message": {"id": "m1", "content": []}}),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": t}}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}}),
        json!({"type": "message_stop"}),
    ])
}

fn tool_reply(id: &str, name: &str, input: &str) -> Reply {
    let (a, b) = input.split_at(input.len() / 2);
    sse(&[
        json!({"type": "message_start", "message": {"id": "m0", "content": []}}),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Ich lege an."}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": id, "name": name, "input": {}}}),
        json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": a}}),
        json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": b}}),
        json!({"type": "content_block_stop", "index": 1}),
        json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
        json!({"type": "message_stop"}),
    ])
}

struct Api {
    url: String,
    /// (Kopfzeilen, Rumpf) je Anfrage
    seen: Arc<Mutex<Vec<(String, Value)>>>,
}

async fn api(replies: Vec<Reply>) -> Api {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    let seen: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let s = seen.clone();
    tokio::spawn(async move {
        for r in replies {
            let (mut c, _) = l.accept().await.unwrap();
            let mut buf = vec![];
            let mut tmp = [0u8; 65536];
            let (head, body) = loop {
                let n = c.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8_lossy(&buf[..p]).to_lowercase();
                let len: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                if buf.len() >= p + 4 + len {
                    break (
                        head,
                        serde_json::from_slice::<Value>(&buf[p + 4..p + 4 + len]).unwrap(),
                    );
                }
            };
            s.lock().unwrap().push((head, body));
            let ct = if r.status == 200 {
                "text/event-stream"
            } else {
                "application/json"
            };
            let len = if r.hang {
                String::new()
            } else {
                format!("content-length: {}\r\n", r.body.len())
            };
            let msg = format!(
                "HTTP/1.1 {} X\r\ncontent-type: {ct}\r\n{len}connection: close\r\n\r\n{}",
                r.status, r.body
            );
            c.write_all(msg.as_bytes()).await.unwrap();
            if r.hang {
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    drop(c);
                });
            }
        }
    });
    Api { url, seen }
}

fn agent(name: &str, url: &str, decks: Arc<AtomicU32>) -> Agent {
    agent_key(name, url, decks, Some("sk-test".into()))
}

fn agent_key(name: &str, url: &str, decks: Arc<AtomicU32>, key: Option<String>) -> Agent {
    let d = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("dw-agent-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    let mut ctx = ToolCtx::new(Box::new(Mock), Store::at(Edition::Deckwerk, &d).unwrap());
    ctx.on_deck = Some(Box::new(move |_| {
        decks.fetch_add(1, Ordering::Relaxed);
    }));
    let mut a = Agent::new(ctx, key).unwrap();
    a.base_url = url.into();
    a.retry_delay = Duration::from_millis(10);
    a
}

async fn turn(a: &mut Agent, text: &str, cancel: &CancellationToken) -> Vec<AgentEvent> {
    let mut ev = vec![];
    a.turn(text, None, cancel, &mut |e| ev.push(e)).await;
    ev
}

#[tokio::test(flavor = "multi_thread")]
async fn werkzeug_dann_text_mit_wiederholung_ohne_doppelte_ausfuehrung() {
    let api = api(vec![
        tool_reply(
            "tu_1",
            "create_deck",
            r#"{"title": "T", "style": "sachlich"}"#,
        ),
        Reply {
            status: 529,
            body: r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
                .into(),
            hang: false,
        },
        text_reply("Fertig."),
    ])
    .await;
    let decks = Arc::new(AtomicU32::new(0));
    let mut a = agent("tool", &api.url, decks.clone());
    a.effort = Effort::Medium;
    let ev = turn(&mut a, "Mach ein Deck", &CancellationToken::new()).await;
    assert_eq!(decks.load(Ordering::Relaxed), 1, "create_deck genau einmal");
    assert!(a.tools().deck().is_some());
    assert_eq!(ev[0], AgentEvent::Text("Ich lege an.".into()));
    assert_eq!(
        ev[1],
        AgentEvent::ToolStart {
            name: "create_deck".into()
        }
    );
    assert!(
        matches!(&ev[2], AgentEvent::ToolResult { name, ok: true, summary } if name == "create_deck" && summary.starts_with("Deck \"T\" angelegt")),
        "{:?}",
        ev[2]
    );
    assert_eq!(
        &ev[3..],
        [AgentEvent::Text("Fertig.".into()), AgentEvent::Done]
    );

    let seen = api.seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    let (head, b) = &seen[0];
    assert!(head.contains("x-api-key: sk-test") && head.contains("anthropic-version: 2023-06-01"));
    assert!(
        head.contains(
            "anthropic-beta: thinking-display-updates-2026-08-18,server-side-fallback-2026-07-01"
        ),
        "{head}"
    );
    assert_eq!(b["model"], "claude-opus-5-5");
    assert_eq!(b["stream"], true);
    assert_eq!(
        b["thinking"],
        json!({"type": "adaptive", "display": "updates"})
    );
    assert_eq!(b["output_config"], json!({"effort": "medium"}));
    assert_eq!(b["fallbacks"], "default");
    assert_eq!(
        b["system"][0]["cache_control"],
        json!({"type": "ephemeral"})
    );
    assert!(
        b["system"][0]["text"]
            .as_str()
            .unwrap()
            .contains("## Index: Module nach Bedarf")
    );
    let tools = b["tools"].as_array().unwrap();
    assert!(tools.iter().any(|t| t["name"] == "create_deck"
        && t["eager_input_streaming"] == true
        && t["input_schema"].is_object()));
    assert!(tools.iter().any(|t| t["type"] == "web_fetch_20260209"));
    assert_eq!(
        b["messages"],
        json!([{"role": "user", "content": "Mach ein Deck"}])
    );
    // Wiederholung: dieselbe History mit Werkzeugergebnis, Denkblock samt Signatur unverändert zurück
    assert_eq!(seen[1].1, seen[2].1);
    let m = seen[2].1["messages"].as_array().unwrap();
    assert_eq!(m.len(), 3);
    assert_eq!(
        m[1]["content"][0],
        json!({"type": "thinking", "thinking": "Ich lege an.", "signature": "sig"})
    );
    assert_eq!(
        m[1]["content"][1]["input"],
        json!({"title": "T", "style": "sachlich"})
    );
    assert_eq!(m[2]["content"][0]["tool_use_id"], "tu_1");
    assert!(m[2]["content"][0]["is_error"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn kaputtes_json_wird_nicht_ausgefuehrt_und_400_ist_fehler() {
    let api = api(vec![
        tool_reply("tu_x", "create_deck", r#"{"title": "T", "sty"#),
        Reply {
            status: 400,
            body: r#"{"type":"error","error":{"type":"invalid_request_error","message":"kaputt"}}"#
                .into(),
            hang: false,
        },
    ])
    .await;
    let decks = Arc::new(AtomicU32::new(0));
    let mut a = agent("bad", &api.url, decks.clone());
    a.model = "haiku".into();
    let ev = turn(&mut a, "x", &CancellationToken::new()).await;
    assert_eq!(decks.load(Ordering::Relaxed), 0);
    assert!(
        matches!(&ev[2], AgentEvent::ToolResult { ok: false, summary, .. } if summary.starts_with("INVALID_JSON")),
        "{ev:?}"
    );
    assert_eq!(
        ev[3],
        AgentEvent::Error("Anthropic-API antwortet 400: kaputt".into())
    );
    assert_eq!(ev.len(), 5);
    let seen = api.seen.lock().unwrap();
    assert_eq!(seen.len(), 2, "400 wird nicht wiederholt");
    let b = &seen[0].1;
    assert_eq!(b["model"], "claude-haiku-5-5");
    assert!(b["fallbacks"].is_null() && b["thinking"] == json!({"type": "adaptive"}));
    assert!(
        b["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["type"] == "web_search_20250305")
    );
    assert!(!seen[0].0.contains("anthropic-beta"));
}

#[tokio::test(flavor = "multi_thread")]
async fn abbruch_mitten_im_stream_dann_weiter() {
    let mut hang = text_reply("Hal");
    hang.body = hang
        .body
        .split("event: content_block_stop")
        .next()
        .unwrap()
        .into();
    hang.hang = true;
    let api = api(vec![hang, text_reply("Weiter.")]).await;
    let mut a = agent("cancel", &api.url, Arc::default());
    let cancel = CancellationToken::new();
    // abbrechen, sobald der erste Text da ist (nicht nach Zeit: auf voller Maschine zu früh)
    let (c, mut ev) = (cancel.clone(), vec![]);
    let mut on = |e: AgentEvent| {
        if matches!(e, AgentEvent::Text(_)) {
            c.cancel();
        }
        ev.push(e);
    };
    let go = a.turn("Eins", None, &cancel, &mut on);
    tokio::time::timeout(Duration::from_secs(10), go)
        .await
        .unwrap();
    assert_eq!(ev, [AgentEvent::Text("Hal".into()), AgentEvent::Done]);
    let ev = turn(&mut a, "Zwei", &CancellationToken::new()).await;
    assert_eq!(ev, [AgentEvent::Text("Weiter.".into()), AgentEvent::Done]);
    // abgebrochene Antwort fällt weg, beide Nutzertexte in einer Nachricht
    let seen = api.seen.lock().unwrap();
    assert_eq!(
        seen[1].1["messages"],
        json!([{"role": "user", "content": [{"type": "text", "text": "Eins"}, {"type": "text", "text": "Zwei"}]}])
    );
}

#[test]
fn ohne_key_kein_agent() {
    if std::env::var_os("ANTHROPIC_API_KEY").is_some() {
        return;
    }
    let d = Path::new(env!("CARGO_TARGET_TMPDIR")).join("dw-agent-nokey");
    assert!(
        Agent::new(
            ToolCtx::new(Box::new(Mock), Store::at(Edition::Deckwerk, &d).unwrap()),
            None
        )
        .is_err()
    );
}

/// Echter Zug gegen die API (kostet): DW_LIVE=1 ANTHROPIC_API_KEY=… cargo test -p dw-agent -- --ignored live
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live() {
    if std::env::var("DW_LIVE").as_deref() != Ok("1") {
        return;
    }
    let mut a = agent_key("live", "https://api.anthropic.com", Arc::default(), None);
    a.model = "haiku".into();
    a.effort = Effort::Low;
    let ev = turn(
        &mut a,
        "Lege ein Deck „Test“ mit Stil sachlich an und antworte mit einem Satz.",
        &CancellationToken::new(),
    )
    .await;
    eprintln!("{ev:?}");
    assert!(!ev.iter().any(|e| matches!(e, AgentEvent::Error(_))));
}
