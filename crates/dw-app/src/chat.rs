//! Chat-Platz (Chat.tsx, AskBar.tsx). Die echte KI (dw-agent: Anthropic-API, `claude -p` mit MCP) kommt als
//! weitere Umsetzung von `ChatBackend`; bis dahin antwortet `Offline`.

use dw_model::Deck;

pub struct ChatReply {
    pub text: String,
    /// geändertes Deck; die App übernimmt es als einen Undo-Schritt
    pub deck: Option<Deck>,
    /// Fehler statt Antwort (rote Blase wie AskBar)
    pub error: bool,
}

/// Läuft in einem Hintergrund-Thread; `deck` ist der Stand beim Absenden.
pub trait ChatBackend: Send {
    fn ask(&mut self, deck: &Deck, prompt: &str) -> ChatReply;
}

pub struct Offline;

impl ChatBackend for Offline {
    fn ask(&mut self, _: &Deck, _: &str) -> ChatReply {
        ChatReply {
            text: "KI noch nicht verbunden. Bearbeite die Folie so lange unter „Anpassen“ im Inhalt.".into(),
            deck: None,
            error: true,
        }
    }
}
