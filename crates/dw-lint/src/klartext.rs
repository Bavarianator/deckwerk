//! Technische Fehler aus API, Claude Code, Codex und Vibe → ein Satz für Laien (klartext.ts). Unbekanntes: `None`.

use std::sync::LazyLock;

use regex::Regex;

// \b in JS ist ASCII, daher (?-u:\b)
static REGELN: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"credit balance is too low|insufficient{DOT}?(credit|balance|quota)|billing", "Dein Guthaben beim KI-Anbieter ist aufgebraucht. Lade es dort auf oder wähle in der Einrichtung einen anderen Zugang."),
        (r"not logged in|please run /login|/login|oauth token (has )?expired|login required", "Claude Code ist nicht angemeldet. Öffne ein Terminal, gib claude ein und melde dich im Browser an."),
        (r"codex ist nicht angemeldet", "Codex ist nicht angemeldet. Öffne ein Terminal, gib codex login ein und melde dich im Browser an."),
        (r"invalid x-api-key|invalid api key|authentication_error|(?-u:\b)401(?-u:\b)|unauthorized", "Der KI-Zugang wurde abgelehnt. Prüf in der Einrichtung unter „KI-Zugang“ deinen API-Schlüssel oder melde dich neu an."),
        (r"usage limit|limit reached|rate{DOT}?limit|(?-u:\b)429(?-u:\b)|too many requests", "Für den Moment sind zu viele Anfragen gelaufen, oder das Limit deines Abos ist erreicht. Warte kurz und versuch es noch einmal."),
        (r"overloaded|(?-u:\b)529(?-u:\b)|(?-u:\b)503(?-u:\b)|service unavailable", "Die KI ist gerade überlastet. Versuch es in einer Minute noch einmal."),
        (r"ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|getaddrinfo|network ?error", "Keine Verbindung zur KI. Prüf deine Internetverbindung."),
    ]
    .into_iter()
    // JS ohne u-Flag: Groß/klein nur ASCII (kein ſ/K-Kelvin), `.` ohne \n, \r, U+2028, U+2029
    .map(|(re, msg)| (Regex::new(&format!("(?i-u){}", re.replace("{DOT}", r"(?u:[^\n\r\x{2028}\x{2029}])"))).unwrap(), msg))
    .collect()
});

/// Klartext für eine Fehlermeldung; `None`, wenn keine Regel passt.
pub fn klartext(fehler: &str) -> Option<&'static str> {
    REGELN.iter().find(|(re, _)| re.is_match(fehler)).map(|(_, m)| *m)
}
