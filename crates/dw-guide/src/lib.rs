//! Design-Guide und Layout-Katalog als Module (guide-modules.ts): Kernprompt mit Index, Module nach Bedarf (Router oder
//! read_guide), voller Prompt in Teilen. Der Guide ist `src/main/design-guide.md`, der Katalog kommt aus dw-tools.
//! Edition wie dw-tools zur Build-Zeit (Feature `pro`).

use std::sync::OnceLock;

use dw_store::Store;
use dw_tools::{HookOut, Hooks, PRO, ToolOutput};
use regex::Regex;
use serde_json::Value;

const GUIDE_MD: &str = include_str!("../../../src/main/design-guide.md");

#[derive(Debug, Clone, PartialEq)]
pub struct Module {
    pub id: String,
    pub title: String,
    pub kurz: String,
    pub text: String,
    /// steht immer im Kernprompt
    pub always: bool,
}

/// Vom Router gewählte Module für die erste Nachricht; video = reiner Video-/Podcast-Auftrag (schlanker Kernprompt)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Route {
    pub modules: Vec<String>,
    pub video: bool,
}

const WORKFLOW: &str = "## Arbeitsablauf
1. Höchstens 2–3 Rückfragen (mit ask_user, falls vorhanden), sonst sinnvolle Defaults annehmen.
2. Erst die Leitidee in einem Satz (Guide §2 „Die Idee“: Bild für das Ganze, Haken, ein mutiger Höhepunkt), dann die Storyline als Liste der Titel (Datenfolien als Aussage-Satz, Bühnenfolien kurz) (mit plan_storyline, falls vorhanden, sonst im Chat), dann create_deck und add_slides in Batches.
3. QA-Schleife (max. 3 Runden): Fehler aus den Tool-Rückmeldungen und lint_deck beheben → render_overview kritisch prüfen (Rhythmus, Dichte, Konsistenz) → nachbessern.
4. Animationen prüfen (ein Übergangstyp, maximal ein Build pro Folie, keine Animation auf Titeln), Speaker Notes ergänzen.
5. Kurze Zusammenfassung; exportieren nur, wenn der Nutzer es wünscht.
Antworte auf Deutsch, knapp.";

// Feste ID je Überschrift (Zeilenanfang), damit Umbenennungen keine ID ändern
const HEADINGS: &[(&str, &str, &str, bool)] = &[
    (
        "praeambel",
        "# Design-Guide",
        "Deine Rolle neben der Engine.",
        true,
    ),
    (
        "grundregeln",
        "## 1. Grundregeln",
        "Eine Botschaft pro Folie, Action Titles.",
        true,
    ),
    (
        "storyline",
        "## 2. Storyline",
        "Pyramidenprinzip, SCQA und die Leitidee (Haken, Höhepunkt, Bogen) für neue Decks.",
        false,
    ),
    (
        "geruest",
        "## 3. Deck-Gerüste",
        "Gerüst als Startpunkt, Kapiteltrenner, keine Pflichtteile.",
        false,
    ),
    (
        "geruest-praesentation",
        "### Präsentationen",
        "Folgen für Pitch, Chef-Update, Projektstatus und Strategie; Agenda erst ab ca. 8 Folien.",
        false,
    ),
    (
        "geruest-social",
        "### Social-Karussell",
        "Instagram-Karussell und Story (4:5, 1:1, 9:16): Folge, Textmenge, passende Layouts.",
        false,
    ),
    (
        "geruest-a4",
        "### A4-Dokumente",
        "A4 und Druck: Infoblatt, Angebot, Flyer, Brief, Bewerbung, Lebenslauf, Einladung, Urkunde, Speisekarte, Druckdatei.",
        false,
    ),
    (
        "geruest-visitenkarte",
        "### Visitenkarte",
        "Visitenkarte 85 × 55 mm: Vorder- und Rückseite, Kontaktdaten, Druck.",
        false,
    ),
    (
        "geruest-stream",
        "### Stream-Paket",
        "Stream-Grafiken: Starting Soon, BRB, Ending, YouTube-Thumbnail, Offline-Banner, Twitch-Panels, PNG-Export.",
        false,
    ),
    (
        "inhalt-layout",
        "## 4. Inhalt",
        "Welches Layout zu welcher Form der Aussage passt.",
        false,
    ),
    (
        "rhythmus",
        "## 5. Rhythmus",
        "Dichte und luftige Folien im Wechsel, Wiederholungen vermeiden.",
        false,
    ),
    (
        "gestaltung",
        "## 6. Gestaltung",
        "Eigenes Design (customTheme): Charakter, Farbe, Grund, Schriftpaar, Struktur, Feinschliff, Theme-Lint, erprobte Richtungen, propose_looks.",
        false,
    ),
    (
        "abwechslung",
        "### Abwechslung",
        "Neues Deck im Designtyp anders als die zuletzt gebauten.",
        false,
    ),
    (
        "stil",
        "### Stil des Decks",
        "Stil sachlich oder mutig, mutige Richtungen, was KI-Folien verrät, was gute Decks tun, Mut wie ein Mensch.",
        false,
    ),
    (
        "fotos",
        "### Fotos, Bilder, Marke",
        "Fotos (Vollbild oder daneben, find_images, focus, Bildnachweis), Canva-Mittel nur auf Wunsch, QR-Code, Brand-Kit.",
        false,
    ),
    (
        "ki-bilder",
        "### KI-Bilder",
        "generate_image: wofür und wofür nie, Bildplan, Stilsatz, Prompt, Platz für den Titel.",
        false,
    ),
    (
        "text",
        "## 7. Text",
        "Titel, Bullets, Wortgrenzen, Zahlen, Links, Speaker Notes, was nach KI klingt.",
        false,
    ),
    (
        "animation",
        "## 8. Animation",
        "Builds, Übergänge, Morph, Bewegungsstil, Element-Animationen, Vortrag oder Selbstlauf.",
        false,
    ),
    (
        "ablauf",
        "## 9. Arbeitsablauf",
        "Briefing, Idee, Theme, Batches, QA-Schleife, Abschluss.",
        true,
    ),
    (
        "deck-auftraege",
        "### Aufträge fürs ganze Deck",
        "Übersetzen, Notizen, Kürzen, als Text zusammenfassen, Rechtschreibung.",
        false,
    ),
    (
        "fehler",
        "## 10. Häufige Fehler",
        "Was oft schiefgeht.",
        true,
    ),
    (
        "video",
        "## 11. Video",
        "Video-Schnitt: Shorts/Reels, Fulltime kürzen, Stream-Highlights, Kompilation; Bewertung, Hooks, Regeln für clip.",
        false,
    ),
    (
        "film",
        "## 12. Animation (Film)",
        "Film (Erklärvideo, Live-Demo, Produkt-/Kennzahlen-Video): film, Sprechtext mit [klick], Kamera, Motion-Grafik (keys, draw), capture_page, screen_zooms, Gerüst, Ablauf.",
        false,
    ),
    (
        "podcast",
        "## 13. Podcast",
        "Podcast-Schnitt: Episode (deck.podcast), Spuren, Pausen/Füllwörter/Versprecher, Kapitel, Intro/Outro, MP3-Export.",
        false,
    ),
    (
        "timeline",
        "## 14. Timeline",
        "Pro-Schnitt (Layout schnitt): mehrere Spuren und Quellen, B-Roll, Farbe, Musik, Ausgabe; Ablauf mit edit_timeline.",
        false,
    ),
    (
        "katalog",
        "## Layout-Katalog",
        "Layouts statt Koordinaten, freie Elemente (items).",
        true,
    ),
    (
        "katalog-themes",
        "## Themes",
        "Katalog-Themes, Schriften mit Charakter und Schriftkatalog für headFont/bodyFont.",
        false,
    ),
    (
        "katalog-ton",
        "## Folien-Ton und Dekor",
        "tone pro Folie (normal, accent, invert) und Hintergrundmotive.",
        false,
    ),
    (
        "katalog-animationen",
        "## Animationen",
        "Liste der Builds und Übergänge.",
        false,
    ),
];

// Pro-Abschnitte: in der Deckwerk-Edition fehlen sie samt Layouts, damit die KI nichts anbietet, was es nicht gibt
const PRO_MODULES: [&str; 2] = ["geruest-stream", "timeline"];

pub const VIDEO_MODULES: [&str; 2] = ["video", "layout:clip"];
pub const PODCAST_MODULES: [&str; 1] = ["podcast"];
pub const TIMELINE_MODULES: [&str; 2] = ["timeline", "layout:schnitt"];

fn heads() -> impl Iterator<Item = &'static (&'static str, &'static str, &'static str, bool)> {
    HEADINGS
        .iter()
        .filter(|(id, ..)| PRO || !PRO_MODULES.contains(id))
}

/// Text vor jeder Zeile, die mit `#`…`###` und Leerzeichen beginnt, teilen (JS `split(/\n(?=#{1,3} )/)`);
/// `deep` = auch `####`… (JS `/\n(?=##+ )/`, nur ab zwei #)
fn split_at_heads(text: &str, deep: bool) -> Vec<&str> {
    let starts_head = |s: &str| {
        let n = s.bytes().take_while(|&b| b == b'#').count();
        let ok = if deep { n >= 2 } else { (1..=3).contains(&n) };
        ok && s.as_bytes().get(n) == Some(&b' ')
    };
    let mut out = vec![];
    let mut from = 0;
    for (i, _) in text.match_indices('\n') {
        if starts_head(&text[i + 1..]) {
            out.push(&text[from..i]);
            from = i + 1;
        }
    }
    out.push(&text[from..]);
    out
}

/// Guide-Text der Edition
fn guide() -> &'static str {
    static G: OnceLock<String> = OnceLock::new();
    G.get_or_init(|| {
        let g = GUIDE_MD.trim();
        if PRO {
            return g.to_string();
        }
        let pro_heads: Vec<&str> = HEADINGS
            .iter()
            .filter(|(id, ..)| PRO_MODULES.contains(id))
            .map(|h| h.1)
            .collect();
        split_at_heads(g, false)
            .into_iter()
            .filter(|b| !pro_heads.iter().any(|h| b.starts_with(h)))
            .collect::<Vec<_>>()
            .join("\n")
            .replacen("; verlangt die Druckerei CMYK (z. B. print24), `cmyk: true` setzen (PDF/X-4, FOGRA39)", "", 1)
    })
}

// Zeichen jeder gebündelten Schrift (tools.ts FONT_MOOD), damit die KI Paare nach Stimmung wählt
const FONT_MOOD: &[(&str, &str)] = &[
    (
        "Fraunces",
        "warme Display-Serif mit Charakter: editorial, Magazin, Handwerk, Kultur",
    ),
    (
        "DM Serif Display",
        "elegante, kontrastreiche Serif (nur ein Schnitt): Luxus, Premium, ruhig",
    ),
    (
        "Space Grotesk",
        "technische Grotesk, inzwischen Standard generierter Tech-Decks: nur auf Wunsch",
    ),
    (
        "Manrope",
        "freundliche geometrische Sans: modern, zugänglich, gut für Fließtext",
    ),
    (
        "Inter",
        "neutrale Profi-Sans, sehr gut lesbar: Business, Produkt, Fließtext",
    ),
    (
        "DM Sans",
        "klare geometrische Sans, Partner zu DM Serif Display",
    ),
    (
        "Arial",
        "Office-Standard, maximal kompatibel, wirkt generisch",
    ),
    ("Calibri", "Office-Standard für Text, wirkt generisch"),
    (
        "Georgia",
        "Office-Serif, solide, wirkt klassisch-konservativ",
    ),
    (
        "Playfair Display",
        "klassische Kontrast-Serif: Hochzeit, Mode, Kultur, gehobene Anlässe",
    ),
    (
        "Source Sans 3",
        "sachliche Humanist-Sans, sehr gut lesbar: Verwaltung, Wissenschaft, Fließtext",
    ),
    (
        "Plus Jakarta Sans",
        "moderne, freundliche Grotesk: SaaS, Agentur, Startup",
    ),
    (
        "Lora",
        "ruhige Buch-Serif: Bildung, Stiftung, Gesundheit, Erzählung",
    ),
    (
        "Instrument Serif",
        "schmale Display-Serif (nur ein Schnitt), inzwischen Standard generierter Designs: nur auf Wunsch",
    ),
    (
        "Archivo",
        "kräftige, sachliche Grotesk im Schweizer Stil: Industrie, Logistik, Architektur, klare Ansagen",
    ),
    (
        "IBM Plex Sans",
        "sachliche Profi-Grotesk mit Charakter: Beratung, Finanzen, Technik, Zahlen",
    ),
    (
        "IBM Plex Serif",
        "nüchterne Serif, Partner zu IBM Plex Sans: Vortrag, Forschung, Reflexion",
    ),
    (
        "Source Serif 4",
        "redaktionelle Buch-Serif: Bericht, Stiftung, Verwaltung, Wissenschaft",
    ),
    (
        "Archivo Black",
        "Plakat-Grotesk in Black (nur ein Schnitt), nur als Titelschrift im Stil mutig: Kampagne, Event, laute Ansagen",
    ),
    (
        "IBM Plex Mono",
        "Monospace, nicht als Titel- oder Textschrift: nur über labelFont mono für Eyebrow und Fußzeile",
    ),
];

const BUILDS: &str = "none, fade, list, stagger, wipe, zoom-kpi, pan, pop, words, photo";
const TRANSITIONS: &str =
    "none, fade, push, morph, dissolve, wipe, cover, split, circle, zoom, slide, stack, color";

// Katalogschriften kompakt (nur Namen, nach Art): ohne gebündelte und ohne markierte
fn catalog_fonts() -> String {
    use dw_theme::fonts::{FONT_CATALOG, FONT_LIST, FontCat as C, FontRole};
    let cats = [
        (C::Grotesk, "Grotesk"),
        (C::Humanist, "Humanistisch"),
        (C::Geometric, "Geometrisch"),
        (C::Condensed, "Condensed"),
        (C::Serif, "Serif"),
        (C::DisplaySerif, "Display-Serif"),
        (C::Slab, "Slab"),
        (C::Mono, "Mono"),
    ];
    cats.iter()
        .map(|(c, label)| {
            let names: Vec<String> = FONT_CATALOG
                .iter()
                .filter(|f| {
                    f.cat == *c
                        && f.flag.is_none()
                        && !FONT_LIST.iter().any(|(n, _)| *n == f.family)
                })
                .map(|f| {
                    format!(
                        "{}{}",
                        f.family,
                        if f.role == FontRole::Head { "*" } else { "" }
                    )
                })
                .collect();
            format!("{label}: {}", names.join(", "))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Layout-Katalog für den Systemprompt (tools.ts `buildCatalog`): id, wann, Varianten, Default-Build, JSON-Schema
pub fn build_catalog() -> &'static str {
    static C: OnceLock<String> = OnceLock::new();
    C.get_or_init(|| {
        let layouts = dw_tools::catalog::ids().into_iter().filter_map(dw_tools::catalog::get).map(|l| {
            let mut v = vec![format!("### {} – {}", l.id, l.name), format!("Wann: {}", l.when)];
            if let Some(x) = l.variants.as_ref().filter(|x| !x.is_empty()) {
                v.push(format!("Varianten: {}", x.join(", ")));
            }
            if let Some(x) = l.frames.as_ref().filter(|x| !x.is_empty()) {
                v.push(format!("Frames: top, {}", x.join(", ")));
            }
            if let Some(x) = &l.sizes {
                v.push(format!("Nur im Format: {} (create_deck format)", x.join(", ")));
            }
            v.push(format!("Default-Build: {}", l.default_build));
            v.push(format!("Schema: {}", serde_json::to_string(&l.schema).unwrap_or_default()));
            v.join("\n")
        });
        let fonts = dw_theme::fonts::FONT_LIST
            .iter()
            .map(|(n, _)| format!("- {n}: {}", FONT_MOOD.iter().find(|m| m.0 == *n).map_or("", |m| m.1)))
            .collect::<Vec<_>>()
            .join("\n");
        let themes = dw_theme::catalog_themes()
            .map(|t| {
                format!(
                    "- {}: {}{}{}",
                    t.id,
                    t.name,
                    if t.dark { " (dunkel)" } else { "" },
                    if t.mutig { " (nur Stil mutig)" } else { "" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let mut parts: Vec<String> = vec![
            "## Layout-Katalog".into(),
            "Du setzt nie Koordinaten. Du wählst ein Layout und füllst seine Felder nach dem Schema; die Engine misst, passt Schriftgrößen an und meldet Probleme zurück.".into(),
            "Ausnahme: freie Elemente (`items` in add_slides/update_slide: Text, Form, Bild, Icon, Diagramm, Tabelle mit x/y/w/h in px auf 1280×720, Drehung, Deckkraft). Nur auf Layout blank oder wenn der Nutzer ausdrücklich frei gestaltet bzw. ein Element „wie in Canva“ platziert haben will. Mindestens 48 px Rand, Text ab 20 px, prüfe das Ergebnis mit render_slides. get_deck zeigt vorhandene items mit IDs.".into(),
        ];
        parts.extend(layouts);
        parts.extend([
            "## Themes".into(),
            "Entwirf für jedes Deck ein eigenes Design (create_deck.customTheme) nach Design-Guide §6: Farbe, Schriftpaar und Struktur (titleSize, titleWeight, rule, sectionTone, sparsam Feinschliff wie signature, margin, heroTone) aus Thema, Branche und Anlass. Der Theme-Lint lehnt Klischees mit konkreter Korrektur ab. Die Katalog-Themes sind erprobte Vorbilder dafür und die Wahl, wenn es schnell gehen soll (Feinschliff per `tune`): beratung (hell, Daten, Chef-Update), keynote (dunkel, Plakat-Titel), schweiz (streng, Kopflinie), redaktion (Serif regular, Kopflinie), zen (dunkel, Serif, fotolastig). Nur im Stil mutig: plakat (Signalgelb, Black-Titel), magazin (Papier, riesige Serif, Mono-Labels), neomono (Off-Black, Signalorange, Plex, Mono-Labels), pastell (Lavendel, rund, freundlich). Die Engine leitet Flächen, Ränder, Sekundärtext und Diagrammfarben ab, dämpft den Grund und sichert Kontraste.".into(),
            "Schriften (Premium-Schriften werden in die PPTX eingebettet):".into(),
            fonts,
            format!("Dazu Familien aus dem Schriftkatalog für headFont, bodyFont, fonts, brand und freie Texte (lädt die Engine bei Bedarf und bettet sie ein, offline gilt ein ähnlicher gebündelter Ersatz; * = nur Titel): {}", catalog_fonts()),
            "Katalog-Themes:".into(),
            themes,
            "## Folien-Ton und Dekor".into(),
            "Pro Folie optional `tone`: normal | accent (Akzentfläche, Standard bei section) | invert (Hell/Dunkel getauscht). Für Rhythmus: Kapiteltrenner, Kernaussage oder den Höhepunkt des Decks auf accent/invert setzen, höchstens jede 3.–4. Folie. `decor` wählt das Hintergrundmotiv (none, blobs, glow, rings, grid, stripe, dots); Standard kommt vom Theme (none). Motive nur auf ausdrücklichen Wunsch.".into(),
            "## Animationen".into(),
            format!("Builds: {BUILDS} · Übergänge: {TRANSITIONS}. Ein Übergangstyp pro Deck (create_deck/update_deck); `transition` an einer Folie nur für morph (Design-Guide §8). Die Rückmeldung zu jeder Folie nennt Übergang, Aufbau und Klicks."),
        ]);
        parts.join("\n\n")
    })
}

// wie JS: höchstens n Zeichen, angebrochenes Wort weg, „ …“ dahinter
fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    static TAIL: OnceLock<Regex> = OnceLock::new();
    let cut: String = s.chars().take(n).collect();
    let tail = TAIL.get_or_init(|| Regex::new(r"\s+\S*$").unwrap());
    format!("{} …", tail.replace(&cut, ""))
}

// Text an Überschriften in Module teilen; die Layouts des Katalogs heißen layout:<id>
fn split(text: &str) -> Vec<Module> {
    static LAY: OnceLock<Regex> = OnceLock::new();
    let lay_re = LAY.get_or_init(|| Regex::new(r"^### (\S+) – ").unwrap());
    split_at_heads(text, false)
        .into_iter()
        .map(|block| {
            let body = block.trim_end();
            let head = body.split('\n').next().unwrap_or("");
            if let Some(l) = lay_re
                .captures(head)
                .and_then(|c| dw_tools::catalog::get(&c[1]))
            {
                let sizes = l
                    .sizes
                    .as_ref()
                    .map_or(String::new(), |s| format!("nur Format {} – ", s.join("/")));
                return Module {
                    id: format!("layout:{}", l.id),
                    title: l.name.clone(),
                    kurz: format!("{sizes}{}", short(&l.when, 110)),
                    text: body.into(),
                    always: false,
                };
            }
            let def = heads().find(|h| head.starts_with(h.1)).unwrap_or_else(|| {
                panic!("Überschrift ohne Modul-ID: „{head}“ (HEADINGS in dw-guide ergänzen)")
            });
            Module {
                id: def.0.into(),
                title: head.trim_start_matches('#').trim_start().into(),
                kurz: def.2.into(),
                text: body.into(),
                always: def.3,
            }
        })
        .collect()
}

fn static_modules() -> &'static [Module] {
    static M: OnceLock<Vec<Module>> = OnceLock::new();
    M.get_or_init(|| [split(guide()), split(build_catalog())].concat())
}

// Arbeitsablauf, Hausstil und zuletzt gebaute Decks: immer im Prompt, Hausstil und Decks nur, wenn vorhanden
fn extras(store: &Store) -> Vec<Module> {
    let style = store.house_style();
    let recent = dw_tools::recent_look_lines(store);
    let m = |id: &str, title: &str, kurz: &str, text: String| Module {
        id: id.into(),
        title: title.into(),
        kurz: kurz.into(),
        text,
        always: true,
    };
    let mut v = vec![m(
        "workflow",
        "Arbeitsablauf",
        "Ablauf in Kürze.",
        WORKFLOW.into(),
    )];
    if !style.is_empty() {
        v.push(m(
            "hausstil",
            "Hausstil des Nutzers",
            "Vorlieben des Nutzers.",
            format!("## Hausstil des Nutzers (gilt für jedes Deck, hat Vorrang vor dem Design-Guide)\n{style}"),
        ));
    }
    if !recent.is_empty() {
        v.push(m(
            "zuletzt",
            "Zuletzt gebaute Decks",
            "Designtypen der letzten Decks.",
            format!(
                "## Zuletzt gebaute Decks (nur für neue Decks: im Typ nicht wiederholen, Design-Guide §6 „Abwechslung“; bestehende Decks behalten ihr Design)\n{}",
                recent.join("\n")
            ),
        ));
    }
    v
}

/// Alle Module in fester Reihenfolge: Guide, Katalog, Arbeitsablauf, Hausstil, zuletzt gebaute Decks
pub fn modules(store: &Store) -> Vec<Module> {
    [static_modules().to_vec(), extras(store)].concat()
}

/// Index aller Module, die nicht ohnehin im Kernprompt stehen
pub fn guide_index(mods: &[Module]) -> String {
    let rest = || mods.iter().filter(|m| !m.always);
    let lay = |m: &&Module| m.id.starts_with("layout:");
    let secs: Vec<String> = rest()
        .filter(|m| !lay(m))
        .map(|m| format!("- {} – {}: {}", m.id, m.title, m.kurz))
        .collect();
    let lays: Vec<String> = rest()
        .filter(lay)
        .map(|m| format!("- {} – {} – {}", m.id, m.title, m.kurz))
        .collect();
    [
        "## Index: Module nach Bedarf".to_string(),
        "Im App-Chat bekommst du zum Start eines Gesprächs die für den Auftrag gewählten Module mit; fehlen sie (z. B. über MCP), lade sie selbst. Brauchst du später weitere (andere Layouts, Animation, Gestaltung …), lade sie mit `read_guide({ module: [...] })`, bevor du sie nutzt, z. B. `read_guide({ module: [\"animation\", \"layout:kpi-grid\"] })`; `layout:<id>` liefert Felder und JSON-Schema eines Layouts. Felder nie raten.".into(),
        format!("Abschnitte:\n{}", secs.join("\n")),
        format!("Layouts:\n{}", lays.join("\n")),
    ]
    .join("\n\n")
}

const VIDEO_CORE: &str = "# Deckwerk: Video-Schnitt
Dieses Gespräch beginnt als Video-Auftrag. Du schneidest mit den Video-Tools (import_video, transcribe_video, video_highlights, search_transcript, video_frames, check_clip, find_music) und baust das Ergebnis als Deck aus clip-Folien, exportiert als MP4. Abläufe, Bewertung und Regeln stehen im Leitfaden der ersten Nachricht (Modul video, layout:clip); fehlt er, lade ihn mit read_guide({ topic: \"video\" }). Felder nie raten.
Podcast-Aufträge (Modul podcast) laufen ohne Folien über create_episode, transcribe_video, edit_episode und export_deck mp3; fehlt der Leitfaden, lade ihn mit read_guide({ topic: \"podcast\" }).
Will der Nutzer später Folien, eine Präsentation oder eine Drucksache, hol dir zuerst mit read_guide() den Index und lade die nötigen Module.
Antworte auf Deutsch, knapp.";

/// Kernprompt: Module mit always und der Index (nach der Katalog-Einleitung). Stabil je Gespräch → Prompt-Caching.
/// video: reiner Video-Auftrag, ohne Folienregeln und Layout-Index; der Hausstil bleibt
pub fn core_prompt(store: &Store, video: bool) -> String {
    let mods = modules(store);
    if video {
        let mut v = vec![VIDEO_CORE.to_string()];
        v.extend(
            mods.iter()
                .filter(|m| m.id == "katalog" || m.id == "hausstil")
                .map(|m| m.text.clone()),
        );
        return v.join("\n\n");
    }
    let mut v = vec![];
    for m in mods.iter().filter(|m| m.always) {
        v.push(m.text.clone());
        if m.id == "katalog" {
            v.push(guide_index(&mods));
        }
    }
    v.join("\n\n")
}

/// Texte der Module in fester Reihenfolge; unbekannte IDs fallen weg
pub fn modules_text(store: &Store, ids: &[String]) -> String {
    modules(store)
        .into_iter()
        .filter(|m| ids.contains(&m.id))
        .map(|m| m.text)
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Block der Router-Module für die erste Nachricht (API- und CLI-Weg gleich); leer ohne bekannte Module
pub fn leitfaden(store: &Store, route: Option<&Route>) -> String {
    let Some(r) = route else { return String::new() };
    let mods = modules_text(store, &r.modules);
    if mods.is_empty() {
        return mods;
    }
    format!(
        "<leitfaden>\nFür diesen Auftrag ausgewählt (Router): {}. Weitere Module mit read_guide.\n\n{mods}\n</leitfaden>",
        r.modules.join(", ")
    )
}

/// Voller Guide und voller Katalog: für read_guide in Teilen
pub fn full_prompt(store: &Store) -> String {
    let mut v = vec![guide().to_string(), build_catalog().to_string()];
    v.extend(extras(store).into_iter().map(|m| m.text));
    v.join("\n\n")
}

// Länge wie JS (UTF-16-Einheiten), damit die Grenzen gleich fallen
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Claude Code nimmt Tool-Ergebnisse nur bis zu einer Grenze an: Teile an Abschnittsgrenzen
pub fn guide_parts(store: &Store, max: usize) -> Vec<String> {
    let full = full_prompt(store);
    let mut parts = vec![String::new()];
    for block in split_at_heads(&full, true) {
        let last = parts.last().unwrap();
        if !last.is_empty() && js_len(last) + js_len(block) + 1 > max {
            parts.push(String::new());
        }
        let last = parts.last_mut().unwrap();
        if !last.is_empty() {
            last.push('\n');
        }
        last.push_str(block);
    }
    parts
}

/// Werkzeug read_guide (tools.ts); `input` ist schon gegen das Schema geprüft.
/// ponytail: ohne Kunden-Hinweis (clientStyle), bis dw-store Kunden kennt
pub fn read_guide(store: &Store, input: &Value) -> Result<String, String> {
    let topic = input["topic"].as_str();
    if topic == Some("timeline") && !PRO {
        return Err("timeline (Mehrspur-Schnitt) gibt es nur in Deckwerk Pro.".into());
    }
    let mut want: Vec<String> = match topic {
        Some("video") => VIDEO_MODULES.map(String::from).to_vec(),
        Some("podcast") => PODCAST_MODULES.map(String::from).to_vec(),
        Some("timeline") => TIMELINE_MODULES.map(String::from).to_vec(),
        _ => vec![],
    };
    want.extend(
        input["module"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from),
    );
    if !want.is_empty() {
        let all = modules(store);
        let unknown: Vec<&str> = want
            .iter()
            .filter(|id| !all.iter().any(|m| &m.id == *id))
            .map(String::as_str)
            .collect();
        let (mut text, mut rest) = (String::new(), vec![]);
        for m in all.iter().filter(|m| want.contains(&m.id)) {
            if !text.is_empty() && js_len(&text) + js_len(&m.text) > 30000 {
                rest.push(m.id.as_str());
            } else {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(&m.text);
            }
        }
        let mut out = vec![text];
        if !rest.is_empty() {
            out.push(format!(
                "Nicht mehr in dieser Antwort, bitte erneut anfordern: {}",
                rest.join(", ")
            ));
        }
        if !unknown.is_empty() {
            out.push(format!(
                "Unbekannte Module: {} (Index: read_guide ohne Eingabe)",
                unknown.join(", ")
            ));
        }
        return Ok(out
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"));
    }
    if let Some(p) = input["part"].as_u64() {
        let parts = guide_parts(store, 20000);
        let k = (p as usize).clamp(1, parts.len());
        let more = if k < parts.len() {
            format!("\n\nWeiter: read_guide mit part {}.", k + 1)
        } else {
            String::new()
        };
        return Ok(format!(
            "Teil {k} von {}\n\n{}{more}",
            parts.len(),
            parts[k - 1]
        ));
    }
    Ok(guide_index(&modules(store)))
}

/// Kontext mit read_guide und Kernprompt aus dem Guide (übrige Hooks bleiben)
pub fn with_guide(mut ctx: dw_tools::ToolCtx) -> dw_tools::ToolCtx {
    let inner = std::mem::replace(&mut ctx.hooks, Box::new(dw_tools::NoHooks));
    ctx.hooks = Box::new(GuideHooks {
        store: ctx.store.clone(),
        inner,
    });
    ctx
}

/// Hooks mit read_guide und Kernprompt aus dem Guide; alles andere geht an `inner`
pub struct GuideHooks {
    pub store: Store,
    pub inner: Box<dyn Hooks>,
}

impl Hooks for GuideHooks {
    fn call(
        &self,
        tool: &str,
        input: &Value,
        deck: Option<&dw_model::Deck>,
    ) -> Option<Result<HookOut, String>> {
        if tool == "read_guide" {
            return Some(read_guide(&self.store, input).map(|t| HookOut {
                out: ToolOutput::text(t),
                deck: None,
            }));
        }
        self.inner.call(tool, input, deck)
    }
    fn core_prompt(&self) -> String {
        core_prompt(&self.store, false)
    }
    fn deck_fonts(&self, deck: &mut dw_model::Deck) -> Vec<String> {
        self.inner.deck_fonts(deck)
    }
    fn scene_line(
        &self,
        deck: &dw_model::Deck,
        i: usize,
        m: Option<&dw_model::Measured>,
    ) -> Option<String> {
        self.inner.scene_line(deck, i, m)
    }
    fn video_cache(&self, file: &std::path::Path) -> Option<dw_tools::VideoCache> {
        self.inner.video_cache(file)
    }
}
