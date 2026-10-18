//! CliAgent gegen ein falsches `claude` (Python-Skript): liest MCP-Config und Systemprompt, ruft create_deck über den
//! lokalen MCP-Server auf, schreibt stream-json. Dazu Abbruch (Prozessgruppe) und Aufrufe von Codex und Vibe.
//! Kein echtes CLI, keine Anfragen.

use std::path::{Path, PathBuf};
use std::time::Duration;

use dw_agent::{AgentEvent, CancellationToken, Effort};
use dw_cli_agent::{Cli, CliAgent};
use dw_model::{Deck, Measured};
use dw_store::{Edition, Store};
use dw_tools::{Engine, Job, ToolCtx};
use serde_json::json;

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
        Ok(s.iter().map(|_| vec![0x89, 0x50]).collect())
    }
    fn render_overview(&self, _: &Deck) -> Result<Vec<u8>, String> {
        Ok(vec![])
    }
    fn export(&self, _: &Deck, _: &str, _: &Path) -> Result<u64, String> {
        Err("nein".into())
    }
    fn job(&self, _: u64) -> Result<Job, String> {
        Err("nein".into())
    }
}

const FAKE: &str = r#"#!/usr/bin/env python3
import json, os, stat, sys, subprocess, time, urllib.request
a = sys.argv[1:]
cfg_file = a[a.index('--mcp-config') + 1]
sys_file = a[a.index('--system-prompt-file') + 1]
srv = json.load(open(cfg_file))['mcpServers']['deckwerk']
msg = sys.stdin.read()
def out(o): print(json.dumps(o), flush=True)
out({'type': 'system', 'subtype': 'init', 'session_id': 'sess-1'})
def text(t): out({'type': 'stream_event', 'session_id': 'sess-1', 'event': {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': t}}})
if 'Abbrechen' in msg:
    p = subprocess.Popen(['sleep', '30'])
    open(os.environ['DW_PID_FILE'], 'w').write(str(p.pid))
    text('warte')
    time.sleep(30)
    sys.exit(0)
h = {'Authorization': srv['headers']['Authorization'], 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
def rpc(body, extra={}):
    r = urllib.request.urlopen(urllib.request.Request(srv['url'], json.dumps(body).encode(), {**h, **extra}))
    t = r.read().decode()
    return json.loads(t) if t else None
init = rpc({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'fake', 'version': '0'}}})
pv = {'MCP-Protocol-Version': init['result']['protocolVersion']}
rpc({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, pv)
res = rpc({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'create_deck', 'arguments': {'title': 'Fake', 'style': 'sachlich'}}}, pv)
try:
    urllib.request.urlopen(urllib.request.Request(srv['url'], b'{}', {**h, 'Authorization': 'Bearer falsch'}))
    bad = 'offen'
except urllib.error.HTTPError as e:
    bad = str(e.code)
modes = '%o/%o' % (stat.S_IMODE(os.stat(cfg_file).st_mode), stat.S_IMODE(os.stat(sys_file).st_mode))
resume = a[a.index('--resume') + 1] if '--resume' in a else '-'
first = 'leitfaden' if msg.startswith('<leitfaden>') else 'ohne'
text('ok:' + res['result']['content'][0]['text'].split('\n')[0][:20])
text('|%s|%s|%s|%s|%s|%s|%s' % (bad, modes, resume, a[a.index('--model') + 1], a[a.index('--effort') + 1], first, 'Index' in open(sys_file).read()))
out({'type': 'user', 'session_id': 'sess-1'})
out({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'fertig', 'session_id': 'sess-1'})
"#;

fn setup(name: &str) -> (PathBuf, CliAgent) {
    let d = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("dw-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    let bin = d.join("claude");
    std::fs::write(&bin, FAKE).unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let store = Store::at(Edition::Deckwerk, &d.join("home")).unwrap();
    (
        d,
        CliAgent::new(Cli::Claude, bin, ToolCtx::new(Box::new(Mock), store)),
    )
}

async fn turn(
    a: &mut CliAgent,
    text: &str,
    route: Option<&dw_guide::Route>,
    cancel: &CancellationToken,
) -> Vec<AgentEvent> {
    let mut ev = vec![];
    a.turn(text, route, cancel, &mut |e| ev.push(e)).await;
    ev
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_zug_mit_mcp_aufruf_und_resume() {
    let (_d, mut a) = setup("zug");
    a.effort = Effort::Medium;
    let route = dw_guide::Route {
        modules: vec!["stil".into()],
        video: false,
    };
    let ev = turn(
        &mut a,
        "Mach ein Deck",
        Some(&route),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(
        ev[0],
        AgentEvent::ToolStart {
            name: "create_deck".into()
        }
    );
    assert!(
        matches!(&ev[1], AgentEvent::ToolResult { name, ok: true, .. } if name == "create_deck"),
        "{ev:?}"
    );
    assert_eq!(ev[2], AgentEvent::Text("ok:Deck \"Fake\" angelegt".into()));
    assert_eq!(
        ev[3],
        AgentEvent::Text("|401|600/600|-|opus|medium|leitfaden|True".into())
    );
    assert_eq!(ev[4], AgentEvent::Done);
    assert_eq!(ev.len(), 5);
    assert_eq!(a.tools().deck().unwrap().title, "Fake");
    assert!(!a.fresh());
    let ev = turn(&mut a, "Noch was", Some(&route), &CancellationToken::new()).await;
    assert_eq!(
        ev[3],
        AgentEvent::Text("|401|600/600|sess-1|opus|medium|ohne|True".into())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn abbruch_beendet_prozessgruppe() {
    let (d, mut a) = setup("abbruch");
    let pid_file = d.join("pid");
    // ponytail: Umgebung des Testprozesses, die das Kind erbt; nur dieser Test liest sie
    unsafe { std::env::set_var("DW_PID_FILE", &pid_file) };
    let cancel = CancellationToken::new();
    let c = cancel.clone();
    let pf = pid_file.clone();
    tokio::spawn(async move {
        while !pf.exists() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        c.cancel();
    });
    let ev = tokio::time::timeout(
        Duration::from_secs(15),
        turn(&mut a, "Abbrechen bitte", None, &cancel),
    )
    .await
    .unwrap();
    assert_eq!(ev, [AgentEvent::Text("warte".into()), AgentEvent::Done]);
    let pid = std::fs::read_to_string(&pid_file).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let state = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
    // weg oder Zombie (Elternprozess schon beendet): das sleep des CLI läuft nicht weiter
    assert!(state.is_empty() || state.contains(") Z"), "{state}");
}

#[test]
fn aufrufe_codex_und_vibe_sperren_werkzeuge() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (d, _) = setup("aufruf");
    let ctx = ToolCtx::new(
        Box::new(Mock),
        Store::at(Edition::Deckwerk, &d.join("home")).unwrap(),
    );
    let mcp = rt
        .block_on(dw_cli_agent::serve(dw_mcp::Server::new(ctx)))
        .unwrap();
    let c = dw_cli_agent::invocation(
        Cli::Codex,
        &mcp,
        Some("t1"),
        "",
        "Hallo",
        "KERN",
        false,
        Effort::High,
    );
    assert_eq!(&c.args[..3], ["exec", "resume", "t1"]);
    assert!(c.args.windows(2).any(|w| w == ["--disable", "shell_tool"]));
    assert!(
        c.args
            .contains(&"developer_instructions=\"KERN\"".to_string())
    );
    assert!(
        !c.args.iter().any(|x| x.contains(&mcp.token)),
        "Token nie als Argument"
    );
    assert_eq!(
        c.env,
        [("DECKWERK_MCP_TOKEN".to_string(), mcp.token.clone())]
    );
    assert_eq!(c.stdin, "Hallo");
    let v = dw_cli_agent::invocation(
        Cli::Vibe,
        &mcp,
        None,
        "devstral",
        "Hallo",
        "KERN",
        true,
        Effort::High,
    );
    assert_eq!(&v.args[..2], ["-p", "--legacy-harness"]);
    assert!(
        v.args
            .windows(2)
            .any(|w| w == ["--enabled-tools", "deckwerk_*"])
    );
    assert_eq!(v.stdin, "KERN\n\n---\n\nAnfrage:\nHallo");
    assert!(
        v.env.iter().any(|(k, x)| k == "VIBE_MCP_SERVERS"
            && x.contains(&mcp.url)
            && !x.contains(&mcp.token))
    );
    let k = dw_cli_agent::invocation(
        Cli::Claude,
        &mcp,
        None,
        "sonnet",
        "Hallo",
        "KERN",
        false,
        Effort::Low,
    );
    assert!(!k.args.iter().any(|x| x.contains(&mcp.token) || x == "KERN"));
    assert!(
        k.args
            .windows(2)
            .any(|w| w == ["--tools", "WebSearch,WebFetch"])
    );
}

/// Echter Zug über `claude -p` (kostet): DW_LIVE=1 cargo test -p dw-cli-agent -- --ignored live
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn live() {
    if std::env::var("DW_LIVE").as_deref() != Ok("1") {
        return;
    }
    let (d, _) = setup("live");
    let store = Store::at(Edition::Deckwerk, &d.join("home")).unwrap();
    let bin = dw_cli_agent::find_cli(Cli::Claude).expect("claude fehlt");
    let mut a = CliAgent::new(Cli::Claude, bin, ToolCtx::new(Box::new(Mock), store));
    a.model = "haiku".into();
    a.effort = Effort::Low;
    let ev = turn(
        &mut a,
        "Lege ein Deck „Test“ mit Stil sachlich an und antworte mit einem Satz.",
        None,
        &CancellationToken::new(),
    )
    .await;
    eprintln!("{ev:?}");
    assert!(a.tools().deck().is_some());
}
