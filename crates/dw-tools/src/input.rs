//! Eingabetypen der Werkzeuge: nur Schema (schemars), gleiche Felder, Grenzen und Beschreibungen wie die zod-Schemas in
//! tools.ts. Gelesen wird die geprüfte Eingabe als JSON (`run.rs`): fehlt = Feld fehlt, null = entfernen.
#![allow(dead_code)] // Felder tragen nur das Schema

use schemars::JsonSchema;
use serde_json::{Map, Value as Any};

pub use crate::schema::{CatalogThemeIds, FormatIds, LayoutIds, ThemeIds};
use crate::schema::{Enum, False, Int, Null};
use crate::values;

const BRAND_DESC: &str = if crate::PRO {
    r#"Brand-Kit; weglassen = das gespeicherte Brand-Kit des Nutzers (~/DeckwerkPro/brand.json), falls es eines gibt; null = ohne Marke"#
} else {
    r#"Brand-Kit; weglassen = das gespeicherte Brand-Kit des Nutzers (~/Deckwerk/brand.json), falls es eines gibt; null = ohne Marke"#
};
const TOPIC_DESC: &str = if crate::PRO {
    r#"video = Video-Schnitt (Guide §11) und das Layout clip, kurz für module ["video", "layout:clip"]; podcast = Podcast-Schnitt (Guide §13), kurz für module ["podcast"]; timeline = Pro-Schnitt (Guide §14) und das Layout schnitt"#
} else {
    r#"video = Video-Schnitt (Guide §11) und das Layout clip, kurz für module ["video", "layout:clip"]; podcast = Podcast-Schnitt (Guide §13), kurz für module ["podcast"]"#
};
const PATH_DESC: &str = if crate::PRO {
    r#"Pfad zur deck.json (absolut oder relativ zu ~/DeckwerkPro)"#
} else {
    r#"Pfad zur deck.json (absolut oder relativ zu ~/Deckwerk)"#
};

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    #[schemars(length(max = 120))]
    pub audience: String,
    #[schemars(length(max = 200))]
    pub goal: String,
    #[schemars(length(max = 60))]
    pub tone: String,
}

values!(
    Decor,
    ["none", "blobs", "glow", "rings", "grid", "stripe", "dots"]
);

values!(Texture, ["grain"]);

values!(TitleSize, ["normal", "large", "huge"]);

values!(TitleWeight, ["regular", "bold"]);

values!(Rule, ["none", "over", "under"]);

values!(Tone, ["normal", "accent", "invert"]);

values!(LabelFont, ["body", "mono"]);

values!(Elements, ["line", "plain", "solid"]);

values!(HeadWeight, [300, 400, 500, 600, 700, 800, 900]);

values!(Leading, ["tight", "normal", "open"]);

values!(Labels, ["sentence", "caps"]);

values!(Margin, ["standard", "generous", "asymmetric"]);

values!(Measure, ["narrow", "standard", "wide"]);

values!(SigKind, ["none", "rule", "edge", "passepartout"]);

values!(SigColor, ["accent", "field", "text"]);

values!(SigLength, ["short", "full"]);

values!(SigSide, ["left", "top"]);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub kind: Enum<SigKind>,
    pub color: Option<Enum<SigColor>>,
    #[schemars(
        description = r#"px: Linienstärke bzw. Kantenbreite"#,
        range(min = 1, max = 24)
    )]
    pub size: Option<Int>,
    #[schemars(description = r#"rule: 64 px oder volle Satzbreite"#)]
    pub length: Option<Enum<SigLength>>,
    #[schemars(description = r#"edge"#)]
    pub side: Option<Enum<SigSide>>,
}

values!(HeroTone, ["normal", "field", "invert"]);

values!(Chart, ["focus", "duo", "tonal"]);

values!(Images, ["natural", "mono", "duotone"]);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSpec {
    #[schemars(
        description = r#"Name, z. B. "Nordlicht Finance""#,
        length(min = 2, max = 40)
    )]
    pub name: String,
    #[schemars(
        description = r#"Grund: fast neutrales Weiß, höchstens ein Hauch Tönung (#FAFAF8, #F5F3EE, #EFF2EE) oder tiefer Dunkelton (Nachtblau #121D33, Tannengrün #13251C, Aubergine, Graphit). Mitteltöne, Creme und Pastell lehnt der Theme-Lint ab. Kräftige Farbgründe nur mit vivid (Stil mutig)."#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub bg: String,
    #[schemars(
        description = r#"Textfarbe; weglassen = automatisch passend"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub text: Option<String>,
    #[schemars(
        description = r#"Hauptakzent mit Charakter (Zahlen, Hervorhebungen, Akzentflächen); wird bei Bedarf für Kontrast nachgedunkelt/aufgehellt"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub accent: String,
    #[schemars(
        description = r#"Zweitfarbe für Vergleichsserien und Duotone; weglassen = neutrales Grau (empfohlen: eine Akzentfarbe reicht)"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub accent2: Option<String>,
    #[schemars(
        description = r#"Titelschrift: gebündelte Schrift oder Familie aus dem Schriftkatalog"#,
        length(max = 60)
    )]
    pub head_font: String,
    #[schemars(description = r#"Textschrift (Sans empfohlen)"#, length(max = 60))]
    pub body_font: String,
    #[schemars(
        description = r#"Eckenradius in px: 0–4 empfohlen; über 8 wirkt es schnell generiert"#,
        range(min = 0, max = 28)
    )]
    pub radius: Int,
    #[schemars(
        description = r#"Hintergrundmotiv; none empfohlen. blobs/glow (unscharfe Farbkreise) nur auf ausdrücklichen Wunsch"#
    )]
    pub decor: Enum<Decor>,
    #[schemars(description = r#"feine Papierkörnung, nur auf Wunsch"#)]
    pub texture: Option<Enum<Texture>>,
    #[schemars(
        description = r#"large = Plakat-Titel (Vortrag, Swiss, Editorial); huge = übergroße Titel, nur im Stil mutig; normal = sachlich (Chef-Update, viele Daten)"#
    )]
    pub title_size: Option<Enum<TitleSize>>,
    #[schemars(
        description = r#"regular wirkt edel und redaktionell (am besten mit Serif und titleSize large), bold sachlich und kräftig"#
    )]
    pub title_weight: Option<Enum<TitleWeight>>,
    #[schemars(
        description = r#"feine Linie: over = Kopflinie über dem Titel (Swiss, Redaktion), under = Trennlinie unter dem Kopf (Beratung), none = pur"#
    )]
    pub rule: Option<Enum<Rule>>,
    #[schemars(
        description = r#"Kapiteltrenner: accent = Akzentfläche (Standard), invert = Hell/Dunkel getauscht, normal = nur große Typo auf dem Grund"#
    )]
    pub section_tone: Option<Enum<Tone>>,
    #[schemars(
        description = r#"nur im Stil mutig: bg als kräftiger Farbgrund übernehmen (z. B. Signalgelb, Tiefblau, Ziegelrot) statt ihn auf Papier- bzw. Dunkeltöne zu dämpfen; Textfarbe kommt automatisch mit Kontrast"#
    )]
    pub vivid: Option<bool>,
    #[schemars(
        description = r#"mono = Eyebrow und Fußzeile in IBM Plex Mono (Magazin, Tech); body = Textschrift (Standard)"#
    )]
    pub label_font: Option<Enum<LabelFont>>,
    #[schemars(
        description = r#"Bauteile (Design-Guide §6): line = offen, Kopflinien statt Kästen, kurze Striche als Marker (Standard, redaktionell, Beratung); plain = nur Typografie und Weißraum, keine Linien, große leichte Nummern (Keynote, Zen, Tech); solid = Akzentflächen für Hervorhebungen, nur im Stil mutig"#
    )]
    pub elements: Option<Enum<Elements>>,
    #[schemars(
        description = r#"Farbe großer Flächen (Kapitel, split/band, heroTone field); weglassen = accent. Nur als eigene Stimme, z. B. Signalgelb zu schwarzem Akzent"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub field: Option<String>,
    #[schemars(
        description = r#"Titelgewicht, schlägt titleWeight; gebündelte Schriften nur 400/700"#
    )]
    pub head_weight: Option<Enum<HeadWeight>>,
    #[schemars(description = r#"Laufweite der Titel in em: −0.02 bis −0.04 für große Grotesk-Titel, sonst weglassen"#, range(min = -0.05, max = 0.02))]
    pub head_tracking: Option<f64>,
    #[schemars(
        description = r#"Zeilenabstand: tight = dicht (große Titel), open = luftig (Lesetext, Zen)"#
    )]
    pub leading: Option<Enum<Leading>>,
    #[schemars(description = r#"caps = Eyebrow und Fußzeile in Versalien"#)]
    pub labels: Option<Enum<Labels>>,
    #[schemars(
        description = r#"Ränder: generous = mehr Luft, asymmetric = breiter Bundsteg links (editorial)"#
    )]
    pub margin: Option<Enum<Margin>>,
    #[schemars(
        description = r#"Satzbreite: narrow ≈ 760 px (ruhig, nicht mit titleSize huge), wide = volle Breite"#
    )]
    pub measure: Option<Enum<Measure>>,
    #[schemars(
        description = r#"Genau ein wiederkehrendes Element statt Deko: rule = Haarlinie über dem Titel, edge = Farbkante am Folienrand, passepartout = Rahmenlinie mit Abstand"#
    )]
    pub signature: Option<Signature>,
    #[schemars(
        description = r#"Titel- und Schlussfolie: field = Farbfläche, invert = Hell/Dunkel getauscht, normal = Grund"#
    )]
    pub hero_tone: Option<Enum<HeroTone>>,
    #[schemars(
        description = r#"Diagrammfarben: focus = Akzent + Grau (Standard), tonal = Akzent in Helligkeitsstufen, duo = zwei Akzente (mit accent2)"#
    )]
    pub chart: Option<Enum<Chart>>,
    #[schemars(
        description = r#"ein Bildstil fürs ganze Deck: natural, mono (hält uneinheitliche Fotos zusammen), duotone (Stil mutig)"#
    )]
    pub images: Option<Enum<Images>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Brand {
    #[schemars(
        description = r#"Markenfarbe #RRGGBB"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub primary: String,
    #[schemars(regex(pattern = r#"^#[0-9a-fA-F]{6}$"#))]
    pub secondary: Option<String>,
    #[schemars(description = r#"Pfad zum Logo (aus find_images)"#)]
    pub logo: Option<String>,
    #[schemars(description = r#"Logo für dunklen Grund; fehlt es, gilt logo"#)]
    pub logo_dark: Option<String>,
    #[schemars(
        description = r#"Headline-Schrift; Office: Arial, Calibri, Georgia; alle übrigen werden eingebettet, siehe customTheme.headFont"#,
        length(max = 60)
    )]
    pub head_font: Option<String>,
    #[schemars(description = r#"Schrift für Fließtext"#, length(max = 60))]
    pub body_font: Option<String>,
    #[schemars(
        description = r#"Brand-Lock; setzt nur der Nutzer in den Einstellungen, nie selbst setzen"#
    )]
    pub lock: Option<bool>,
}

values!(
    Transition,
    [
        "none", "fade", "push", "morph", "dissolve", "wipe", "cover", "split", "circle", "zoom",
        "slide", "stack", "color"
    ]
);

values!(Mode, ["click", "auto"]);

values!(Motion, ["none", "calm", "standard", "lively"]);

values!(Style, ["sachlich", "mutig"]);

#[derive(JsonSchema)]
pub struct HeadTracking(#[schemars(range(min = -0.05, max = 0.02))] pub f64);

#[derive(JsonSchema)]
pub struct HexN(#[schemars(regex(pattern = r#"^#[0-9a-fA-F]{6}$"#))] pub String);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Tune {
    pub title_size: Option<Null<Enum<TitleSize>>>,
    pub head_weight: Option<Null<Enum<HeadWeight>>>,
    pub head_tracking: Option<Null<HeadTracking>>,
    pub leading: Option<Null<Enum<Leading>>>,
    pub labels: Option<Null<Enum<Labels>>>,
    pub label_font: Option<Null<Enum<LabelFont>>>,
    pub margin: Option<Null<Enum<Margin>>>,
    pub measure: Option<Null<Enum<Measure>>>,
    pub rule: Option<Null<Enum<Rule>>>,
    pub elements: Option<Null<Enum<Elements>>>,
    pub signature: Option<Null<Signature>>,
    pub hero_tone: Option<Null<Enum<HeroTone>>>,
    pub field: Option<Null<HexN>>,
    pub chart: Option<Null<Enum<Chart>>>,
    pub images: Option<Null<Enum<Images>>>,
}

values!(Voice, ["de", "en"]);

values!(Captions, ["satz", "aus"]);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Film {
    #[schemars(
        description = r#"Sprecherstimme, lokal erzeugt: de = Deutsch (Standard), en = Englisch. Gesprochen wird jede Szene mit Sprechertext (voice der Folie); ohne Sprechertext läuft sie nach Aufbau und Lesezeit"#
    )]
    pub voice: Option<Enum<Voice>>,
    #[schemars(description = r#"Sprechtempo 0.8–1.3, 1 = normal"#)]
    pub speed: Option<f64>,
    #[schemars(
        description = r#"satz = Untertitel ins Video eingebrannt, aus = nur .srt daneben (Standard)"#
    )]
    pub captions: Option<Enum<Captions>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BriefPatch {
    pub audience: Option<String>,
    pub goal: Option<String>,
    pub tone: Option<String>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSpecPatch {
    #[schemars(
        description = r#"Name, z. B. "Nordlicht Finance""#,
        length(min = 2, max = 40)
    )]
    pub name: Option<String>,
    #[schemars(
        description = r#"Grund: fast neutrales Weiß, höchstens ein Hauch Tönung (#FAFAF8, #F5F3EE, #EFF2EE) oder tiefer Dunkelton (Nachtblau #121D33, Tannengrün #13251C, Aubergine, Graphit). Mitteltöne, Creme und Pastell lehnt der Theme-Lint ab. Kräftige Farbgründe nur mit vivid (Stil mutig)."#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub bg: Option<String>,
    #[schemars(
        description = r#"Textfarbe; weglassen = automatisch passend"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub text: Option<String>,
    #[schemars(
        description = r#"Hauptakzent mit Charakter (Zahlen, Hervorhebungen, Akzentflächen); wird bei Bedarf für Kontrast nachgedunkelt/aufgehellt"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub accent: Option<String>,
    #[schemars(
        description = r#"Zweitfarbe für Vergleichsserien und Duotone; weglassen = neutrales Grau (empfohlen: eine Akzentfarbe reicht)"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub accent2: Option<String>,
    #[schemars(
        description = r#"Titelschrift: gebündelte Schrift oder Familie aus dem Schriftkatalog"#,
        length(max = 60)
    )]
    pub head_font: Option<String>,
    #[schemars(description = r#"Textschrift (Sans empfohlen)"#, length(max = 60))]
    pub body_font: Option<String>,
    #[schemars(
        description = r#"Eckenradius in px: 0–4 empfohlen; über 8 wirkt es schnell generiert"#,
        range(min = 0, max = 28)
    )]
    pub radius: Option<Int>,
    #[schemars(
        description = r#"Hintergrundmotiv; none empfohlen. blobs/glow (unscharfe Farbkreise) nur auf ausdrücklichen Wunsch"#
    )]
    pub decor: Option<Enum<Decor>>,
    #[schemars(description = r#"feine Papierkörnung, nur auf Wunsch"#)]
    pub texture: Option<Enum<Texture>>,
    #[schemars(
        description = r#"large = Plakat-Titel (Vortrag, Swiss, Editorial); huge = übergroße Titel, nur im Stil mutig; normal = sachlich (Chef-Update, viele Daten)"#
    )]
    pub title_size: Option<Enum<TitleSize>>,
    #[schemars(
        description = r#"regular wirkt edel und redaktionell (am besten mit Serif und titleSize large), bold sachlich und kräftig"#
    )]
    pub title_weight: Option<Enum<TitleWeight>>,
    #[schemars(
        description = r#"feine Linie: over = Kopflinie über dem Titel (Swiss, Redaktion), under = Trennlinie unter dem Kopf (Beratung), none = pur"#
    )]
    pub rule: Option<Enum<Rule>>,
    #[schemars(
        description = r#"Kapiteltrenner: accent = Akzentfläche (Standard), invert = Hell/Dunkel getauscht, normal = nur große Typo auf dem Grund"#
    )]
    pub section_tone: Option<Enum<Tone>>,
    #[schemars(
        description = r#"nur im Stil mutig: bg als kräftiger Farbgrund übernehmen (z. B. Signalgelb, Tiefblau, Ziegelrot) statt ihn auf Papier- bzw. Dunkeltöne zu dämpfen; Textfarbe kommt automatisch mit Kontrast"#
    )]
    pub vivid: Option<bool>,
    #[schemars(
        description = r#"mono = Eyebrow und Fußzeile in IBM Plex Mono (Magazin, Tech); body = Textschrift (Standard)"#
    )]
    pub label_font: Option<Enum<LabelFont>>,
    #[schemars(
        description = r#"Bauteile (Design-Guide §6): line = offen, Kopflinien statt Kästen, kurze Striche als Marker (Standard, redaktionell, Beratung); plain = nur Typografie und Weißraum, keine Linien, große leichte Nummern (Keynote, Zen, Tech); solid = Akzentflächen für Hervorhebungen, nur im Stil mutig"#
    )]
    pub elements: Option<Enum<Elements>>,
    #[schemars(
        description = r#"Farbe großer Flächen (Kapitel, split/band, heroTone field); weglassen = accent. Nur als eigene Stimme, z. B. Signalgelb zu schwarzem Akzent"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub field: Option<String>,
    #[schemars(
        description = r#"Titelgewicht, schlägt titleWeight; gebündelte Schriften nur 400/700"#
    )]
    pub head_weight: Option<Enum<HeadWeight>>,
    #[schemars(description = r#"Laufweite der Titel in em: −0.02 bis −0.04 für große Grotesk-Titel, sonst weglassen"#, range(min = -0.05, max = 0.02))]
    pub head_tracking: Option<f64>,
    #[schemars(
        description = r#"Zeilenabstand: tight = dicht (große Titel), open = luftig (Lesetext, Zen)"#
    )]
    pub leading: Option<Enum<Leading>>,
    #[schemars(description = r#"caps = Eyebrow und Fußzeile in Versalien"#)]
    pub labels: Option<Enum<Labels>>,
    #[schemars(
        description = r#"Ränder: generous = mehr Luft, asymmetric = breiter Bundsteg links (editorial)"#
    )]
    pub margin: Option<Enum<Margin>>,
    #[schemars(
        description = r#"Satzbreite: narrow ≈ 760 px (ruhig, nicht mit titleSize huge), wide = volle Breite"#
    )]
    pub measure: Option<Enum<Measure>>,
    #[schemars(
        description = r#"Genau ein wiederkehrendes Element statt Deko: rule = Haarlinie über dem Titel, edge = Farbkante am Folienrand, passepartout = Rahmenlinie mit Abstand"#
    )]
    pub signature: Option<Signature>,
    #[schemars(
        description = r#"Titel- und Schlussfolie: field = Farbfläche, invert = Hell/Dunkel getauscht, normal = Grund"#
    )]
    pub hero_tone: Option<Enum<HeroTone>>,
    #[schemars(
        description = r#"Diagrammfarben: focus = Akzent + Grau (Standard), tonal = Akzent in Helligkeitsstufen, duo = zwei Akzente (mit accent2)"#
    )]
    pub chart: Option<Enum<Chart>>,
    #[schemars(
        description = r#"ein Bildstil fürs ganze Deck: natural, mono (hält uneinheitliche Fotos zusammen), duotone (Stil mutig)"#
    )]
    pub images: Option<Enum<Images>>,
}

#[derive(JsonSchema)]
pub struct Str60(#[schemars(length(max = 60))] pub String);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Music {
    #[schemars(
        description = r#"asset://-Pfad aus find_music oder absoluter Pfad einer Audiodatei"#,
        length(min = 1)
    )]
    pub src: String,
    #[schemars(
        description = r#"0–1, Standard 0,25; dezent bleiben"#,
        range(min = 0, max = 1)
    )]
    pub volume: Option<f64>,
    #[schemars(
        description = r#"Nachweis aus find_music (bei CC BY Pflicht), zusätzlich in die Notes der letzten Folie"#,
        length(max = 300)
    )]
    pub credit: Option<String>,
}

values!(VideoRes, ["720p", "1080p", "1440p", "4k", "8k"]);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FilmPatch {
    #[schemars(description = r#"de, en; null = Standard (de)"#)]
    pub voice: Option<Null<Enum<Voice>>>,
    #[schemars(description = r#"Sprechtempo 0.8–1.3, 1 = normal"#)]
    pub speed: Option<f64>,
    #[schemars(
        description = r#"satz = Untertitel ins Video eingebrannt, aus = nur .srt daneben (Standard)"#
    )]
    pub captions: Option<Enum<Captions>>,
}

values!(
    Build,
    [
        "none", "fade", "list", "stagger", "wipe", "zoom-kpi", "pan", "pop", "words", "photo"
    ]
);

values!(Frame, ["top", "split", "band", "center"]);

values!(
    ItemKind,
    [
        "text", "shape", "image", "icon", "chart", "video", "audio", "qr", "graphic", "table"
    ]
);

values!(
    Anim,
    [
        "none",
        "fade",
        "float",
        "pan",
        "drift",
        "pop",
        "zoom",
        "tumble",
        "stomp",
        "baseline",
        "wipe",
        "typewriter",
        "ascend",
        "breathe",
        "draw"
    ]
);

values!(AnimDir, ["right", "left", "up", "down"]);

values!(AnimSpeed, ["slow", "fast"]);

values!(AnimStart, ["click", "with", "after"]);

values!(Ease, ["weich", "feder", "linear"]);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemKey {
    #[schemars(
        description = r#"Takt (0 = Szenenbeginn, [klick] im Sprechertext = nächster)"#,
        range(min = 0, max = 20)
    )]
    pub step: Int,
    #[schemars(range(min = -2000, max = 4000))]
    pub x: Option<f64>,
    #[schemars(range(min = -2000, max = 4000))]
    pub y: Option<f64>,
    #[schemars(range(max = 4000), extend("exclusiveMinimum" = 0))]
    pub w: Option<f64>,
    #[schemars(range(max = 4000), extend("exclusiveMinimum" = 0))]
    pub h: Option<f64>,
    #[schemars(range(min = -720, max = 720))]
    pub rot: Option<f64>,
    #[schemars(range(min = 0, max = 1))]
    pub opacity: Option<f64>,
    #[schemars(regex(pattern = r#"^#[0-9a-fA-F]{6}$"#))]
    pub fill: Option<String>,
    #[schemars(regex(pattern = r#"^#[0-9a-fA-F]{6}$"#))]
    pub color: Option<String>,
    #[schemars(
        description = r#"weich (Standard), feder = federt leicht über das Ziel (sparsam), linear"#
    )]
    pub ease: Option<Enum<Ease>>,
    #[schemars(description = r#"Dauer, Standard 800"#, range(min = 100, max = 5000))]
    pub ms: Option<f64>,
}

values!(List, ["bullet", "number"]);

values!(Effect, ["none", "shadow", "lift", "hollow", "neon"]);

values!(Align, ["left", "center", "right"]);

values!(
    Shape,
    [
        "rect",
        "ellipse",
        "triangle",
        "diamond",
        "hexagon",
        "star",
        "arrow",
        "line",
        "chevron",
        "pentagon",
        "trapezoid",
        "parallelogram",
        "rtTriangle",
        "octagon",
        "donut",
        "plus",
        "heart",
        "star4",
        "star6",
        "star8",
        "star12"
    ]
);

values!(LineStart, ["none", "arrow", "triangle", "dot"]);

values!(Dash, ["solid", "dash", "dot"]);

values!(Look, ["natural", "duotone", "mono"]);

values!(
    Mask,
    [
        "circle", "arch", "hexagon", "diamond", "octagon", "star", "heart"
    ]
);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Adjust {
    #[schemars(range(min = -100, max = 100))]
    pub bright: Option<f64>,
    #[schemars(range(min = -100, max = 100))]
    pub contrast: Option<f64>,
    #[schemars(range(min = -100, max = 100))]
    pub sat: Option<f64>,
    #[schemars(range(min = 0, max = 100))]
    pub blur: Option<f64>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    #[schemars(range(min = 0, max = 1))]
    pub x: f64,
    #[schemars(range(min = 0, max = 1))]
    pub y: f64,
    #[schemars(range(min = 0.01, max = 1))]
    pub w: f64,
    #[schemars(range(min = 0.01, max = 1))]
    pub h: f64,
}

values!(
    ChartType,
    ["bar", "hbar", "stacked", "waterfall", "line", "donut"]
);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub name: String,
    pub values: Vec<f64>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartLink {
    pub file: String,
    pub sheet: Option<String>,
    #[schemars(regex(pattern = r#"^\$?[A-Z]{1,3}\$?\d+:\$?[A-Z]{1,3}\$?\d+$"#))]
    pub range: String,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChartSpec {
    pub r#type: Enum<ChartType>,
    #[schemars(length(min = 1, max = 24))]
    pub categories: Vec<String>,
    #[schemars(length(min = 1, max = 6))]
    pub series: Vec<Series>,
    #[schemars(length(max = 12))]
    pub unit: Option<String>,
    #[schemars(description = r#"Excel-Quelle (Deckwerk Pro); setzt die App, nie die KI"#)]
    pub link: Option<ChartLink>,
}

#[derive(JsonSchema)]
pub struct CellText(#[schemars(length(max = 200))] pub String);

#[derive(JsonSchema)]
pub struct CellRow(#[schemars(length(min = 1, max = 8))] pub Vec<CellText>);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemIn {
    #[schemars(
        description = r#"weglassen = neu; vorhandene ID = dieses Element ersetzen"#,
        length(max = 40)
    )]
    pub id: Option<String>,
    #[schemars(
        description = r#"qr: text = URL; graphic: handgezeichnete Deko (graphic = Name), Farbe über color; table: cells, Schrift über size/color, Linien über stroke"#
    )]
    pub kind: Enum<ItemKind>,
    #[schemars(
        description = r#"gleiche ID = Gruppe (zusammen verschieben/skalieren)"#,
        length(max = 40)
    )]
    pub group: Option<String>,
    #[schemars(range(min = -1280, max = 2560))]
    pub x: f64,
    #[schemars(range(min = -720, max = 1440))]
    pub y: f64,
    #[schemars(range(min = 1, max = 3000))]
    pub w: f64,
    #[schemars(
        description = r#"Text: wird aus dem Inhalt berechnet, trotzdem angeben"#,
        range(min = 0, max = 3000)
    )]
    pub h: f64,
    #[schemars(range(min = -360, max = 360))]
    pub rot: Option<f64>,
    #[schemars(range(min = 0, max = 1))]
    pub opacity: Option<f64>,
    pub locked: Option<bool>,
    #[schemars(
        description = r#"Auftritt beim Präsentieren wie in Canva (je ein Klick): typewriter/ascend nur für Text, breathe pulsiert ohne Klick, draw zeichnet Linie, Pfeil, Umriss oder Icon. Design-Guide §8"#
    )]
    pub anim: Option<Enum<Anim>>,
    #[schemars(
        description = r#"Richtung der Bewegung bei pan, drift, wipe, float (Standard: pan/drift/wipe nach rechts, float nach oben)"#
    )]
    pub anim_dir: Option<Enum<AnimDir>>,
    #[schemars(description = r#"Tempo der Animation; weglassen = normal"#)]
    pub anim_speed: Option<Enum<AnimSpeed>>,
    #[schemars(
        description = r#"Start wie in PowerPoint: click = bei Klick, with = mit vorherigem, after = nach vorherigem; weglassen = je ein Klick (Selbstlauf: nacheinander). Nicht für breathe"#
    )]
    pub anim_start: Option<Enum<AnimStart>>,
    #[schemars(
        description = r#"Verzögerung vor dem Auftritt in Sekunden. Nicht für breathe"#,
        range(min = 0, max = 10)
    )]
    pub anim_delay: Option<f64>,
    #[schemars(
        description = r#"Nur im Film: Bewegung je Takt, zu Beginn von step gleitet das Element auf diese Werte (px wie x/y/w/h). Präsentation und PowerPoint zeigen die Grundlage. read_guide Modul film"#,
        length(max = 12)
    )]
    pub keys: Option<Vec<ItemKey>>,
    #[schemars(length(max = 600))]
    pub text: Option<String>,
    #[schemars(
        description = r#"head/body = Theme-Schrift, sonst Schriftname wie customTheme.headFont"#,
        length(max = 60)
    )]
    pub font: Option<String>,
    #[schemars(
        description = r#"Schriftgröße in px (1 px = 0,75 pt)"#,
        range(min = 8, max = 400)
    )]
    pub size: Option<f64>,
    #[schemars(
        description = r#"Text- oder Iconfarbe; weglassen = Theme"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub color: Option<String>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub upper: Option<bool>,
    #[schemars(description = r#"Aufzählung: jede Zeile des Texts ein Punkt bzw. nummeriert"#)]
    pub list: Option<Enum<List>>,
    #[schemars(
        description = r#"Texteffekt: shadow, lift (weicher Schatten), hollow (nur Kontur), neon (Leuchten)"#
    )]
    pub effect: Option<Enum<Effect>>,
    #[schemars(regex(pattern = r#"^#[0-9a-fA-F]{6}$"#))]
    pub effect_color: Option<String>,
    pub align: Option<Enum<Align>>,
    #[schemars(range(min = 0.7, max = 3))]
    pub line_height: Option<f64>,
    #[schemars(range(min = -0.1, max = 0.5))]
    pub spacing: Option<f64>,
    pub shape: Option<Enum<Shape>>,
    pub line_start: Option<Enum<LineStart>>,
    #[schemars(
        description = r#"Linienenden der Form line: arrow = offene Spitze, triangle = gefüllt, dot = Punkt"#
    )]
    pub line_end: Option<Enum<LineStart>>,
    #[schemars(length(max = 40))]
    pub from: Option<String>,
    #[schemars(
        description = r#"nur Form line: IDs zweier Elemente; die Linie verbindet sie und wandert beim Verschieben mit (Konnektor), x/y/w egal"#,
        length(max = 40)
    )]
    pub to: Option<String>,
    #[schemars(description = r#"Strichart von Linie oder Umriss"#)]
    pub dash: Option<Enum<Dash>>,
    #[schemars(regex(pattern = r#"^#[0-9a-fA-F]{6}$"#))]
    pub fill: Option<String>,
    #[schemars(
        description = r#"Verlauf zu dieser Farbe (Rechteck/Ellipse)"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub fill2: Option<String>,
    #[schemars(
        description = r#"Winkel des Verlaufs in Grad, Standard 135"#,
        range(min = 0, max = 360)
    )]
    pub grad_angle: Option<f64>,
    #[schemars(regex(pattern = r#"^#[0-9a-fA-F]{6}$"#))]
    pub stroke: Option<String>,
    #[schemars(range(min = 0, max = 40))]
    pub stroke_w: Option<f64>,
    #[schemars(range(min = 0, max = 400))]
    pub radius: Option<f64>,
    pub shadow: Option<bool>,
    #[schemars(description = r#"asset://-Pfad aus find_images"#)]
    pub src: Option<String>,
    pub look: Option<Enum<Look>>,
    #[schemars(description = r#"Bildrahmen (Form)"#)]
    pub mask: Option<Enum<Mask>>,
    #[schemars(description = r#"Bildanpassung in Prozent"#)]
    pub adjust: Option<Adjust>,
    pub round: Option<bool>,
    pub flip_x: Option<bool>,
    #[schemars(
        description = r#"Bildausschnitt in Anteilen; w/h des Elements sollte zum Ausschnitt passen"#
    )]
    pub crop: Option<Crop>,
    #[schemars(
        description = r#"Alternativtext: was das Bild zeigt (Screenreader, PPTX)"#,
        length(max = 250)
    )]
    pub alt: Option<String>,
    #[schemars(
        description = r#"Klickziel: https://… oder #N = Sprung zu Folie N"#,
        length(max = 500),
        regex(pattern = r#"^(https?:\/\/|mailto:|#\d+$)"#)
    )]
    pub link: Option<String>,
    pub poster: Option<String>,
    pub autoplay: Option<bool>,
    pub r#loop: Option<bool>,
    pub muted: Option<bool>,
    #[schemars(description = r#"lucide-Name in kebab-case"#, length(max = 40))]
    pub icon: Option<String>,
    #[schemars(
        description = r#"Deko-Grafik: squiggle, swoosh, scribble, arrow, burst, waves, sparkle, blob (siehe GRAPHICS)"#,
        length(max = 20)
    )]
    pub graphic: Option<String>,
    pub spec: Option<ChartSpec>,
    #[schemars(
        description = r#"nur table: Zeilen mit gleich vielen Zellen, erste Zeile = Kopfzeile; Zahlen stehen rechtsbündig. h ergibt sich aus dem Inhalt"#,
        length(min = 1, max = 16)
    )]
    pub cells: Option<Vec<CellRow>>,
}

#[derive(JsonSchema)]
pub struct Hex(#[schemars(regex(pattern = r#"^#[0-9a-fA-F]{6}$"#))] pub String);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SlideBg {
    #[schemars(regex(pattern = r#"^#[0-9a-fA-F]{6}$"#))]
    pub color: Option<String>,
    #[schemars(description = r#"asset://-Pfad"#)]
    pub image: Option<String>,
    #[schemars(description = r#"Verlauf von → nach"#)]
    pub gradient: Option<(Hex, Hex)>,
    #[schemars(range(min = 0, max = 360))]
    pub angle: Option<f64>,
}

#[derive(JsonSchema)]
pub struct Share(#[schemars(range(min = 0, max = 1))] pub f64);

#[derive(JsonSchema)]
pub struct ShareMin(#[schemars(range(min = 0.1, max = 1))] pub f64);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CameraMove {
    #[schemars(
        description = r#"Takt, mit dem die Kamera fährt (0 = Szenenbeginn)"#,
        range(min = 0, max = 20)
    )]
    pub step: Int,
    #[schemars(
        description = r#"[x, y, w, h] als Anteile der Folie (0,0 = oben links): dieser Ausschnitt bleibt ganz sichtbar; weglassen = zurück zur ganzen Folie"#
    )]
    pub r#box: Option<(Share, Share, ShareMin, ShareMin)>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SlideIn {
    pub layout: Enum<LayoutIds>,
    pub variant: Option<String>,
    #[schemars(description = r#"Inhalt nach dem Schema des Layouts (siehe Katalog)"#)]
    pub content: Map<String, Any>,
    #[schemars(description = r#"Animations-Preset; weglassen = Default des Layouts"#)]
    pub build: Option<Enum<Build>>,
    #[schemars(
        description = r#"Übergang zu dieser Folie; weglassen = Deck-Übergang. Praktisch nur für morph: wörtlich gleicher Text, dasselbe Foto oder derselbe Platz im Layout wandert von der vorigen Folie herüber (Design-Guide §8). In Video-Decks (MP4): fade, dissolve u. a. = echte Überblendung zur vorigen Folie, color = über Schwarz, none = harter Schnitt zwischen zwei Clips (Zwischentitel blenden dann über Schwarz); gezielt an Zwischentiteln, Orts- oder Kapitelwechseln (Guide §11)"#
    )]
    pub transition: Option<Enum<Transition>>,
    #[schemars(description = r#"Folien-Ton; weglassen = Standard des Layouts"#)]
    pub tone: Option<Enum<Tone>>,
    #[schemars(description = r#"Dekor-Motiv; weglassen = Standard des Themes"#)]
    pub decor: Option<Enum<Decor>>,
    #[schemars(
        description = r#"Komposition: top = Titel oben (Standard), split = Titel auf Akzentfläche links, band = Titel im Farbband oben, center = Kopf zentriert. Nur die im Katalog genannten Frames des Layouts."#
    )]
    pub frame: Option<Enum<Frame>>,
    #[schemars(description = r#"Speaker Notes"#, length(max = 1500))]
    pub notes: Option<String>,
    #[schemars(
        description = r#"Freie Elemente über dem Layout (px auf 1280×720). Nur für Layout blank oder wenn der Nutzer frei gestalten will."#,
        length(max = 60)
    )]
    pub items: Option<Vec<ItemIn>>,
    #[schemars(description = r#"Eigener Folienhintergrund statt Theme"#)]
    pub bg: Option<SlideBg>,
    #[schemars(
        description = r#"Nur Film-Decks: Sprechertext der Szene in ganzen Sätzen, höchstens ~40 Wörter; [klick] startet den nächsten Takt (Aufbau, Mauszeiger, Kamera) mit dem folgenden Satz. read_guide Modul film"#,
        length(max = 1500)
    )]
    pub voice: Option<String>,
    #[schemars(
        description = r#"Nur Film-Decks: Szenenlänge in s; weglassen = aus Stimme, Aufbau und Lesezeit (die Stimme wird nie abgeschnitten)"#,
        range(min = 1, max = 120)
    )]
    pub duration: Option<f64>,
    #[schemars(
        description = r#"Nur Film-Decks: Kamerafahrt je Takt (0,8 s weich), sparsam: 1–2 Fahrten auf das, worüber die Stimme gerade spricht. read_guide Modul film"#,
        length(max = 8)
    )]
    pub camera: Option<Vec<CameraMove>>,
}

values!(
    BuildN,
    [
        "none", "fade", "list", "stagger", "wipe", "zoom-kpi", "pan", "pop", "words", "photo"
    ],
    r#"Animations-Preset; weglassen = Default des Layouts"#
);

values!(
    SlideTransition,
    [
        "none", "fade", "push", "morph", "dissolve", "wipe", "cover", "split", "circle", "zoom",
        "slide", "stack", "color"
    ],
    r#"Übergang zu dieser Folie; weglassen = Deck-Übergang. Praktisch nur für morph: wörtlich gleicher Text, dasselbe Foto oder derselbe Platz im Layout wandert von der vorigen Folie herüber (Design-Guide §8). In Video-Decks (MP4): fade, dissolve u. a. = echte Überblendung zur vorigen Folie, color = über Schwarz, none = harter Schnitt zwischen zwei Clips (Zwischentitel blenden dann über Schwarz); gezielt an Zwischentiteln, Orts- oder Kapitelwechseln (Guide §11)"#
);

#[derive(JsonSchema)]
pub struct NotesN(#[schemars(length(max = 1500))] pub String);

#[derive(JsonSchema)]
pub struct ItemsN(#[schemars(length(max = 60))] pub Vec<ItemIn>);

#[derive(JsonSchema)]
#[schemars(description = r#"Eigener Folienhintergrund statt Theme"#)]
#[serde(rename_all = "camelCase")]
pub struct SlideBgN {
    #[schemars(regex(pattern = r#"^#[0-9a-fA-F]{6}$"#))]
    pub color: Option<String>,
    #[schemars(description = r#"asset://-Pfad"#)]
    pub image: Option<String>,
    #[schemars(description = r#"Verlauf von → nach"#)]
    pub gradient: Option<(Hex, Hex)>,
    #[schemars(range(min = 0, max = 360))]
    pub angle: Option<f64>,
}

#[derive(JsonSchema)]
#[schemars(
    description = r#"Nur Film-Decks: Sprechertext der Szene in ganzen Sätzen, höchstens ~40 Wörter; [klick] startet den nächsten Takt (Aufbau, Mauszeiger, Kamera) mit dem folgenden Satz. read_guide Modul film"#
)]
pub struct VoiceTextN(#[schemars(length(max = 1500))] pub String);

#[derive(JsonSchema)]
#[schemars(
    description = r#"Nur Film-Decks: Szenenlänge in s; weglassen = aus Stimme, Aufbau und Lesezeit (die Stimme wird nie abgeschnitten)"#
)]
pub struct DurationN(#[schemars(range(min = 1, max = 120))] pub f64);

#[derive(JsonSchema)]
#[schemars(
    description = r#"Nur Film-Decks: Kamerafahrt je Takt (0,8 s weich), sparsam: 1–2 Fahrten auf das, worüber die Stimme gerade spricht. read_guide Modul film"#
)]
pub struct CameraN(#[schemars(length(max = 8))] pub Vec<CameraMove>);

values!(AccentKind, ["shape", "icon", "graphic"]);

values!(
    Graphic,
    [
        "squiggle", "swoosh", "scribble", "arrow", "burst", "waves", "sparkle", "blob"
    ]
);

values!(
    AccentShape,
    [
        "star12", "star8", "star4", "donut", "plus", "heart", "ellipse"
    ]
);

values!(
    Zone,
    ["top-right", "bottom-right", "bottom-left", "top-left"]
);

values!(AccentSize, ["s", "m", "l"]);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Accent {
    pub kind: Enum<AccentKind>,
    #[schemars(
        description = r#"handgezeichnet: sparkle = Funkeln, squiggle = Kringel, burst = Strahlen, blob = Klecks, arrow, scribble, swoosh, waves"#
    )]
    pub graphic: Option<Enum<Graphic>>,
    #[schemars(description = r#"star12 = Siegel/Sticker, star4 = Funkeln, donut = Ring"#)]
    pub shape: Option<Enum<AccentShape>>,
    #[schemars(description = r#"lucide-Name, z. B. "sparkles""#, length(max = 40))]
    pub icon: Option<String>,
    pub zone: Enum<Zone>,
    #[schemars(extend("default" = "m"))]
    pub size: Option<Enum<AccentSize>>,
    #[schemars(
        description = r#"weglassen = Zweitakzent des Themes"#,
        regex(pattern = r#"^#[0-9a-fA-F]{6}$"#)
    )]
    pub color: Option<String>,
    #[schemars(range(min = -45, max = 45))]
    pub rot: Option<f64>,
}

#[derive(JsonSchema)]
pub struct AtSec(#[schemars(range(min = 0, max = 600))] pub f64);

#[derive(JsonSchema)]
#[serde(untagged)]
pub enum LookIn {
    A(Enum<CatalogThemeIds>),
    B(Box<ThemeSpec>),
}

values!(Topic, ["video", "podcast", "timeline"]);

values!(Source, ["auto", "local", "unsplash", "web"]);

values!(Orientation, ["landscape", "portrait", "squarish"]);

values!(Orientation2, ["landscape", "portrait", "square"]);

values!(Provider, ["mammouth", "openai", "codex"]);

values!(
    ExportFormat,
    [
        "pptx", "docx", "pdf", "png", "zip", "md", "print", "clips", "mp4", "mp3", "m4a"
    ]
);

values!(PrintSize, ["a2", "a3", "a4", "a5", "a6"]);

values!(BatchFormat, ["9:16", "1:1", "4:5", "16:9"]);

#[derive(JsonSchema)]
pub struct Sec(#[schemars(range(min = 0))] pub f64);

values!(Device, ["desktop", "handy"]);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeTrack {
    #[schemars(
        description = r#"Quellvideo oder Audiodatei (Podcast): asset://-Pfad aus dem Anhang („Video: asset://…“), aus import_video oder absoluter Dateipfad"#,
        length(min = 1)
    )]
    pub src: String,
    #[schemars(description = r#"Sprecher oder Spur, z. B. „Anna“"#, length(max = 40))]
    pub name: Option<String>,
}

values!(Ton, ["original", "klar", "stark"]);

#[derive(JsonSchema)]
#[serde(untagged)]
pub enum Pauses {
    A(#[schemars(range(min = 0.3, max = 5))] f64),
    B(False),
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Clean {
    #[schemars(
        description = r#"längere Pausen auf diese Länge in s kürzen, üblich 0.6; false = Pausen wieder ungekürzt"#
    )]
    pub pauses: Option<Pauses>,
    #[schemars(
        description = r#"Füllwörter (äh, ähm …) herausschneiden; braucht das Transkript der Spuren"#
    )]
    pub fillers: Option<bool>,
    #[schemars(
        description = r#"Versprecher und verworfene Neuansätze herausschneiden; braucht das Transkript"#
    )]
    pub retakes: Option<bool>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CutItem {
    #[schemars(range(min = 0))]
    pub start: f64,
    #[schemars(range(min = 0))]
    pub end: f64,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SfxItem {
    #[schemars(length(min = 1))]
    pub src: String,
    #[schemars(description = r#"Quellsekunde"#, range(min = 0))]
    pub at: f64,
    #[schemars(description = r#"dB"#, range(min = -24, max = 12))]
    pub gain: Option<f64>,
}

#[derive(JsonSchema)]
pub struct SrcN(#[schemars(length(min = 1))] pub String);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    #[schemars(description = r#"Quellsekunde"#, range(min = 0))]
    pub at: f64,
    #[schemars(length(min = 1, max = 80))]
    pub title: String,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrackPatch {
    #[schemars(description = r#"0 = erste Spur"#, range(min = 0, max = 3))]
    pub index: Int,
    #[schemars(length(max = 40))]
    pub name: Option<String>,
    #[schemars(description = r#"dB"#, range(min = -12, max = 12))]
    pub gain: Option<f64>,
    pub mute: Option<bool>,
}

#[derive(JsonSchema)]
#[serde(untagged)]
pub enum SlideRef {
    A(String),
    B(#[schemars(range(min = 1, max = 9007199254740991_i64))] Int),
}

values!(Edge, ["in", "out"]);

#[derive(JsonSchema)]
pub struct Db(#[schemars(range(min = -60, max = 12))] pub f64);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Eq3 {
    #[schemars(range(min = -12, max = 12))]
    pub low: Option<f64>,
    #[schemars(range(min = -12, max = 12))]
    pub mid: Option<f64>,
    #[schemars(range(min = -12, max = 12))]
    pub high: Option<f64>,
}

#[derive(JsonSchema)]
pub struct Lift(#[schemars(range(min = -0.5, max = 0.5))] pub f64);

#[derive(JsonSchema)]
pub struct Gain(#[schemars(range(min = 0.5, max = 2))] pub f64);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Grade {
    pub lift: Option<(Lift, Lift, Lift)>,
    pub gamma: Option<(Gain, Gain, Gain)>,
    pub gain: Option<(Gain, Gain, Gain)>,
    #[schemars(range(min = 0, max = 2))]
    pub sat: Option<f64>,
    #[schemars(range(min = -1, max = 1))]
    pub temp: Option<f64>,
}

values!(Fit, ["crop", "contain"]);

#[derive(JsonSchema)]
pub struct BoxW(#[schemars(range(min = 0.05, max = 1))] pub f64);

#[derive(JsonSchema)]
pub struct FadeSec(#[schemars(range(min = 0, max = 10))] pub f64);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TlClip {
    #[schemars(description = r#"eindeutige Clip-ID, z. B. c1"#, length(min = 1))]
    pub id: Option<String>,
    #[schemars(description = r#"Quelldatei: asset://-Pfad oder absoluter Pfad"#)]
    pub src: String,
    #[schemars(description = r#"Lage auf der Zeitachse (s)"#, range(min = 0))]
    pub at: f64,
    #[schemars(description = r#"Quellsekunde Anfang"#, range(min = 0))]
    pub r#in: f64,
    #[schemars(description = r#"Quellsekunde Ende"#, range(min = 0))]
    pub out: f64,
    #[schemars(description = r#"Tempo, Standard 1"#, range(min = 0.25, max = 4))]
    pub speed: Option<f64>,
    #[schemars(description = r#"Pegel 0..2, Standard 1"#, range(min = 0, max = 2))]
    pub volume: Option<f64>,
    #[schemars(
        description = r#"Pegel-Stützpunkte [Quellsekunde, dB]"#,
        length(max = 100)
    )]
    pub keys: Option<Vec<(Sec, Db)>>,
    #[schemars(description = r#"EQ in dB bei 100 Hz, 1 kHz, 8 kHz"#)]
    pub eq: Option<Eq3>,
    #[schemars(description = r#"Farbe: lift/gamma/gain je [r, g, b], sat, temp"#)]
    pub grade: Option<Grade>,
    pub mute: Option<bool>,
    #[schemars(description = r#"crop füllt das Bild (Standard), contain zeigt alles"#)]
    pub fit: Option<Enum<Fit>>,
    #[schemars(
        description = r#"horizontaler Bildmittelpunkt bei crop"#,
        range(min = 0, max = 1)
    )]
    pub focus: Option<f64>,
    #[schemars(description = r#"Bild-in-Bild [x, y, Breite] als Anteile (V2+)"#)]
    pub r#box: Option<(Share, Share, BoxW)>,
    #[schemars(description = r#"Ein-/Ausblenden [Anfang, Ende] in s"#)]
    pub fade: Option<(FadeSec, FadeSec)>,
    #[schemars(
        description = r#"Überblendung vom Clip direkt davor (s), mittig über dem Schnitt"#,
        range(min = 0, max = 5)
    )]
    pub xfade: Option<f64>,
}

values!(TrackKind, ["video", "audio"]);

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TlPatch {
    #[schemars(description = r#"Quelldatei: asset://-Pfad oder absoluter Pfad"#)]
    pub src: Option<String>,
    #[schemars(description = r#"Lage auf der Zeitachse (s)"#, range(min = 0))]
    pub at: Option<f64>,
    #[schemars(description = r#"Quellsekunde Anfang"#, range(min = 0))]
    pub r#in: Option<f64>,
    #[schemars(description = r#"Quellsekunde Ende"#, range(min = 0))]
    pub out: Option<f64>,
    #[schemars(description = r#"Tempo, Standard 1"#, range(min = 0.25, max = 4))]
    pub speed: Option<f64>,
    #[schemars(description = r#"Pegel 0..2, Standard 1"#, range(min = 0, max = 2))]
    pub volume: Option<f64>,
    #[schemars(
        description = r#"Pegel-Stützpunkte [Quellsekunde, dB]"#,
        length(max = 100)
    )]
    pub keys: Option<Vec<(Sec, Db)>>,
    #[schemars(description = r#"EQ in dB bei 100 Hz, 1 kHz, 8 kHz"#)]
    pub eq: Option<Eq3>,
    #[schemars(description = r#"Farbe: lift/gamma/gain je [r, g, b], sat, temp"#)]
    pub grade: Option<Grade>,
    pub mute: Option<bool>,
    #[schemars(description = r#"crop füllt das Bild (Standard), contain zeigt alles"#)]
    pub fit: Option<Enum<Fit>>,
    #[schemars(
        description = r#"horizontaler Bildmittelpunkt bei crop"#,
        range(min = 0, max = 1)
    )]
    pub focus: Option<f64>,
    #[schemars(description = r#"Bild-in-Bild [x, y, Breite] als Anteile (V2+)"#)]
    pub r#box: Option<(Share, Share, BoxW)>,
    #[schemars(description = r#"Ein-/Ausblenden [Anfang, Ende] in s"#)]
    pub fade: Option<(FadeSec, FadeSec)>,
    #[schemars(
        description = r#"Überblendung vom Clip direkt davor (s), mittig über dem Schnitt"#,
        range(min = 0, max = 5)
    )]
    pub xfade: Option<f64>,
}

values!(Res, [720, 1080, 1440, 2160]);

values!(Codec, ["h264", "h264-10", "prores", "dnxhr"]);

#[derive(JsonSchema)]
#[serde(tag = "op")]
pub enum TlOp {
    #[serde(rename = "split")]
    Split {
        clip: String,
        #[schemars(description = r#"Timeline-Sekunde"#, range(min = 0))]
        t: f64,
    },
    #[serde(rename = "trim")]
    Trim {
        clip: String,
        edge: Enum<Edge>,
        #[schemars(description = r#"Timeline-Sekunde"#, range(min = 0))]
        t: f64,
        #[schemars(description = r#"true = spätere Clips der Spur rücken mit"#)]
        ripple: Option<bool>,
    },
    #[serde(rename = "move")]
    Move {
        clip: String,
        #[schemars(description = r#"Timeline-Sekunde"#, range(min = 0))]
        at: f64,
        #[schemars(description = r#"andere Spur gleicher Art"#)]
        track: Option<String>,
    },
    #[schemars(description = r#"entfernen, Lücke bleibt"#)]
    #[serde(rename = "lift")]
    Lift { clip: String },
    #[schemars(description = r#"entfernen, Spätere rücken nach"#)]
    #[serde(rename = "ripple_delete")]
    RippleDelete { clip: String },
    #[serde(rename = "add_clip")]
    AddClip { track: String, clip: TlClip },
    #[schemars(description = r#"neue Spur ganz oben"#)]
    #[serde(rename = "add_track")]
    AddTrack { kind: Enum<TrackKind> },
    #[schemars(description = r#"Felder eines Clips setzen (grade, volume, box, src …)"#)]
    #[serde(rename = "set")]
    Set { clip: String, patch: TlPatch },
    #[schemars(
        description = r#"Inhalt durch alle sichtbaren clip-Folien des Decks ersetzen (hintereinander auf v1)"#
    )]
    #[serde(rename = "from_clips")]
    FromClips {},
    #[schemars(description = r#"Ausgabe setzen"#)]
    #[serde(rename = "deliver")]
    Deliver {
        res: Option<Enum<Res>>,
        #[schemars(range(min = 10, max = 120))]
        fps: Option<f64>,
        codec: Option<Enum<Codec>>,
        #[schemars(range(min = -30, max = -9))]
        lufs: Option<f64>,
    },
    #[schemars(
        description = r#"Untertitel aus dem Transkript der Clip-Quelle (in–out), ersetzt die Untertitel in der Clip-Zeit"#
    )]
    #[serde(rename = "subs_from_transcript")]
    SubsFromTranscript { clip: String },
    #[serde(rename = "marker")]
    Marker {
        #[schemars(description = r#"Timeline-Sekunde"#, range(min = 0))]
        t: f64,
        #[schemars(length(max = 60))]
        name: String,
    },
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateDeck {
    #[schemars(length(max = 80))]
    pub title: String,
    pub brief: Option<Brief>,
    #[schemars(description = r#"Katalog-Theme; wird ignoriert, wenn customTheme gesetzt ist"#, extend("default" = "beratung"))]
    pub theme: Option<Enum<ThemeIds>>,
    #[schemars(
        description = r#"Eigenes Design für genau dieses Deck (Standard). Vorgehen und Regeln im Design-Guide §6"#
    )]
    pub custom_theme: Option<ThemeSpec>,
    #[schemars(description = BRAND_DESC)]
    pub brand: Option<Null<Brand>>,
    #[schemars(extend("default" = "fade"))]
    pub transition: Option<Enum<Transition>>,
    #[schemars(description = r#"click = Vortrag (Builds per Klick), auto = Selbstlauf"#, extend("default" = "click"))]
    pub mode: Option<Enum<Mode>>,
    #[schemars(
        description = r#"Bewegungsstil wie Canva „Magic Animate“: none = keine Aufbauten, calm = nur Einblenden (Vorstand, Behörde), standard = Layout-Standard, lively = Karten nacheinander, Zahlen zoomen, Fotos mit Foto-Zoom (Pitch, Event)"#
    )]
    pub motion: Option<Enum<Motion>>,
    #[schemars(
        description = r#"Gestaltungsstil, beim Anlegen immer setzen (Design-Guide §6 „Stil des Decks“). Nach Anlass: mutig für Vortrag, Schule/Unterricht, Verein, Event, Kampagne, Kultur, Marketing, Produktvorstellung, Social; sachlich für Chef-Update, Entscheidungsvorlage, Antrag, Bericht, Finanzen, Projektstatus, A4-Dokument, Angebot. Steht im Kontext „Deck-Stil: …“ oder wünscht der Nutzer einen Stil, gilt der. mutig = kräftige Farbgründe, Plakat-Typo, mehr Farbflächen, markante Bilder."#
    )]
    pub style: Option<Enum<Style>>,
    #[schemars(description = r#"Folienformat; weglassen = 16:9-Präsentation"#)]
    pub format: Option<Enum<FormatIds>>,
    #[schemars(
        description = r#"Struktur-Tokens über dem Theme, auch über Katalog-Themes (Felder und Wirkung wie in customTheme). Wird mit dem Bestand gemischt; null entfernt einen Wert"#
    )]
    pub tune: Option<Tune>,
    #[schemars(
        description = r#"Film statt Präsentation (Live-Demo, Erklärvideo): jede sichtbare Folie wird eine Szene mit Aufbau, Sprecherstimme (voice je Folie), Kamera und Demo-Layouts code/screen; export_deck mp4 rendert sie. read_guide Modul film"#
    )]
    pub film: Option<Film>,
    #[schemars(
        description = r#"Nur auf ausdrücklichen Wunsch des Nutzers: Begründung (z. B. Markenvorgabe), warum ein vom Theme-Lint abgelehntes Design so bleiben soll; Fehler werden dann zu Hinweisen"#,
        length(min = 3, max = 200)
    )]
    pub r#override: Option<String>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDeck {
    #[schemars(length(max = 80))]
    pub title: Option<String>,
    pub brief: Option<BriefPatch>,
    #[schemars(description = r#"Katalog-Theme; entfernt ein eigenes Theme"#)]
    pub theme: Option<Enum<ThemeIds>>,
    #[schemars(
        description = r#"Eigenes Theme setzen oder einzelne Werte ändern (Rest bleibt); null = zurück zum Katalog-Theme"#
    )]
    pub custom_theme: Option<Null<ThemeSpecPatch>>,
    #[schemars(description = r#"null entfernt das Brand-Kit"#)]
    pub brand: Option<Null<Brand>>,
    pub transition: Option<Enum<Transition>>,
    pub mode: Option<Enum<Mode>>,
    #[schemars(
        description = r#"Bewegungsstil wie Canva „Magic Animate“: none = keine Aufbauten, calm = nur Einblenden (Vorstand, Behörde), standard = Layout-Standard, lively = Karten nacheinander, Zahlen zoomen, Fotos mit Foto-Zoom (Pitch, Event)"#
    )]
    pub motion: Option<Enum<Motion>>,
    #[schemars(
        description = r#"Gestaltungsstil, beim Anlegen immer setzen (Design-Guide §6 „Stil des Decks“). Nach Anlass: mutig für Vortrag, Schule/Unterricht, Verein, Event, Kampagne, Kultur, Marketing, Produktvorstellung, Social; sachlich für Chef-Update, Entscheidungsvorlage, Antrag, Bericht, Finanzen, Projektstatus, A4-Dokument, Angebot. Steht im Kontext „Deck-Stil: …“ oder wünscht der Nutzer einen Stil, gilt der. mutig = kräftige Farbgründe, Plakat-Typo, mehr Farbflächen, markante Bilder."#
    )]
    pub style: Option<Enum<Style>>,
    #[schemars(
        description = r#"Farbvariante des Themes wie Canva „Stile mischen“: 0 = Original, 1 = Akzente getauscht, 2 = Hell/Dunkel getauscht, 3 = beides, 4/5 = getönter Grund"#,
        range(min = 0, max = 5)
    )]
    pub shuffle: Option<Int>,
    #[schemars(
        description = r#"Schriftpaar [Titel, Text] über das Theme legen; null = Theme-Schriften"#
    )]
    pub fonts: Option<Null<(Str60, Str60)>>,
    #[schemars(
        description = r#"Magic Resize: Deck in ein anderes Format bringen; freie Elemente werden mitskaliert, Layouts ordnen sich neu an. Danach render_overview prüfen."#
    )]
    pub format: Option<Enum<FormatIds>>,
    #[schemars(
        description = r#"Hintergrundmusik im Video-Export (mp4, clips), leise unter allem, weicht der Sprache automatisch; nur auf Wunsch oder bei Kompilationen. null = entfernen"#
    )]
    pub music: Option<Null<Music>>,
    #[schemars(
        description = r#"Auflösung im Video-Export (mp4, clips): Standard 1080p; 4k/8k nur auf Wunsch (8K ≈ 16× Rechenzeit von 1080p), nie größer als die Quelle; null = Standard"#
    )]
    pub video_res: Option<Null<Enum<VideoRes>>>,
    #[schemars(
        description = r#"Struktur-Tokens über dem Theme, auch über Katalog-Themes (Felder und Wirkung wie in customTheme). Wird mit dem Bestand gemischt; null entfernt einen Wert"#
    )]
    pub tune: Option<Tune>,
    #[schemars(
        description = r#"Film-Einstellungen setzen oder einzelne ändern (Rest bleibt); null = kein Film mehr (wieder Präsentation). read_guide Modul film"#
    )]
    pub film: Option<Null<FilmPatch>>,
    #[schemars(
        description = r#"Nur auf ausdrücklichen Wunsch des Nutzers: Begründung (z. B. Markenvorgabe), warum ein vom Theme-Lint abgelehntes Design so bleiben soll; Fehler werden dann zu Hinweisen"#,
        length(min = 3, max = 200)
    )]
    pub r#override: Option<String>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddSlides {
    #[schemars(length(min = 1, max = 20))]
    pub slides: Vec<SlideIn>,
    #[schemars(
        description = r#"Einfügeposition (0-basiert); weglassen = ans Ende"#,
        range(min = 0, max = 9007199254740991_i64)
    )]
    pub at: Option<Int>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSlide {
    pub id: String,
    #[schemars(description = r#"Layout wechseln; dann content vollständig mitgeben"#)]
    pub layout: Option<Enum<LayoutIds>>,
    pub variant: Option<Null<String>>,
    #[schemars(description = r#"null = Standard des Layouts"#)]
    pub tone: Option<Null<Enum<Tone>>>,
    #[schemars(description = r#"null = Standard des Themes"#)]
    pub decor: Option<Null<Enum<Decor>>>,
    #[schemars(
        description = r#"Komposition: top = Titel oben (Standard), split = Titel auf Akzentfläche links, band = Titel im Farbband oben, center = Kopf zentriert. Nur die im Katalog genannten Frames des Layouts."#
    )]
    pub frame: Option<Null<Enum<Frame>>>,
    #[schemars(description = r#"Nur geänderte Felder; Arrays werden komplett ersetzt"#)]
    pub content: Option<Map<String, Any>>,
    pub build: Option<Null<Enum<BuildN>>>,
    #[schemars(description = r#"null = Deck-Übergang"#)]
    pub transition: Option<Null<Enum<SlideTransition>>>,
    pub notes: Option<Null<NotesN>>,
    #[schemars(
        description = r#"Ersetzt alle freien Elemente der Folie (vorhandene IDs mitgeben, um sie zu behalten); null = alle entfernen"#
    )]
    pub items: Option<Null<ItemsN>>,
    pub bg: Option<Null<SlideBgN>>,
    #[schemars(
        description = r#"true = Folie ausblenden (fehlt beim Präsentieren und in PDF, PNG, Word, Handout; in PowerPoint versteckt), false = wieder einblenden"#
    )]
    pub hidden: Option<bool>,
    #[schemars(
        description = r#"Nur Film-Decks: Sprechertext ersetzen, [klick] = nächster Takt; null = ohne Stimme"#
    )]
    pub voice: Option<Null<VoiceTextN>>,
    pub duration: Option<Null<DurationN>>,
    pub camera: Option<Null<CameraN>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReorderSlides {
    #[schemars(length(min = 1))]
    pub order: Vec<String>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSlides {
    #[schemars(length(min = 1))]
    pub ids: Vec<String>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecorateSlide {
    pub id: String,
    #[schemars(description = r#"null entfernt den Akzent"#)]
    pub accent: Null<Accent>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenderSlides {
    #[schemars(length(min = 1, max = 8))]
    pub ids: Vec<String>,
    #[schemars(range(min = 320, max = 1280), extend("default" = 1024))]
    pub width: Option<Int>,
    #[schemars(
        description = r#"Zeitpunkte in s ab Szenenbeginn, z. B. [0, 3, 7]: je Zeitpunkt ein Frame, hinter dem Ende das letzte; mit at höchstens 2 ids"#,
        length(min = 1, max = 6)
    )]
    pub at: Option<Vec<AtSec>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProposeLooks {
    #[schemars(
        description = r#"Eigene Entwürfe für dieses Thema (Design-Guide §6): einer hell und sachlich, einer dunkel oder plakativ, ein dritter als Überraschung (unerwartet, aber aus dem Thema begründet); sie unterscheiden sich in Struktur (Serif/Sans, titleSize, rule, sectionTone, labelFont, signature, margin/measure, heroTone, field), nicht nur in der Farbe. Ein Katalog-Theme ist erlaubt, im Stil mutig auch plakat/magazin/neomono/pastell."#,
        length(min = 2, max = 3)
    )]
    pub looks: Vec<LookIn>,
    #[schemars(
        description = r#"Nur auf ausdrücklichen Wunsch des Nutzers: Begründung (z. B. Markenvorgabe), warum ein vom Theme-Lint abgelehntes Design so bleiben soll; Fehler werden dann zu Hinweisen"#,
        length(min = 3, max = 200)
    )]
    pub r#override: Option<String>,
}

#[derive(JsonSchema)]
pub struct RenderOverview {}

#[derive(JsonSchema)]
pub struct LintDeck {}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchIcons {
    #[schemars(
        description = r#"englischer Begriff, z. B. "shield", "chart""#,
        length(min = 1, max = 40)
    )]
    pub query: String,
    #[schemars(range(min = 1, max = 50), extend("default" = 20))]
    pub limit: Option<Int>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadGuide {
    #[schemars(
        description = r#"Modul-IDs aus dem Index, z. B. "stil", "layout:chart""#,
        length(max = 60)
    )]
    pub module: Option<Vec<Str60>>,
    #[schemars(
        description = r#"vollständiger Guide in Teilen: 1, 2, … (die Antwort nennt die Anzahl)"#,
        range(min = 1, max = 9007199254740991_i64)
    )]
    pub part: Option<Int>,
    #[schemars(description = TOPIC_DESC)]
    pub topic: Option<Enum<Topic>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FindImages {
    #[schemars(
        description = r#"lokal: Teil des Dateinamens; Netz: englische Suchbegriffe, z. B. "teacher classroom""#,
        length(max = 80)
    )]
    pub query: Option<String>,
    #[schemars(description = r#"auto = lokal, ohne lokalen Treffer aus dem Netz (Unsplash, sonst Openverse); web = Openverse"#, extend("default" = "auto"))]
    pub source: Option<Enum<Source>>,
    #[schemars(
        description = r#"Bild direkt von dieser Adresse übernehmen. Nur Bilder, die der Nutzer genannt hat oder die verwendet werden dürfen (freie Lizenz, eigene Website); Quelle in die Notes. Auch asset://-Pfade aus Quellmaterial oder Anhängen des Nutzers, um sie vor dem Einbauen anzusehen"#,
        length(max = 2000),
        url
    )]
    pub url: Option<String>,
    #[schemars(range(min = 1, max = 5), extend("default" = 3))]
    pub limit: Option<Int>,
    #[schemars(description = r#"Unsplash: landscape für Vollbild/Cover/Galerie, portrait für Porträts (quote) und Hochformat-Decks (4:5, 9:16, A4), squarish für Kacheln und Quadrat-Decks"#, extend("default" = "landscape"))]
    pub orientation: Option<Enum<Orientation>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GenerateImage {
    #[schemars(
        description = r#"Englisch, in dieser Reihenfolge: Motiv und Handlung, Umgebung, Ausschnitt mit ruhiger Fläche für den Titel (z. B. "subject on the right, calm empty left half"), Licht und Stimmung, Stilsatz des Decks mit Theme-Farben als Wort plus Hex, zum Schluss "no text, no letters, no logos, no watermark". Konkrete Szene statt abstraktem Begriff."#,
        length(min = 10, max = 1500)
    )]
    pub prompt: String,
    #[schemars(description = r#"landscape für cover, photo, closing und gallery; square für image-text, section und big-number; portrait für Hochformat-Decks (4:5, 9:16, A4), sonst selten"#, extend("default" = "landscape"))]
    pub orientation: Option<Enum<Orientation2>>,
    #[schemars(
        description = r#"nur auf Wunsch des Nutzers; weglassen = der erste eingerichtete (Mammouth, OpenAI, Codex)"#
    )]
    pub provider: Option<Enum<Provider>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportDeck {
    pub format: Enum<ExportFormat>,
    #[schemars(
        description = r#"nur print und nur bei A4-Decks: verlustfrei auf ein anderes A-Format skalieren (a2 = Plakat, a3, a5, a6 = Postkarte); weglassen = Format des Decks"#
    )]
    pub size: Option<Enum<PrintSize>>,
    #[schemars(
        description = r#"nur print: Beschnitt in mm (Standard 3)"#,
        range(min = 0, max = 5)
    )]
    pub bleed: Option<f64>,
    #[cfg(feature = "pro")]
    #[schemars(
        description = r#"nur print: PDF/X-4 in CMYK (FOGRA39) für Druckereien, die CMYK verlangen; braucht Ghostscript ab 10.05"#
    )]
    pub cmyk: Option<bool>,
    #[schemars(
        description = r#"Serienbrief: je Zeile eine Datei, {{Spalte}} im Deck wird ersetzt"#,
        length(min = 1, max = 500)
    )]
    pub rows: Option<Vec<std::collections::BTreeMap<String, String>>>,
    #[cfg(feature = "pro")]
    #[schemars(
        description = r#"nur clips und mp4, Stapel-Export: dasselbe Video zusätzlich in diesen Formaten (Dateien mit Format im Namen); Fokus aufs Gesicht wird je Format neu berechnet, Deck bleibt unverändert"#,
        length(min = 1, max = 4)
    )]
    pub formats: Option<Vec<Enum<BatchFormat>>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportVideo {
    #[schemars(
        description = r#"Link zum Video oder zur Aufzeichnung (VOD); weglassen = Videos auflisten, die schon auf diesem PC liegen"#,
        length(max = 2000),
        url
    )]
    pub url: Option<String>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VideoHighlights {
    #[schemars(
        description = r#"Quellvideo oder Audiodatei (Podcast): asset://-Pfad aus dem Anhang („Video: asset://…“), aus import_video oder absoluter Dateipfad"#,
        length(min = 1)
    )]
    pub video: String,
    #[schemars(
        description = r#"true = statt der Kandidaten eine Zeile je 90 s (Signale, Anfang des Gesagten): grober Überblick langer Videos"#
    )]
    pub overview: Option<bool>,
    #[schemars(
        description = r#"Ziellänge eines langen Videos in Minuten (z. B. 12): liefert genug Fenster dafür statt 8 für Shorts"#,
        range(min = 1, max = 60)
    )]
    pub minutes: Option<f64>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeVideo {
    #[schemars(
        description = r#"Quellvideo oder Audiodatei (Podcast): asset://-Pfad aus dem Anhang („Video: asset://…“), aus import_video oder absoluter Dateipfad"#,
        length(min = 1)
    )]
    pub video: String,
    #[schemars(
        description = r#"Bereich ab dieser Sekunde: nur er wird transkribiert und gezeigt (Highlight-Fenster, lange Transkripte seitenweise)"#,
        range(min = 0)
    )]
    pub from: Option<f64>,
    #[schemars(description = r#"Bereich bis zu dieser Sekunde"#, range(min = 0))]
    pub to: Option<f64>,
    #[schemars(
        description = r#"Sprache als ISO-639-1-Code (de, en, ja …). Weglassen = Parakeet, der nur die 25 europäischen Sprachen kennt; bei Sprachen außerhalb Europas (z. B. Japanisch, Türkisch, Arabisch) lang setzen – dann Whisper. Bei nicht deutschem Video lang immer setzen: Ist in den Einstellungen „Deutsch schnell“ gewählt, nimmt es ohne lang das rein deutsche Modell"#,
        regex(pattern = r#"^[a-z]{2}$"#)
    )]
    pub lang: Option<String>,
    #[schemars(
        description = r#"true = Sprecher unterscheiden (S1, S2 … je Zeile), für Podcasts, Interviews und Gespräche"#
    )]
    pub speakers: Option<bool>,
    #[schemars(
        description = r#"true = auch über 10 min, z. B. das ganze Video (Fulltime oder langes Video aus einer Quelle bis ~45 min; Streams über video_highlights mit minutes)"#
    )]
    pub all: Option<bool>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchTranscript {
    #[schemars(
        description = r#"Quellvideo oder Audiodatei (Podcast): asset://-Pfad aus dem Anhang („Video: asset://…“), aus import_video oder absoluter Dateipfad"#,
        length(min = 1)
    )]
    pub video: String,
    #[schemars(
        description = r#"Thema in Stichworten oder Zitat als Wortfolge"#,
        length(min = 2, max = 300)
    )]
    pub query: String,
    #[schemars(
        description = r#"höchstens so viele Treffer, Standard 8"#,
        range(min = 1, max = 20)
    )]
    pub n: Option<Int>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrames {
    #[schemars(
        description = r#"Quellvideo oder Audiodatei (Podcast): asset://-Pfad aus dem Anhang („Video: asset://…“), aus import_video oder absoluter Dateipfad"#,
        length(min = 1)
    )]
    pub video: String,
    #[schemars(description = r#"Sekunden im Video"#, length(min = 1, max = 12))]
    pub times: Vec<Sec>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckClip {
    #[schemars(description = r#"ID der clip-Folie"#)]
    pub slide: String,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CapturePage {
    #[schemars(description = r#"http(s)-Adresse der Seite"#, length(max = 2000), url)]
    pub url: String,
    #[schemars(description = r#"desktop = 1440×900 (Standard), handy = 390×844"#)]
    pub device: Option<Enum<Device>>,
    #[schemars(
        description = r#"Stellen 0..1 der Seitenhöhe (0 = oben, 1 = ganz unten), je Stelle ein Bild; weglassen = nur der obere Bildschirm"#,
        length(min = 1, max = 12)
    )]
    pub scroll: Option<Vec<Share>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScreenZooms {
    #[schemars(
        description = r#"Quellvideo oder Audiodatei (Podcast): asset://-Pfad aus dem Anhang („Video: asset://…“), aus import_video oder absoluter Dateipfad"#,
        length(min = 1)
    )]
    pub video: String,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateEpisode {
    #[schemars(length(max = 80))]
    pub title: String,
    #[schemars(length(min = 1, max = 4))]
    pub tracks: Vec<EpisodeTrack>,
    #[schemars(
        description = r#"klar (Standard) = Sprachkette (Hochpass, Entrauschen, Kompressor, De-Esser); stark = dazu kräftiger entrauschen (Lüfter, Raumhall); original = unverändert"#
    )]
    pub ton: Option<Enum<Ton>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditEpisode {
    pub clean: Option<Clean>,
    #[schemars(
        description = r#"Bereiche herausschneiden; Kanten in einem Wort rasten auf dessen Rand"#,
        length(max = 200)
    )]
    pub cut: Option<Vec<CutItem>>,
    #[schemars(
        description = r#"Bereiche wiederherstellen: überlappende Schnitte fallen weg oder werden gekürzt"#,
        length(max = 200)
    )]
    pub uncut: Option<Vec<CutItem>>,
    #[schemars(
        description = r#"Soundeffekte (ersetzt die Liste, [] = keine): Datei aus find_music kurz; sparsam, nur auf Wunsch"#,
        length(max = 200)
    )]
    pub sfx: Option<Vec<SfxItem>>,
    #[schemars(description = r#"Jingle vor der Sprache (find_music kurz), null = entfernen"#)]
    pub intro: Option<Null<SrcN>>,
    #[schemars(description = r#"Jingle nach der Sprache, null = entfernen"#)]
    pub outro: Option<Null<SrcN>>,
    #[schemars(
        description = r#"Kapitel (ersetzt die Liste): erstes bei 0, 3–8 je Stunde, Titel kurz"#,
        length(max = 100)
    )]
    pub chapters: Option<Vec<Chapter>>,
    #[schemars(
        description = r#"klar (Standard) = Sprachkette (Hochpass, Entrauschen, Kompressor, De-Esser); stark = dazu kräftiger entrauschen (Lüfter, Raumhall); original = unverändert"#
    )]
    pub ton: Option<Enum<Ton>>,
    #[schemars(length(max = 4))]
    pub tracks: Option<Vec<TrackPatch>>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditTimeline {
    #[schemars(description = r#"ID oder Nummer (ab 1) der schnitt-Folie"#)]
    pub slide: SlideRef,
    #[schemars(length(min = 1, max = 50))]
    pub ops: Vec<TlOp>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FindMusic {
    #[schemars(
        description = r#"englische Suchbegriffe: Stimmung, Genre, Instrument, z. B. "calm piano instrumental""#,
        length(min = 2, max = 80)
    )]
    pub query: Option<String>,
    #[schemars(
        description = r#"Openverse-ID aus der Trefferliste: lädt diesen Titel"#,
        length(max = 64)
    )]
    pub id: Option<String>,
    #[schemars(
        description = r#"true = Soundeffekte und Jingles unter 30 s (Podcast-Intro/-Outro, Effekte) statt Musikbetten"#
    )]
    pub kurz: Option<bool>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Remember {
    #[schemars(length(min = 3, max = 200))]
    pub note: String,
}

#[derive(JsonSchema)]
pub struct GetDeck {}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SaveDeck {
    #[schemars(description = r#"Ordnername statt Titel-Slug"#, length(max = 60))]
    pub name: Option<String>,
}

#[derive(JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OpenDeck {
    #[schemars(description = PATH_DESC)]
    pub path: String,
}
