//! Ende zu Ende (scripts/mcp-e2e.ts): `dw-mcp` per stdio mit echter Engine (dw-daemon im Prozess), dazu die HTTP-Variante
//! mit Bearer-Token. initialize → tools/list → create_deck → add_slides → update_slide → lint_deck → export_deck png.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

fn home(name: &str) -> PathBuf {
    let d = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("dw-mcp-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

struct Mcp {
    child: Child,
    w: ChildStdin,
    r: BufReader<ChildStdout>,
    id: u64,
}

impl Mcp {
    fn start(home: &Path) -> Mcp {
        let mut child = Command::new(env!("CARGO_BIN_EXE_dw-mcp"))
            .env("DECKWERK_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let w = child.stdin.take().unwrap();
        let r = BufReader::new(child.stdout.take().unwrap());
        Mcp { child, w, r, id: 0 }
    }

    fn send(&mut self, v: Value) {
        writeln!(self.w, "{v}").unwrap();
        self.w.flush().unwrap();
    }

    fn req(&mut self, method: &str, params: Value) -> Value {
        self.id += 1;
        let id = self.id;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        loop {
            let mut line = String::new();
            assert!(self.r.read_line(&mut line).unwrap() > 0, "Server beendet");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["id"] == json!(id) {
                assert!(v.get("error").is_none(), "{method}: {v}");
                return v["result"].clone();
            }
        }
    }

    /// (Text, Bilder, isError)
    fn call(&mut self, name: &str, args: Value) -> (String, usize, bool) {
        let r = self.req("tools/call", json!({"name": name, "arguments": args}));
        let c = r["content"].as_array().unwrap();
        (
            c[0]["text"].as_str().unwrap().to_string(),
            c.iter().filter(|x| x["type"] == "image").count(),
            r["isError"] == json!(true),
        )
    }
}

#[test]
fn stdio_deck_bauen_und_exportieren() {
    let home = home("stdio");
    let mut m = Mcp::start(&home);
    let init = m.req("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "0"}}));
    let ins = init["instructions"].as_str().unwrap();
    assert!(
        ins.starts_with("# Deckwerk: Präsentationen aus einem Layout-Katalog")
            && ins[..2000.min(ins.len())].contains("read_guide")
    );
    m.send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    let tools = m.req("tools/list", json!({}))["tools"]
        .as_array()
        .unwrap()
        .clone();
    // mcp-smoke.ts/mcp-e2e.ts: 31 Basis, 32 Pro
    assert_eq!(tools.len(), if cfg!(feature = "pro") { 32 } else { 31 });
    let find = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap().clone();
    assert_eq!(find("generate_image")["annotations"]["readOnlyHint"], true);
    assert!(
        find("add_slides")
            .get("annotations")
            .is_none_or(|a| a.get("readOnlyHint").is_none())
    );
    assert_eq!(
        find("save_deck")["inputSchema"]["properties"]["name"]["maxLength"],
        60
    );

    let (t, img, err) = m.call(
        "create_deck",
        json!({"title": "E2E Test", "style": "sachlich"}),
    );
    assert!(!err && t.contains("Deck \"E2E Test\" angelegt"), "{t}");
    let _ = img; // Vorschau braucht kpi-grid/chart/section in dw-scene
    let (t, _, err) = m.call(
        "add_slides",
        json!({"slides": [
            {"layout": "cover", "content": {"title": "Wachstum mit Plan", "subtitle": "Ein Test über MCP"}},
            {"layout": "bullets", "content": {"title": "Drei Hebel für das nächste Jahr", "items": [{"text": "Vertrieb ausbauen"}, {"text": "Service verbessern"}, {"text": "Produkt schärfen"}]}}
        ]}),
    );
    assert!(!err, "{t}");
    let lines: Vec<&str> = t.lines().filter(|l| l.starts_with("Folie ")).collect();
    assert_eq!(lines.len(), 2, "{t}");
    for l in &lines {
        assert!(
            l.contains(" · Autofit head ") && l.contains("/body ") && l.contains(" · Übergang "),
            "{l}"
        );
    }
    assert!(
        lines[0].contains(", cover): ") && lines[1].contains(", bullets): "),
        "{t}"
    );
    let (t, _, err) = m.call("get_deck", json!({}));
    assert!(!err);
    let deck: Value = serde_json::from_str(&t).unwrap();
    let id = deck["slides"][1]["id"].as_str().unwrap().to_string();
    let (t, _, err) = m.call("update_slide", json!({"id": id, "content": {"items": [{"text": "Vertrieb"}, {"text": "Service"}, {"text": "Produkt"}, {"text": "Partner"}]}}));
    assert!(
        !err && t.starts_with(&format!("Folie 2 ({id}, bullets): ")) && t.contains("Autofit head "),
        "{t}"
    );
    let (t, _, err) = m.call("update_slide", json!({"id": id, "content": {"titel": "x"}}));
    assert!(err && t.contains("Unbekannte Felder: titel"), "{t}");
    let (t, _, err) = m.call("lint_deck", json!({}));
    assert!(
        !err && (t.starts_with("Keine Probleme") || t.contains(" Fehler, ")),
        "{t}"
    );
    let (t, n, err) = m.call("render_slides", json!({"ids": [id], "width": 640}));
    assert!(!err && n == 1 && t.starts_with("Folie 2 ("), "{t}");
    let (t, _, err) = m.call("export_deck", json!({"format": "png"}));
    assert!(!err && t.starts_with("Exportiert (png):\n"), "{t}");
    let pngs: Vec<&str> = t.lines().skip(1).collect();
    assert_eq!(pngs.len(), 2, "{t}");
    assert!(
        pngs.iter()
            .all(|p| Path::new(p).is_file() && p.ends_with(".png")),
        "{t}"
    );
    let (t, _, err) = m.call("save_deck", json!({"name": "x".repeat(61)}));
    assert!(
        err && t.starts_with(
            "Eingabe für save_deck ungültig:\n✖ Too big: expected string to have <=60 characters"
        ),
        "{t}"
    );
    let (t, _, err) = m.call("save_deck", json!({}));
    assert!(
        !err && t.starts_with("Gespeichert: ") && t.ends_with("deck.json"),
        "{t}"
    );
    let saved = t.trim_start_matches("Gespeichert: ").to_string();
    let (t, _, err) = m.call("open_deck", json!({"path": saved}));
    assert!(
        !err && t.starts_with("Geladen: \"E2E Test\", 2 Folien ("),
        "{t}"
    );
    let (t, _, err) = m.call("open_deck", json!({"path": "/etc/passwd"}));
    assert!(err, "{t}");
    let (t, _, err) = m.call("find_music", json!({"query": "calm piano"}));
    assert!(err && t.contains("noch nicht verfügbar"), "{t}");
    drop(m.w);
    let _ = m.child.wait();
    let _ = std::fs::remove_dir_all(&home);
}

/// HTTP-Anfrage ohne Client-Bibliothek: (Status, Body)
fn post(addr: &str, token: Option<&str>, body: &Value) -> (u16, String) {
    let mut s = std::net::TcpStream::connect(addr).unwrap();
    let b = body.to_string();
    let auth = token
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    write!(
        s,
        "POST /mcp HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-06-18\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n{b}",
        b.len()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let status = out.split(' ').nth(1).unwrap().parse().unwrap();
    (
        status,
        out.split_once("\r\n\r\n")
            .map(|x| x.1.to_string())
            .unwrap_or_default(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_nur_mit_token() {
    let home = home("http");
    let store = dw_store::Store::at(dw_store::Edition::Deckwerk, &home).unwrap();
    let engine = dw_mcp::engine(&store).unwrap();
    let server = dw_mcp::Server::new(dw_tools::ToolCtx::new(Box::new(engine), store));
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef".to_string();
    assert!(
        dw_mcp::serve_http(server.clone(), "kurz".into())
            .await
            .is_err()
    );
    let (addr, _task) = dw_mcp::serve_http(server, token.clone()).await.unwrap();
    assert!(addr.ip().is_loopback());
    let addr = addr.to_string();
    let init = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "0"}}});
    let a = addr.clone();
    let (st, _) = tokio::task::spawn_blocking(move || post(&a, None, &init))
        .await
        .unwrap();
    assert_eq!(st, 401);
    let a = addr.clone();
    let (st, _) = tokio::task::spawn_blocking(move || post(&a, Some("falsch"), &json!({})))
        .await
        .unwrap();
    assert_eq!(st, 401);
    let a = addr.clone();
    let t = token.clone();
    let list = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}});
    let (st, body) = tokio::task::spawn_blocking(move || post(&a, Some(&t), &list))
        .await
        .unwrap();
    assert_eq!(st, 200, "{body}");
    assert!(
        body.contains("\"create_deck\"") && body.contains("\"save_deck\""),
        "{body}"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn neu_verbinden_wenn_fremder_daemon_weg() {
    use dw_tools::Engine;
    let home = home("reconnect");
    // fremder Prozess mit Daemon (wie die App): ein zweites dw-mcp
    let mut other = Mcp::start(&home);
    let store = dw_store::Store::at(dw_store::Edition::Deckwerk, &home).unwrap();
    let sock = dw_daemon::socket_path(&store);
    let up = || {
        dw_daemon::Client::connect(&sock).is_ok_and(|mut c| {
            matches!(
                c.command(&dw_daemon::Cmd::Ping),
                Ok(dw_daemon::Reply::Pong { .. })
            )
        })
    };
    for _ in 0..300 {
        if up() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let e = dw_mcp::engine(&store).unwrap();
    assert!(!e.is_local());
    let deck: dw_model::Deck = serde_json::from_value(json!({"title": "R", "theme": {"id": "beratung"}, "slides": [{"id": "a", "layout": "cover", "content": {"title": "Hallo Welt"}}]})).unwrap();
    assert!(e.measure(&deck, &[0]).unwrap()[0].is_ok());
    other.child.kill().unwrap();
    other.child.wait().unwrap();
    // nächster Aufruf: neu verbinden, der Daemon läuft jetzt hier
    assert!(e.measure(&deck, &[0]).unwrap()[0].is_ok());
    assert!(e.is_local());
    let _ = std::fs::remove_dir_all(&home);
}
