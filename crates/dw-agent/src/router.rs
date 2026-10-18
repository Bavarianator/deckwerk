//! Router zum Gesprächsstart (router.ts + ruleRoute aus guide-modules.ts): Module, bei „Auto“ Modell und Effort.
//! Die Antwort des kleinen Modells prüft `route`; bei jedem Fehler greift der Regel-Router.
// ponytail: LLM-Aufruf (claude -p, codex, vibe, API) macht der Aufrufer mit `system`/`message` und reicht die
// Antwort als JSON an `route`; Ausbau: viaClaude/viaCodex/viaVibe/viaApi hier, sobald dw-agent tokio `process` hat.

use std::sync::OnceLock;

use dw_guide::{Module, PODCAST_MODULES, Route, TIMELINE_MODULES, VIDEO_MODULES};
use dw_model::Profile;
use dw_tools::{PRO, catalog};
use regex::Regex;
use serde_json::Value;

use crate::{Effort, MODELS};

pub struct Input<'a> {
    pub text: &'a str,
    pub profile: Profile,
    pub layouts_in_deck: &'a [String],
    pub has_deck: bool,
    /// Deck hat deck.podcast
    pub podcast: bool,
}

/// source: haiku | codex | vibe | regel
#[derive(Debug, Clone, PartialEq)]
pub struct Routed {
    pub route: Route,
    pub model: Option<&'static str>,
    pub effort: Option<Effort>,
    pub source: &'static str,
    pub reason: String,
}

fn re(s: &str) -> Regex {
    Regex::new(s).unwrap()
}

struct Rules {
    film: Regex,
    keywords: Vec<(&'static str, Regex, &'static [&'static str])>,
    video: Regex,
    schnitt: Regex,
    pod: Regex,
    pod_not: Regex,
    folien: Regex,
    pro_schnitt: Regex,
    kinds: [(&'static str, Regex); 5],
    quelle: Regex,
}

const FILM: &str = r"erklärvideo|erklärfilm|demo-video|produktvideo|live-demo|produktdemo|app-demo|tutorial|screencast|bildschirmaufnahme|kennzahlen-video|animiertes video|explainer|motion[- ]?gra(fik|phics?)|animierte (info)?grafik";
const DATA: &[&str] = &["inhalt-layout", "layout:chart", "layout:kpi-grid", "layout:table", "layout:big-number"];
const SOCIAL_SKIP: &[&str] = &["agenda", "section", "table"];
const DOC_BASIS: &[&str] = &["cover", "bullets", "image-text", "kpi-grid", "chart", "table", "timeline", "quote"];
const VIDEO_DECK: &[&str] = &["clip", "section", "statement", "schnitt"];

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| {
        let mut keywords: Vec<(&'static str, Regex, &'static [&'static str])> = vec![
            ("animation", re(r"animation|animier|übergang|morph|\bbuild|einblend|bewegung|selbstlauf"), &["animation", "katalog-animationen"]),
            ("film", re(FILM), &["film", "layout:screen", "layout:code"]),
            ("bild", re(r"foto|bild|photo|image|unsplash|illustration|logo|qr"), &["fotos", "ki-bilder"]),
            ("design", re(r"farbe|look|theme|design|stil|schrift|font|mutig|sachlich|gestalt|marke|brand|hintergrund|dunkel|edel|modern"), &["gestaltung", "abwechslung", "stil", "katalog-themes", "katalog-ton"]),
            ("text", re(r"text|titel|formulier|rechtschreib|tippfehler|übersetz|notiz|notes|sprache|schreib|kürz|zusammenfass"), &["text", "deck-auftraege"]),
            ("diagramm", re(r"diagramm|chart|grafik|zahl|kennzahl|kpi|tabelle|daten|umsatz|prozent|%"), DATA),
            ("storyline", re(r"storyline|aufbau|gliederung|idee|geschichte|dramaturgie|reihenfolge|roter faden"), &["storyline", "geruest", "rhythmus"]),
            ("rhythmus", re(r"rhythmus|abwechslung|eintönig|langweilig|luftig|überladen"), &["rhythmus", "inhalt-layout"]),
            ("bewerbung", re(r"bewerbung|lebenslauf|anschreiben|\bcv\b"), &["geruest-a4", "layout:application-cover", "layout:letter", "layout:cv"]),
        ];
        if PRO {
            keywords.push(("gantt", re(r"gantt|projektplan|zeitplan mit phasen"), &["layout:gantt"]));
        }
        Rules {
            film: re(FILM),
            keywords,
            video: re(r"video|\bclips?\b|\bshorts?\b|\breels?\b|\b(live)?streams?\b|zusammenschnitt|youtube|twitch|kick\.com|\bmp4\b|podcast|transkri"),
            schnitt: re(r"schneid|schnitt|kürzen|kürze\b|kürzt\b|\bcuts?\b|highlight|\.(mp4|mov|webm|mkv)\b|https?:|\baus (meinem|dem|der|einem|unserem) (video|stream|livestream|vod|aufnahme|mitschnitt)"),
            pod: re(r"podcast|\bepisode|\bfolge\b|audio|tonspur|\bspuren\b|\.(mp3|wav|m4a|aac|flac|ogg|opus)\b|\bmp3\b"),
            pod_not: re(r"\bclips?\b|\bshorts?\b|\breels?\b|tiktok|\bmp4\b|highlight|zusammenschnitt"),
            folien: re(r"\bdecks?\b|\bfolien?\b|\bseiten?\b"),
            pro_schnitt: re(r"mehrspur|videospur|tonspur|bild-in-bild|b-roll|farbkorrektur|color ?grading|prores|\b4k\b|\blufs\b|überblend|cross ?dissolve"),
            kinds: [
                ("karte", re("visitenkarte")),
                ("stream", re(r"starting soon|\bbrb\b|be right back|obs-?szenen?|twitch.?panels?|panels? (für|fuer) (twitch|stream|kanal)|youtube.?thumbnails?|offline-?banner|stream-?(paket|grafik|bildschirm|screen|banner|szene)")),
                // „brief(?!ing)“: Rust-Regex kennt kein Lookahead, daher wird „briefing“ vorher entfernt (rule_route)
                ("a4", re(r"\ba4\b|druckerei|druckdatei|drucksache|\bdrucken\b|flyer|plakat|brief|angebot|kostenvoranschlag|infoblatt|one-pager|handzettel|lebenslauf|bewerbung|einladung|save the date|urkunde|zertifikat|bescheinigung|speisekarte|getränkekarte|mittagstisch")),
                ("social", re(r"instagram|karussell|carousel|social|\bstory\b|stories|linkedin|tiktok|\bpost(s|ing)?\b|1:1|4:5|9:16")),
                ("slides", re(r"präsentation|vortrag|pitch|keynote|powerpoint|pptx|slides|16:9")),
            ],
            quelle: re(r"<quelle>([\s\S]*?)</quelle>"),
        }
    })
}

fn push(v: &mut Vec<String>, ids: impl IntoIterator<Item = impl Into<String>>) {
    for id in ids {
        let id = id.into();
        if !v.contains(&id) {
            v.push(id);
        }
    }
}

fn regel(modules: Vec<String>, video: bool, reason: String) -> Routed {
    Routed { route: Route { modules, video }, model: None, effort: None, source: "regel", reason }
}

/// Regel-Router ohne KI: Layouts nach Format, Abschnitte nach Stichwörtern; lieber ein Modul zu viel
pub fn rule_route(i: &Input) -> Routed {
    let r = rules();
    let t = i.text.to_lowercase();
    let in_deck: Vec<&str> = i.layouts_in_deck.iter().map(String::as_str).filter(|id| catalog::get(id).is_some()).collect();
    let has = |id: &str| in_deck.contains(&id);
    let no_briefing = t.replace("briefing", "");
    let mut kinds: Vec<&str> = r.kinds.iter()
        .filter(|(k, re)| re.is_match(if *k == "a4" { &no_briefing } else { &t }) && (PRO || *k != "stream"))
        .map(|(k, _)| *k)
        .collect();
    let pro = PRO && (r.pro_schnitt.is_match(&t) || has("schnitt"));
    let video = r.video.is_match(&t) || has("clip") || pro;
    let plain = !["slides", "a4", "karte"].iter().any(|k| kinds.contains(k)) && !r.folien.is_match(&t);
    if plain && in_deck.is_empty() && (i.podcast || (r.pod.is_match(&t) && !r.pod_not.is_match(&t) && !kinds.contains(&"social"))) {
        return regel(PODCAST_MODULES.map(String::from).to_vec(), true, "Regeln: Podcast".into());
    }
    if video && (!r.film.is_match(&t) || r.schnitt.is_match(&t) || pro) && plain && !kinds.contains(&"stream")
        && in_deck.iter().all(|id| VIDEO_DECK.contains(id))
    {
        let mut m: Vec<String> = VIDEO_MODULES.iter().chain(&["layout:section", "layout:statement"]).map(|s| s.to_string()).collect();
        if pro {
            push(&mut m, TIMELINE_MODULES);
        }
        return regel(m, true, "Regeln: Video".into());
    }
    let add_kind = |kinds: &mut Vec<&'static str>, k: &'static str| if !kinds.contains(&k) { kinds.push(k) };
    if has("stream-screen") || has("panel") {
        add_kind(&mut kinds, "stream");
    }
    if i.has_deck || kinds.is_empty() {
        let k = match i.profile {
            Profile::Doc if has("business-card") => "karte",
            Profile::Doc => "a4",
            Profile::Social => "social",
            Profile::Slides => "slides",
        };
        add_kind(&mut kinds, k);
    }
    let k = |s: &str| kinds.contains(&s);
    let mut layouts: Vec<String> = Vec::new();
    push(&mut layouts, in_deck.iter().copied());
    let sizes = |id: &str| catalog::get(id).and_then(|l| l.sizes.clone());
    if k("slides") {
        push(&mut layouts, catalog::ids().into_iter().filter(|id| sizes(id).is_none()));
    }
    if k("social") {
        push(&mut layouts, catalog::ids().into_iter().filter(|id| sizes(id).is_none() && !SOCIAL_SKIP.contains(id)));
    }
    if k("a4") {
        push(&mut layouts, catalog::ids().into_iter().filter(|id| sizes(id).is_some_and(|s| s.iter().any(|s| s.starts_with("a4")))));
        push(&mut layouts, DOC_BASIS.iter().copied());
    }
    if k("karte") {
        push(&mut layouts, ["business-card"]);
    }
    if k("stream") {
        push(&mut layouts, ["stream-screen", "panel", "cover", "photo", "statement"]);
    }
    let mut mods = vec!["geruest".to_string()];
    for (kind, m) in [("slides", "geruest-praesentation"), ("social", "geruest-social"), ("a4", "geruest-a4"), ("karte", "geruest-visitenkarte"), ("stream", "geruest-stream")] {
        if k(kind) {
            push(&mut mods, [m]);
        }
    }
    push(&mut mods, ["inhalt-layout", "text"]);
    if !i.has_deck {
        push(&mut mods, ["gestaltung", "abwechslung", "stil", "katalog-themes", "katalog-ton"]);
        if kinds.len() > 1 || !k("karte") {
            push(&mut mods, ["storyline", "rhythmus", "fotos", "ki-bilder"]);
        } else {
            push(&mut mods, ["fotos"]); // Visitenkarte: keine Storyline, aber Brand-Kit-Regeln (Logo)
        }
        if k("slides") {
            push(&mut mods, ["animation", "katalog-animationen"]);
        }
    }
    let hits: Vec<_> = r.keywords.iter().filter(|(_, re, _)| re.is_match(&t)).collect();
    for (_, _, m) in &hits {
        push(&mut mods, m.iter().copied());
    }
    if video {
        push(&mut mods, VIDEO_MODULES);
        if pro {
            push(&mut mods, TIMELINE_MODULES);
        }
    }
    push(&mut mods, layouts.iter().map(|id| format!("layout:{id}")));
    let words = hits.iter().map(|(n, _, _)| *n).collect::<Vec<_>>().join(", ");
    let reason = format!(
        "Regeln: {}{}{}",
        kinds.join(", "),
        if i.has_deck { "" } else { ", neues Deck" },
        if hits.is_empty() { String::new() } else { format!("; Stichwörter: {words}") }
    );
    regel(mods, false, reason)
}

/// Systemprompt des Routers; index = dw_guide::guide_index
pub fn system(index: &str, auto: bool) -> String {
    let modell = if auto {
        "\n## Modell\nWähle auch model und effort: opus für neue Decks, Umbauten, Quellmaterial und anspruchsvolle Aufträge (effort high); sonnet für gezielte Änderungen an einem bestehenden Deck (effort medium, low für Tippfehler und Kleinigkeiten)."
    } else {
        "model und effort weglassen."
    };
    format!("Du bist der Router für Deckwerk, eine App, in der eine KI Präsentationen und Drucksachen aus einem festen Layout-Katalog baut und Videos schneidet. Du baust nichts selbst: Du wählst zum Gesprächsstart die Module aus dem Index, die die KI für DIESEN Auftrag braucht. Grundregeln, Arbeitsablauf und häufige Fehler hat sie immer; fehlt ihr später etwas, lädt sie es selbst nach.

{index}

## Regeln
- Nur IDs aus dem Index, genau so geschrieben.
- Großzügig bei Layouts, die zu Format und Anlass passen: lieber ein Layout zu viel als eines, das fehlt. Layouts mit „nur Format …“ nur in diesem Format.
- Immer das Gerüst zum Format: geruest plus geruest-praesentation, geruest-social, geruest-a4 oder geruest-visitenkarte; Stream-Grafiken (Starting Soon, BRB, OBS-Szenen, Thumbnail, Twitch-Panels) geruest-stream mit layout:stream-screen und layout:panel.
- Neues Deck: gestaltung, abwechslung, stil, katalog-themes, katalog-ton; bei mehreren Folien oder Seiten auch storyline und rhythmus.
- Bestehendes Deck und kleine Änderung: wenige Module, nur was der Auftrag berührt.
- animation und katalog-animationen nur, wenn es um Bewegung, Übergänge oder Animation der Folien geht.
- film (mit layout:screen, layout:code) für Erklärvideo, Produkt-/Live-Demo, Tutorial oder animierten Film aus Folien und Sprechtext; kein Videoschnitt (der ist video).
- ki-bilder nur bei ausdrücklichem Bildwunsch (KI-Bild, Illustration); fotos bei Fotos, Bildern, Logo, QR-Code.
- Zahlen, Daten, Diagramme: inhalt-layout und die passenden Datenlayouts (chart, kpi-grid, table, big-number).
- Texte ändern, übersetzen, kürzen, Notizen: text und deck-auftraege.
- Reiner Video-Auftrag (Video schneiden oder kürzen, Short, Reel, Stream-Highlights, Zusammenschnitt, Untertitel, MP4): nur video und layout:clip, bei Zwischentiteln layout:section und layout:statement; kein Gerüst, keine Gestaltung, keine Storyline. Präsentation mit Video: das Übliche plus video und layout:clip.
- Reiner Podcast-Auftrag (Aufnahme, Audio, Folge oder Episode schneiden, Pausen und Füllwörter raus, Kapitel, Intro/Outro, MP3): nur podcast; Reels oder Shorts aus einem Podcast sind Video.
- Pro-Schnitt (mehrere Spuren oder Quellen gleichzeitig, Bild-in-Bild, B-Roll, Farbkorrektur, Musik auf eigener Spur, 4K/ProRes, Rundfunk-Lautheit, Folie schnitt): video, timeline und layout:schnitt.
- reason: ein kurzer Satz auf Deutsch.
{modell}")
}

/// Nutzernachricht an den Router; gekürzt wird nur Quellmaterial in <quelle> (rund 6000 Zeichen), der Auftrag nie
pub fn message(i: &Input) -> String {
    let profile = match i.profile {
        Profile::Slides => "Präsentation (Folien)",
        Profile::Social => "Social Media (4:5, 1:1, 9:16)",
        Profile::Doc => "Dokument/Druck (A4, Visitenkarte)",
    };
    let deck = if i.has_deck {
        let mut l: Vec<&str> = Vec::new();
        push_str(&mut l, i.layouts_in_deck);
        format!("bestehendes Deck, Format {profile}, Layouts im Deck: {}", if l.is_empty() { "keine".into() } else { l.join(", ") })
    } else {
        format!("neues Deck, Format {profile}")
    };
    format!("Deck: {deck}\n\nAuftrag:\n{}", clip(i.text, 6000))
}

fn push_str<'a>(v: &mut Vec<&'a str>, ids: &'a [String]) {
    for id in ids {
        if !v.contains(&id.as_str()) {
            v.push(id);
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    let q = &rules().quelle;
    let blocks: Vec<usize> = q.captures_iter(text).map(|c| c[1].chars().count()).collect();
    let len = text.chars().count();
    if len <= max || blocks.is_empty() {
        return text.into();
    }
    // ponytail: gleicher Anteil je Quelle, mindestens 300 Zeichen; reicht für die Modulwahl
    let each = ((blocks.iter().sum::<usize>() as i64 - (len - max) as i64) / blocks.len() as i64).max(300) as usize;
    q.replace_all(text, |c: &regex::Captures| {
        if c[1].chars().count() <= each {
            c[0].to_string()
        } else {
            format!("<quelle>{} … (gekürzt)\n</quelle>", c[1].chars().take(each).collect::<String>())
        }
    })
    .into_owned()
}

/// Antwort des Router-Modells prüfen, bei Fehler Regel-Router mit „Fallback: …“. mods = dw_guide::modules(store).
/// Modell nur bei auto und Claude-Router (haiku): Codex/Vibe-Wahl (`codex:`/`vibe:`) bleibt unangetastet, nie Opus.
pub fn route(i: &Input, mods: &[Module], auto: bool, source: &'static str, answer: Result<Value, String>) -> Routed {
    to_route(i, mods, auto && source == "haiku", source, answer).unwrap_or_else(|e| {
        let mut r = rule_route(i);
        r.reason = format!("Fallback: {e}");
        r
    })
}

fn to_route(i: &Input, mods: &[Module], auto: bool, source: &'static str, answer: Result<Value, String>) -> Result<Routed, String> {
    let raw = answer?;
    let known = |id: &str| mods.iter().any(|m| !m.always && m.id == id);
    let list = raw.get("modules").and_then(Value::as_array).ok_or("Antwort ohne modules")?;
    let mut modules: Vec<String> = Vec::new();
    push(&mut modules, list.iter().filter_map(Value::as_str).filter(|id| known(id)));
    if modules.is_empty() {
        return Err("keine bekannten Module".into());
    }
    push(&mut modules, rule_route(i).route.modules.into_iter().filter(|id| id.starts_with("geruest")));
    push(&mut modules, i.layouts_in_deck.iter().map(|id| format!("layout:{id}")).filter(|id| known(id)));
    let s = |k: &str| raw.get(k).and_then(Value::as_str);
    let model = s("model").filter(|_| auto).and_then(|m| MODELS.iter().map(|x| x.id).filter(|id| ["opus", "sonnet"].contains(id)).find(|id| *id == m));
    let effort = model.and(s("effort")).and_then(|e| match e {
        "low" => Some(Effort::Low),
        "medium" => Some(Effort::Medium),
        "high" => Some(Effort::High),
        _ => None,
    });
    // reiner Video- oder Podcast-Auftrag: Schnitt gewählt und kein Gerüst → schlanker Kernprompt
    let video = modules.iter().any(|m| m == "video" || m == "podcast") && !modules.iter().any(|m| m.starts_with("geruest"));
    Ok(Routed { route: Route { modules, video }, model, effort, source, reason: s("reason").unwrap_or_default().into() })
}
