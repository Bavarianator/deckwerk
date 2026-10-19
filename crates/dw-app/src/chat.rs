//! Chat-Platz (Chat.tsx, AskBar.tsx): Anthropic-API (dw-agent) oder Agenten-CLI mit MCP (dw-cli-agent), wie
//! agent.ts/claude-agent.ts. Die Modellwahl liegt in appData/deckwerk/chat-model (Electron: localStorage `dw.chat`).

use dw_agent::{AgentEvent, CancellationToken, Effort, router};
use dw_cli_agent::{Cli, CliAgent, find_cli, route_of};
use dw_model::Deck;
use dw_store::Store;

/// Auswahl im Modell-Menü und gespeicherte ID (models.ts); `codex:`/`vibe:` leer = Voreinstellung des CLI
pub const MODELS: [(&str, &str); 7] = [
    ("Auto", dw_agent::AUTO),
    ("Gründlich · Opus", "opus"),
    ("Schnell · Sonnet", "sonnet"),
    ("Maximal · Fable", "fable"),
    ("Sehr schnell · Haiku", "haiku"),
    ("Codex", "codex:"),
    ("Vibe", "vibe:"),
];

pub struct ChatReply {
    pub text: String,
    /// geändertes Deck; die App übernimmt es als einen Undo-Schritt
    pub deck: Option<Deck>,
    /// Fehler statt Antwort (rote Blase wie AskBar)
    pub error: bool,
}

enum Session {
    Api(dw_agent::Agent),
    Cli(CliAgent),
}

impl Session {
    fn tools(&self) -> &dw_tools::Tools {
        match self {
            Session::Api(a) => a.tools(),
            Session::Cli(c) => c.tools(),
        }
    }
}

pub struct Chat {
    store: Store,
    /// Gespräch samt Modell-ID, mit der es begann; andere ID = neues Gespräch auf dem passenden Weg
    session: Option<(String, Session)>,
    rt: Option<tokio::runtime::Runtime>,
}

fn file() -> Option<std::path::PathBuf> {
    dw_store::platform::app_data_dir().map(|d| d.join("deckwerk/chat-model"))
}

/// Index der gespeicherten Wahl, sonst Auto
pub fn load_model() -> i32 {
    let id = file().and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
    MODELS.iter().position(|m| m.1 == id.trim()).unwrap_or(0) as i32
}

pub fn save_model(i: i32) {
    let id = MODELS.get(i as usize).map_or(dw_agent::AUTO, |m| m.1);
    if let Some(f) = file() {
        let _ = std::fs::create_dir_all(f.parent().unwrap_or(&f)).and_then(|_| std::fs::write(&f, id));
    }
}

/// (Familie bzw. CLI-Modell, Effort); `vibe:`/`codex:` gehen unverändert ans CLI, nie durch model_of
fn pick(id: &str, text: &str, has_deck: bool) -> (String, Effort) {
    if let Some((_, m)) = route_of(id) {
        return (m, Effort::High);
    }
    if id == dw_agent::AUTO {
        let (m, e) = dw_agent::auto_pick(text, has_deck);
        return (m.into(), e);
    }
    (dw_agent::model_of(id).id.into(), Effort::High)
}

impl Chat {
    pub fn new(store: Store) -> Chat {
        Chat { store, session: None, rt: None }
    }

    fn open(&self, id: &str) -> Result<Session, String> {
        let ctx = || -> Result<_, String> {
            let engine = dw_mcp::engine(&self.store).map_err(|e| e.to_string())?;
            Ok(dw_tools::ToolCtx::new(Box::new(engine), self.store.clone()))
        };
        let cli = |c: Cli| -> Result<Session, String> {
            let bin = find_cli(c).ok_or(format!("{} ist nicht installiert.", c.name()))?;
            Ok(Session::Cli(CliAgent::new(c, bin, ctx()?)))
        };
        match route_of(id) {
            Some((c, _)) => cli(c),
            // Claude: API-Key, sonst Claude Code
            None => dw_agent::Agent::new(ctx()?, None).map(Session::Api).or_else(|_| cli(Cli::Claude)),
        }
    }

    /// Läuft in einem Hintergrund-Thread; `deck` ist der Stand beim Absenden.
    pub fn ask(&mut self, deck: &Deck, prompt: &str) -> ChatReply {
        let err = |text: String| ChatReply { text, deck: None, error: true };
        let id = MODELS[load_model() as usize].1;
        if self.session.as_ref().is_none_or(|s| s.0 != id) {
            match self.open(id) {
                Ok(s) => self.session = Some((id.into(), s)),
                Err(e) => return err(e),
            }
        }
        if self.rt.is_none() {
            match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => self.rt = Some(rt),
                Err(e) => return err(e.to_string()),
            }
        }
        let (Some((_, s)), Some(rt)) = (self.session.as_mut(), self.rt.as_ref()) else {
            return err("Chat nicht bereit".into());
        };
        let has_deck = !deck.slides.is_empty();
        let (model, effort) = pick(id, prompt, has_deck);
        s.tools().set_deck(deck.clone());
        let fresh = match s {
            Session::Api(a) => a.fresh(),
            Session::Cli(c) => c.fresh(),
        };
        let layouts: Vec<String> = deck.slides.iter().map(|s| s.layout.clone()).collect();
        // ponytail: Regel-Router statt Haiku-Router (router::route); Module reichen für den Leitfaden
        let route = fresh.then(|| {
            router::rule_route(&router::Input {
                text: prompt,
                profile: dw_model::profile_of(deck.size),
                layouts_in_deck: &layouts,
                has_deck,
                podcast: false,
            })
            .route
        });
        let (mut text, mut failed) = (String::new(), None::<String>);
        let mut on = |ev: AgentEvent| match ev {
            AgentEvent::Text(t) => text.push_str(&t),
            AgentEvent::Error(e) => failed = Some(e),
            _ => {}
        };
        let cancel = CancellationToken::new();
        match s {
            Session::Api(a) => {
                (a.model, a.effort) = (model, effort);
                rt.block_on(a.turn(prompt, route.as_ref(), &cancel, &mut on));
            }
            Session::Cli(c) => {
                (c.model, c.effort) = (model, effort);
                rt.block_on(c.turn(prompt, route.as_ref(), &cancel, &mut on));
            }
        }
        let changed = s.tools().deck().filter(|d| d != deck);
        match failed {
            Some(e) => ChatReply { text: e, deck: changed, error: true },
            None => ChatReply { text, deck: changed, error: false },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_ids_bleiben() {
        assert_eq!(pick("vibe:devstral", "x", true).0, "devstral");
        assert_eq!(pick("codex:", "x", true).0, "");
        assert_eq!(pick("haiku", "x", true).0, "haiku");
        assert_eq!(pick("claude-sonnet-5-5", "x", true).0, "sonnet");
        assert!(MODELS.iter().all(|m| route_of(m.1).is_some() || dw_agent::model_of(m.1).id == m.1 || m.1 == dw_agent::AUTO));
    }

    /// Echte Anfrage über `claude -p` + lokalen MCP (kostet eine Anfrage):
    /// `XDG_CONFIG_HOME=<tmp> DECKWERK_HOME=<tmp> cargo test -p dw-app chat_ueber_mcp -- --ignored`
    #[test]
    #[ignore]
    fn chat_ueber_mcp() {
        save_model(MODELS.iter().position(|m| m.1 == "haiku").unwrap() as i32);
        let store = Store::open(dw_store::Edition::from_env()).unwrap();
        let deck: Deck = serde_json::from_value(serde_json::json!({ "title": "MCP-Test", "theme": { "id": "beratung" }, "slides": [] })).unwrap();
        let r = Chat::new(store).ask(&deck, "Füge genau eine Folie mit Layout cover und Titel „Hallo aus Rust“ hinzu. Keine Rückfragen.");
        assert!(!r.error, "{}", r.text);
        assert!(r.deck.is_some_and(|d| !d.slides.is_empty()), "kein Deck zurück: {}", r.text);
    }
}
