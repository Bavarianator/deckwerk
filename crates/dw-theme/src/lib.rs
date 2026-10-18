//! Theme-System (themes.ts, themes-extra.ts, font-catalog.ts, font-win.ts): Datenmodell, 20 statische Themes,
//! `resolve_theme` mit Leitplanken (Kontrast, calmBg/vividBg, Brand, Farbvariante, Schriften, Tokens) und `Tokens` für Layouts.

mod data;
pub mod fonts;
mod tokens;

use std::collections::BTreeMap;
use std::sync::OnceLock;

use dw_color::clamp_chroma;
pub use dw_color::{Rgb, contrast, ensure_contrast, mix};
use dw_model::{BrandKit, ThemeRef};
use serde::{Deserialize, Serialize, Serializer};

pub use fonts::{FontDef, FontInfo, font, font_info, font_ref, known_font};
pub use tokens::{HEAD_ROLES, Role, SCALE, Tokens, font_factor, fs, head_fit};

// ---------- Enums (deck.ts) ----------

macro_rules! str_enum {
    ($(#[$m:meta])* $name:ident { $($v:ident = $s:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name { $(#[serde(rename = $s)] $v),+ }
        impl $name {
            pub fn as_str(self) -> &'static str { match self { $($name::$v => $s),+ } }
        }
    };
}

str_enum!(Tone { Normal = "normal", Accent = "accent", Invert = "invert" });
str_enum!(Decor { None = "none", Blobs = "blobs", Glow = "glow", Rings = "rings", Grid = "grid", Stripe = "stripe", Dots = "dots" });
str_enum!(Texture { Grain = "grain" });
// Kopflinie; `None` gibt es nur in Spec/Tune (Theme hält dann `rule: None`)
str_enum!(Rule { None = "none", Over = "over", Under = "under" });
str_enum!(Elements { Line = "line", Plain = "plain", Solid = "solid" });
str_enum!(TitleSize { Normal = "normal", Large = "large", Huge = "huge" });
str_enum!(TitleWeight { Regular = "regular", Bold = "bold" });
str_enum!(LabelFont { Body = "body", Mono = "mono" });
str_enum!(Leading { Tight = "tight", Normal = "normal", Open = "open" });
str_enum!(Labels { Sentence = "sentence", Caps = "caps" });
str_enum!(Margin { Standard = "standard", Generous = "generous", Asymmetric = "asymmetric" });
str_enum!(Measure { Narrow = "narrow", Standard = "standard", Wide = "wide" });
str_enum!(HeroTone { Normal = "normal", Field = "field", Invert = "invert" });
str_enum!(ChartStrategy { Focus = "focus", Duo = "duo", Tonal = "tonal" });
str_enum!(ImageStyle { Natural = "natural", Mono = "mono", Duotone = "duotone" });
str_enum!(SigKind { None = "none", Rule = "rule", Edge = "edge", Passepartout = "passepartout" });
str_enum!(SigColor { Accent = "accent", Field = "field", Text = "text" });
str_enum!(SigLength { Short = "short", Full = "full" });
str_enum!(SigSide { Left = "left", Top = "top" });

/// Genau ein wiederkehrendes Element: Haarlinie, Kante am Rand oder Rahmen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Signature {
    pub kind: SigKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<SigColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<SigLength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<SigSide>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFiles {
    pub regular: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold_italic: Option<String>,
}

/// Eigene TTF des Nutzers (ThemeRef.customFont).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CustomFont {
    pub family: String,
    pub regular: String,
    #[serde(default)]
    pub bold: Option<String>,
}

// ---------- Spec und Tune ----------

/// Struktur-Tokens (TUNE_KEYS), auch als ThemeRef.tune über jedem Theme.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThemeTune {
    pub title_size: Option<TitleSize>,
    pub head_weight: Option<u16>,
    pub head_tracking: Option<f64>,
    pub leading: Option<Leading>,
    pub labels: Option<Labels>,
    pub label_font: Option<LabelFont>,
    pub margin: Option<Margin>,
    pub measure: Option<Measure>,
    pub rule: Option<Rule>,
    pub elements: Option<Elements>,
    pub signature: Option<Signature>,
    pub hero_tone: Option<HeroTone>,
    pub field: Option<Rgb>,
    pub chart: Option<ChartStrategy>,
    pub images: Option<ImageStyle>,
}

/// Eigenes Theme aus wenigen Vorgaben (deck.ts ThemeSpec).
#[derive(Debug, Clone, PartialEq)]
pub struct ThemeSpec {
    pub name: String,
    pub bg: Rgb,
    pub text: Option<Rgb>,
    pub accent: Rgb,
    pub accent2: Option<Rgb>,
    pub head_font: String,
    pub body_font: String,
    pub radius: f64,
    pub decor: Decor,
    pub texture: Option<Texture>,
    pub title_weight: Option<TitleWeight>,
    pub section_tone: Option<Tone>,
    pub vivid: bool,
    pub tune: ThemeTune,
}

// Tolerantes Lesen wie TS (dort prüft zod vorher, resolveTheme rechnet mit dem, was da ist): jedes Feld einzeln,
// ungültige Werte und Farben fallen nur selbst weg.
type Obj = serde_json::Map<String, serde_json::Value>;

fn field<T: serde::de::DeserializeOwned>(o: &Obj, k: &str) -> Option<T> {
    o.get(k).and_then(|v| T::deserialize(v).ok())
}

fn color(o: &Obj, k: &str) -> Option<Rgb> {
    o.get(k)?.as_str().and_then(Rgb::parse)
}

impl Signature {
    pub fn from_json(v: &serde_json::Value) -> Option<Signature> {
        let o = v.as_object()?;
        Some(Signature {
            kind: field(o, "kind")?,
            color: field(o, "color"),
            size: field(o, "size"),
            length: field(o, "length"),
            side: field(o, "side"),
        })
    }
}

impl ThemeTune {
    pub fn from_json(v: &serde_json::Value) -> ThemeTune {
        let Some(o) = v.as_object() else {
            return ThemeTune::default();
        };
        ThemeTune {
            title_size: field(o, "titleSize"),
            head_weight: field::<f64>(o, "headWeight").map(|w| w as u16),
            head_tracking: field(o, "headTracking"),
            leading: field(o, "leading"),
            labels: field(o, "labels"),
            label_font: field(o, "labelFont"),
            margin: field(o, "margin"),
            measure: field(o, "measure"),
            rule: field(o, "rule"),
            elements: field(o, "elements"),
            signature: o.get("signature").and_then(Signature::from_json),
            hero_tone: field(o, "heroTone"),
            field: color(o, "field"),
            chart: field(o, "chart"),
            images: field(o, "images"),
        }
    }
}

impl ThemeSpec {
    /// None nur ohne gültiges bg oder accent: daraus leitet sich alles ab (TS rechnete dann mit undefined weiter).
    /// Fehlende Pflichtfelder sonst wie undefined in TS: name leer, Schriften Arial/Calibri, radius 0, decor none.
    pub fn from_json(v: &serde_json::Value) -> Option<ThemeSpec> {
        let o = v.as_object()?;
        Some(ThemeSpec {
            name: field(o, "name").unwrap_or_default(),
            bg: color(o, "bg")?,
            text: color(o, "text"),
            accent: color(o, "accent")?,
            accent2: color(o, "accent2"),
            head_font: field(o, "headFont").unwrap_or_default(),
            body_font: field(o, "bodyFont").unwrap_or_default(),
            radius: field(o, "radius").unwrap_or(0.0),
            decor: field(o, "decor").unwrap_or(Decor::None),
            texture: field(o, "texture"),
            title_weight: field(o, "titleWeight"),
            section_tone: field(o, "sectionTone"),
            vivid: field(o, "vivid").unwrap_or(false),
            tune: ThemeTune::from_json(v),
        })
    }
}

// ---------- Theme ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FontRef {
    pub css: String,
    pub pptx: String,
    /// Dateistamm in assets/fonts (gebündelt, in die PPTX eingebettet)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed: Option<String>,
    #[serde(skip_serializing_if = "no")]
    pub serif: bool,
    /// nur ein Schnitt (Titel in 400)
    #[serde(skip_serializing_if = "no")]
    pub single: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<FontFiles>,
    /// CSS-Name der gebündelten Ersatzschrift
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
}

impl FontRef {
    /// CSS-Familienliste wie `family()` in slide.tsx: Schrift, dann Ersatz.
    pub fn families(&self) -> Vec<&str> {
        std::iter::once(self.css.as_str())
            .chain(self.fallback.as_deref())
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HeadFont {
    #[serde(flatten)]
    pub font: FontRef,
    pub weight: u16,
    /// em
    pub tracking: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Colors {
    #[serde(serialize_with = "ser_hex")]
    pub bg: Rgb,
    #[serde(serialize_with = "ser_hex")]
    pub surface: Rgb,
    #[serde(serialize_with = "ser_hex")]
    pub surface2: Rgb,
    #[serde(serialize_with = "ser_hex")]
    pub text: Rgb,
    #[serde(serialize_with = "ser_hex")]
    pub muted: Rgb,
    #[serde(serialize_with = "ser_hex")]
    pub accent: Rgb,
    #[serde(serialize_with = "ser_hex")]
    pub accent2: Rgb,
    #[serde(serialize_with = "ser_hex")]
    pub on_accent: Rgb,
    #[serde(serialize_with = "ser_hex")]
    pub border: Rgb,
    #[serde(serialize_with = "ser_hex")]
    pub good: Rgb,
    #[serde(serialize_with = "ser_hex")]
    pub bad: Rgb,
    #[serde(serialize_with = "ser_hex_vec")]
    pub chart: Vec<Rgb>,
    /// Akzent, bis onAccent darauf AA hält (setzt resolve_theme)
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_hex_opt"
    )]
    pub fill: Option<Rgb>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Logos {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub light: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dark: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub dark: bool,
    pub c: Colors,
    pub head: HeadFont,
    pub body: FontRef,
    pub radius: f64,
    pub decor: Decor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture: Option<Texture>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone: Option<Tone>,
    #[serde(skip_serializing_if = "no")]
    pub legacy: bool,
    /// Titelgröße (display, statement, h1) relativ zur Skala
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<Rule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_tone: Option<Tone>,
    #[serde(skip_serializing_if = "no")]
    pub vivid: bool,
    #[serde(skip_serializing_if = "no")]
    pub mutig: bool,
    /// Schrift für Eyebrow und Fußzeile
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mono: Option<FontRef>,
    #[serde(skip_serializing_if = "no")]
    pub sub_body: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elements: Option<Elements>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logos: Option<Logos>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_hex_opt"
    )]
    pub field: Option<Rgb>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chart: Option<ChartStrategy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leading: Option<Leading>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Labels>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin: Option<Margin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measure: Option<Measure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<Signature>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hero_tone: Option<HeroTone>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<ImageStyle>,
}

fn no(b: &bool) -> bool {
    !*b
}
fn ser_hex<S: Serializer>(c: &Rgb, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&c.to_hex())
}
fn ser_hex_opt<S: Serializer>(c: &Option<Rgb>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&c.expect("nur mit Wert serialisiert").to_hex())
}
fn ser_hex_vec<S: Serializer>(c: &[Rgb], s: S) -> Result<S::Ok, S::Error> {
    s.collect_seq(c.iter().map(Rgb::to_hex))
}

// ---------- Kataloge ----------

/// Alle Themes in TS-Reihenfolge: 5 Kern, 4 mutig, 11 legacy.
pub fn themes() -> &'static [Theme] {
    static T: OnceLock<Vec<Theme>> = OnceLock::new();
    T.get_or_init(|| {
        let mut v = data::core();
        v.extend(mutig());
        v.extend(data::legacy().into_iter().map(|t| Theme {
            legacy: true,
            elements: Some(Elements::Solid),
            ..t
        }));
        v
    })
}

/// Angebotene Themes (ohne legacy).
pub fn catalog_themes() -> impl Iterator<Item = &'static Theme> {
    themes().iter().filter(|t| !t.legacy)
}

pub fn theme(id: &str) -> Option<&'static Theme> {
    themes().iter().find(|t| t.id == id)
}

/// Kuratierte Schriftpaare [Titel, Text] für „Schriften mischen“.
pub const FONT_PAIRS: [(&str, &str); 12] = [
    ("IBM Plex Sans", "IBM Plex Sans"),
    ("Source Serif 4", "Source Sans 3"),
    ("IBM Plex Serif", "IBM Plex Sans"),
    ("Inter", "Inter"),
    ("Archivo", "Archivo"),
    ("Fraunces", "DM Sans"),
    ("DM Serif Display", "DM Sans"),
    ("Lora", "Source Sans 3"),
    ("Playfair Display", "Source Sans 3"),
    ("Manrope", "Manrope"),
    ("Georgia", "Calibri"),
    ("Arial", "Calibri"),
];

fn mutig() -> Vec<Theme> {
    let spec = |name: &str,
                bg: &str,
                text: Option<&str>,
                accent: &str,
                accent2: Option<&str>,
                head: &str,
                body: &str,
                radius,
                tune: ThemeTune,
                section_tone,
                vivid| ThemeSpec {
        name: name.into(),
        bg: hex(bg),
        text: text.map(hex),
        accent: hex(accent),
        accent2: accent2.map(hex),
        head_font: head.into(),
        body_font: body.into(),
        radius,
        decor: Decor::None,
        texture: None,
        title_weight: None,
        section_tone,
        vivid,
        tune,
    };
    let tune = |ts, rule, label_font, elements| ThemeTune {
        title_size: Some(ts),
        rule,
        label_font,
        elements: Some(elements),
        ..Default::default()
    };
    [
        (
            "plakat",
            spec(
                "Plakat",
                "#FFD60A",
                Some("#111111"),
                "#111111",
                Some("#FFFFFF"),
                "Archivo Black",
                "Archivo",
                0.0,
                tune(TitleSize::Huge, None, None, Elements::Solid),
                Some(Tone::Invert),
                true,
            ),
        ),
        (
            "magazin",
            spec(
                "Magazin",
                "#FFFFFF",
                None,
                "#C8102E",
                None,
                "DM Serif Display",
                "DM Sans",
                0.0,
                tune(
                    TitleSize::Huge,
                    Some(Rule::Over),
                    Some(LabelFont::Mono),
                    Elements::Line,
                ),
                None,
                false,
            ),
        ),
        (
            "neomono",
            spec(
                "Neo-Mono",
                "#0E0E0E",
                None,
                "#FF5B2E",
                None,
                "IBM Plex Sans",
                "IBM Plex Sans",
                0.0,
                tune(
                    TitleSize::Large,
                    Some(Rule::Under),
                    Some(LabelFont::Mono),
                    Elements::Plain,
                ),
                Some(Tone::Normal),
                false,
            ),
        ),
        (
            "pastell",
            spec(
                "Pastell",
                "#E6E0FF",
                None,
                "#2A2FBF",
                None,
                "Plus Jakarta Sans",
                "DM Sans",
                12.0,
                tune(TitleSize::Large, None, None, Elements::Solid),
                None,
                true,
            ),
        ),
    ]
    .into_iter()
    .map(|(id, s)| {
        let mut t = theme_from_spec(&s, None);
        t.id = id.into();
        t.mutig = true;
        t.sub_body = id == "plakat";
        if id == "pastell" {
            t.head.tracking = -0.01; // Plus Jakarta läuft von Haus aus eng
        }
        t
    })
    .collect()
}

// ---------- Farbleitplanken ----------

fn hex(s: &str) -> Rgb {
    Rgb::parse(s).expect("Farbe")
}

fn dark_bg(bg: Rgb) -> bool {
    contrast(bg, Rgb::WHITE) > contrast(bg, Rgb::BLACK)
}

fn on_of(x: Rgb) -> Rgb {
    if contrast(Rgb::WHITE, x) >= contrast(hex("#0B0B0B"), x) {
        Rgb::WHITE
    } else {
        hex("#0B0B0B")
    }
}

/// OKLCH (l, c, h in Radiant) einer Farbe.
fn lch(c: Rgb) -> (f64, f64, f64) {
    let o = c.to_oklab();
    (o.l, o.a.hypot(o.b), o.b.atan2(o.a))
}

/// culori `formatHex(clampChroma({l, c, h}, 'oklch'))`
fn clamp_lch(l: f64, c: f64, h: f64) -> Rgb {
    let q = |x: f64| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
    let [r, g, b] = clamp_chroma(l, c, h).map(q);
    Rgb { r, g, b, a: 255 }
}

/// Grund hell oder dunkel und wenig bunt: mittlere, pastellige oder kräftige Gründe werden gedämpft.
fn calm_bg(x: Rgb) -> Rgb {
    let (l, c, h) = lch(x);
    let dark = l < 0.6;
    clamp_lch(
        if dark { l.min(0.27) } else { l.max(0.93) },
        c.min(if dark { 0.065 } else { 0.03 }),
        h,
    )
}

/// Stil mutig: kräftiger Grund verlässt nur das mittlere Helligkeitsband.
fn vivid_bg(x: Rgb) -> Rgb {
    let (l, c, h) = lch(x);
    clamp_lch(if l < 0.57 { l.min(0.42) } else { l.max(0.74) }, c, h)
}

/// Diagrammfarben je Strategie, alle mit Kontrast 2,5 zum Grund.
fn chart_of(s: ChartStrategy, c: &Colors) -> Vec<Rgb> {
    let (bg, text, accent, accent2) = (c.bg, c.text, c.accent, c.accent2);
    let g = |k| mix(bg, text, k);
    let raw = match s {
        ChartStrategy::Duo => vec![accent, accent2, g(0.45), g(0.28), g(0.7)],
        ChartStrategy::Tonal => tonal(accent, bg),
        ChartStrategy::Focus => vec![accent, g(0.45), g(0.28), accent2, g(0.7)],
    };
    raw.into_iter()
        .map(|x| ensure_contrast(x, bg, 2.5))
        .collect()
}

/// Vier Helligkeitsstufen vom Akzent aus, die vom Akzent am weitesten entfernte zuerst.
fn tonal(accent: Rgb, bg: Rgb) -> Vec<Rgb> {
    let (al, ac, ah) = lch(accent);
    let dark = dark_bg(bg);
    let dir = if dark { -1.0 } else { 1.0 };
    let at = |l| clamp_lch(l, ac, ah);
    let near = lch(ensure_contrast(at(if dark { 0.05 } else { 0.98 }), bg, 2.5)).0;
    let far = if dark { 0.94 } else { 0.26 };
    let up = ((near - al) * dir).max(0.0);
    let down = ((al - far) * dir).max(0.0);
    let n = if up + down != 0.0 {
        ((4.0 * up) / (up + down)).round() as usize
    } else {
        0
    };
    let side =
        |to: f64, k: usize| (0..k).map(move |i| al + ((to - al) * (i + 1) as f64) / k as f64);
    let mut steps: Vec<f64> = side(near, n).chain(side(far, 4 - n)).collect();
    steps.sort_by(|x, y| (y - al).abs().total_cmp(&(x - al).abs()));
    std::iter::once(accent)
        .chain(steps.into_iter().map(at))
        .collect()
}

// ---------- Ränder ----------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Margins {
    pub l: f64,
    pub r: f64,
    pub t: f64,
    pub b: f64,
    pub foot: f64,
}

/// marginsOf: Hoch-/Quadratformate behalten die Standardränder, schmale Querformate bis 800 px den halben Zuschlag.
pub fn margins_of(m: Option<Margin>, w: f64, h: f64) -> Margins {
    let px = |m| match m {
        Margin::Standard => [72.0, 72.0, 60.0, 72.0, 24.0],
        Margin::Generous => [112.0, 112.0, 72.0, 80.0, 28.0],
        Margin::Asymmetric => [152.0, 72.0, 60.0, 72.0, 24.0],
    };
    let (s, v) = (px(Margin::Standard), px(m.unwrap_or(Margin::Standard)));
    let k = if w / h <= 1.2 {
        0.0
    } else if w <= 800.0 {
        0.5
    } else {
        1.0
    };
    let at = |i: usize| s[i] + (v[i] - s[i]) * k;
    Margins {
        l: at(0),
        r: at(1),
        t: at(2),
        b: at(3),
        foot: at(4),
    }
}

// ---------- Ableitungen ----------

/// Einschnitt-Schriften nur 400, sonst 400 oder 700.
fn weight_of(f: &FontRef, w: u16) -> u16 {
    if f.single || w < 600 { 400 } else { 700 }
}

fn head_ref(f: FontRef, weight: u16) -> HeadFont {
    HeadFont {
        weight: if f.single { 400 } else { weight },
        tracking: if f.serif { -0.012 } else { -0.022 },
        font: f,
    }
}

/// Gestaltungs-Tokens auf ein Theme legen; fehlender Token = keine Änderung.
pub fn apply_tokens(t: &Theme, k: &ThemeTune) -> Theme {
    let mut o = t.clone();
    if let Some(ts) = k.title_size {
        o.head_scale = match ts {
            TitleSize::Huge => Some(1.45),
            TitleSize::Large => Some(1.22),
            TitleSize::Normal => None,
        };
    }
    if let Some(r) = k.rule {
        o.rule = (r != Rule::None).then_some(r);
    }
    if let Some(lf) = k.label_font {
        o.mono =
            (lf == LabelFont::Mono).then(|| font("IBM Plex Mono").expect("gebündelt").to_ref());
    }
    if k.elements.is_some() {
        o.elements = k.elements;
    }
    if let Some(w) = k.head_weight.filter(|w| *w != 0) {
        o.head.weight = weight_of(&o.head.font, w);
    }
    if let Some(tr) = k.head_tracking {
        o.head.tracking = tr.clamp(-0.05, 0.02);
    }
    if let Some(ch) = k.chart {
        o.chart = Some(ch);
        o.c.chart = chart_of(ch, &o.c);
    }
    macro_rules! take { ($($f:ident),+) => { $(if k.$f.is_some() { o.$f = k.$f.clone(); })+ }; }
    take!(
        field, leading, labels, margin, measure, signature, hero_tone, images
    );
    o
}

type Files = BTreeMap<String, FontFiles>;

/// Eigenes Theme: Flächen und Ränder als Mischung von Grund und Text, Akzente mit Mindestkontrast.
pub fn theme_from_spec(s: &ThemeSpec, files: Option<&Files>) -> Theme {
    let bg = if s.vivid {
        vivid_bg(s.bg)
    } else {
        calm_bg(s.bg)
    };
    let dark = dark_bg(bg);
    // Schwarz mit einer Spur Akzent, nie reines #000
    let text = ensure_contrast(
        s.text.unwrap_or_else(|| {
            mix(
                bg,
                if dark {
                    Rgb::WHITE
                } else {
                    mix(Rgb::BLACK, s.accent, 0.15)
                },
                0.92,
            )
        }),
        bg,
        10.0,
    );
    let accent = ensure_contrast(s.accent, bg, 3.0);
    let accent2 = ensure_contrast(s.accent2.unwrap_or_else(|| mix(bg, text, 0.5)), bg, 3.0);
    let head = font_ref(Some(&s.head_font), files)
        .unwrap_or_else(|| font("Arial").expect("Arial").to_ref());
    let k = |d, l| if dark { d } else { l };
    let mut c = Colors {
        bg,
        text,
        accent,
        accent2,
        surface: mix(bg, text, k(0.07, 0.045)),
        surface2: mix(bg, text, k(0.12, 0.09)),
        border: mix(bg, text, k(0.17, 0.12)),
        muted: mix(bg, text, 0.62),
        on_accent: on_of(accent),
        good: hex(if dark { "#5BD08A" } else { "#1E7A45" }),
        bad: hex(if dark { "#F07A6B" } else { "#B83227" }),
        chart: vec![],
        fill: None,
    };
    c.chart = chart_of(ChartStrategy::Focus, &c);
    let t = Theme {
        id: "custom".into(),
        name: s.name.clone(),
        dark,
        c,
        head: head_ref(
            head,
            if s.title_weight == Some(TitleWeight::Regular) {
                400
            } else {
                700
            },
        ),
        body: font_ref(Some(&s.body_font), files)
            .unwrap_or_else(|| font("Calibri").expect("Calibri").to_ref()),
        radius: s.radius,
        decor: s.decor,
        texture: s.texture,
        section_tone: s.section_tone,
        vivid: s.vivid,
        elements: Some(Elements::Solid), // Designs von vor dem Hebel behalten ihre Kästen
        ..data::blank()
    };
    apply_tokens(&t, &s.tune)
}

fn truthy(s: &Option<String>) -> Option<String> {
    s.clone().filter(|x| !x.is_empty())
}

fn with_brand(base: Theme, b: &BrandKit, files: Option<&Files>) -> Theme {
    let Some(primary) = Rgb::parse(&b.primary) else {
        return base;
    };
    let head = font_ref(b.head_font.as_deref(), files);
    let accent = ensure_contrast(primary, base.c.bg, 4.5);
    let accent2 = ensure_contrast(
        b.secondary
            .as_deref()
            .and_then(Rgb::parse)
            .unwrap_or(base.c.accent2),
        base.c.bg,
        3.0,
    );
    let on_accent = if contrast(Rgb::WHITE, accent) >= 3.0 {
        Rgb::WHITE
    } else {
        hex("#0B0B0B")
    };
    let chart = [accent, accent2]
        .into_iter()
        .chain(base.c.chart.iter().skip(2).copied())
        .collect();
    Theme {
        id: format!("{}+brand", base.id),
        c: Colors {
            accent,
            accent2,
            on_accent,
            chart,
            ..base.c.clone()
        },
        // nur Gewicht und Laufweite vom Theme
        head: match head {
            Some(h) => HeadFont {
                weight: if h.single { 400 } else { base.head.weight },
                tracking: base.head.tracking,
                font: h,
            },
            None => base.head.clone(),
        },
        body: font_ref(b.body_font.as_deref(), files).unwrap_or_else(|| base.body.clone()),
        logo: truthy(&b.logo_dark)
            .filter(|_| base.dark)
            .or_else(|| b.logo.clone()),
        logos: Some(Logos {
            light: b.logo.clone(),
            dark: b.logo_dark.clone(),
        }),
        ..base
    }
}

/// Brand-Logo für hellen bzw. dunklen Grund.
fn logo_on(t: &Theme, dark: bool) -> Option<String> {
    match &t.logos {
        Some(l) => truthy(&l.dark).filter(|_| dark).or_else(|| l.light.clone()),
        None => t.logo.clone(),
    }
}

/// Farbvariante: 1 = Akzente getauscht, 2 = Hell/Dunkel, 3 = beides, 4/5 = Grund in Akzentfarbe getönt.
fn shuffled(t: Theme, n: f64) -> Theme {
    // wie JS: ((n % 6) + 6) % 6, auch für Bruchzahlen; 0 und NaN = keine Variante
    let v = ((n % 6.0) + 6.0) % 6.0;
    if v == 0.0 || v.is_nan() {
        return t;
    }
    let Colors {
        mut bg,
        mut text,
        mut accent,
        mut accent2,
        ..
    } = t.c;
    if v % 2.0 != 0.0 {
        std::mem::swap(&mut accent, &mut accent2);
    }
    if v == 2.0 || v == 3.0 {
        std::mem::swap(&mut bg, &mut text);
    }
    if v >= 4.0 {
        bg = mix(bg, accent, if t.dark { 0.16 } else { 0.09 });
    }
    let s = theme_from_spec(
        &ThemeSpec {
            name: t.name.clone(),
            bg,
            text: Some(text),
            accent,
            accent2: Some(accent2),
            head_font: "Arial".into(),
            body_font: "Calibri".into(),
            radius: t.radius,
            decor: t.decor,
            texture: t.texture,
            title_weight: None,
            section_tone: None,
            vivid: t.vivid,
            tune: ThemeTune::default(),
        },
        None,
    );
    Theme {
        dark: s.dark,
        logo: logo_on(&t, s.dark),
        c: s.c,
        ..t
    }
}

/// Getypte Zusatzfelder des ThemeRef (in dw-model noch `extra`/`Value`). Ungültige Felder fallen weg.
struct RefExt {
    custom: Option<ThemeSpec>,
    shuffle: Option<f64>,
    custom_font: Option<CustomFont>,
    font_files: Option<Files>,
    tune: Option<ThemeTune>,
}

fn ext(r: &ThemeRef) -> RefExt {
    let x = |k| r.extra.get(k);
    RefExt {
        custom: r.custom.as_ref().and_then(ThemeSpec::from_json),
        shuffle: x("shuffle").and_then(|v| v.as_f64()),
        custom_font: x("customFont").and_then(|v| CustomFont::deserialize(v).ok()),
        // je Familie einzeln: ein kaputter Eintrag nimmt den anderen nicht mit
        font_files: x("fontFiles").and_then(|v| v.as_object()).map(|o| {
            o.iter()
                .filter_map(|(k, v)| Some((k.clone(), FontFiles::deserialize(v).ok()?)))
                .collect()
        }),
        tune: x("tune").map(ThemeTune::from_json),
    }
}

/// resolveTheme: Basis (Katalog oder eigen, unbekannte ID → erstes Theme) + Brand + Farbvariante + Schriften + Tokens,
/// danach jede Textfarbe auf WCAG AA gegen die Flächen, auf denen sie steht. `brand` ersetzt `r.brand`, wenn gesetzt.
pub fn resolve_theme(r: &ThemeRef, brand: Option<&BrandKit>) -> Theme {
    let x = ext(r);
    let files = x.font_files.as_ref();
    let mut t = match &x.custom {
        Some(s) => theme_from_spec(s, files),
        None => theme(&r.id).unwrap_or(&themes()[0]).clone(),
    };
    if let Some(b) = brand.or(r.brand.as_ref()) {
        t = with_brand(t, b, files);
    }
    if let Some(n) = x.shuffle {
        t = shuffled(t, n);
    }
    if let Some(ch) = t.chart {
        // Brand und Farbvariante ersetzen Farben: Diagrammfamilie aus den neuen ableiten
        t = apply_tokens(
            &t,
            &ThemeTune {
                chart: Some(ch),
                ..Default::default()
            },
        );
    }
    let font = |n: Option<&str>| match (&x.custom_font, n) {
        (Some(cf), Some(n)) if n == cf.family => Some(FontRef {
            css: n.into(),
            pptx: n.into(),
            embed: None,
            serif: false,
            single: cf.bold.is_none(),
            files: Some(FontFiles {
                regular: cf.regular.clone(),
                bold: cf.bold.clone(),
                italic: None,
                bold_italic: None,
            }),
            fallback: None,
        }),
        _ => font_ref(n, files),
    };
    let (hf, bf) = r
        .fonts
        .as_ref()
        .map(|(h, b)| (Some(h.as_str()), Some(b.as_str())))
        .unwrap_or((None, None));
    if let Some(h) = font(hf) {
        let w = if t.head.font.single {
            700
        } else {
            t.head.weight
        }; // Gewicht des Designs behalten
        t.head = head_ref(h, w);
    }
    if let Some(b) = font(bf) {
        t.body = b;
    }
    if let Some(k) = &x.tune {
        t = apply_tokens(&t, k);
    }
    // Titelgewicht zwischen den Schnitten: Instanz-Familie („Inter SemiBold“) aus fontFiles
    let hw = x
        .tune
        .as_ref()
        .and_then(|k| k.head_weight)
        .or(x.custom.as_ref().and_then(|s| s.tune.head_weight))
        .filter(|w| *w != 0);
    if let Some((info, hw)) = hw.and_then(|hw| Some((font_info(&t.head.font.pptx)?, hw))) {
        let w = fonts::nearest_weight(info, hw);
        if w != 400 && w != 700 {
            let inst = fonts::instance_family(info.family, w);
            if let Some(fl) = files
                .and_then(|f| f.get(&inst))
                .filter(|f| !f.regular.is_empty())
            {
                t.head = HeadFont {
                    font: FontRef {
                        css: inst.clone(),
                        pptx: inst,
                        embed: None,
                        serif: t.head.font.serif,
                        single: false,
                        files: Some(fl.clone()),
                        fallback: Some(t.head.font.css.clone()),
                    },
                    weight: 400,
                    tracking: t.head.tracking,
                };
            }
        }
    }
    let c = &t.c;
    let on_accent = t.field.map(on_of).unwrap_or(c.on_accent); // Flächenfarbe: Text darauf neu wählen
    t.c = Colors {
        on_accent,
        accent: ensure_contrast(c.accent, c.surface, 4.6),
        fill: Some(ensure_contrast(t.field.unwrap_or(c.accent), on_accent, 4.6)),
        muted: ensure_contrast(c.muted, c.surface2, 4.6),
        good: ensure_contrast(c.good, c.surface, 4.6),
        bad: ensure_contrast(c.bad, c.surface, 4.6),
        ..c.clone()
    };
    t
}

/// Duotone-Farben für Fotos [dunkel, hell].
pub fn duotone_of(t: &Theme) -> (Rgb, Rgb) {
    let base = if t.tone == Some(Tone::Accent) {
        t.c.bg
    } else {
        t.c.accent
    };
    (mix(Rgb::BLACK, base, 0.4), mix(Rgb::WHITE, base, 0.3))
}

/// Folien-Ton als abgeleitetes Theme (nach resolve_theme).
pub fn with_tone(t: &Theme, tone: Tone) -> Theme {
    let c = &t.c;
    match tone {
        Tone::Normal => t.clone(),
        Tone::Accent => {
            // von bg Richtung on mischen; Karten weg von der Textfarbe abstufen
            let bg = c.fill.unwrap_or(c.accent);
            let on = c.on_accent;
            let away = if contrast(on, Rgb::WHITE) < contrast(on, Rgb::BLACK) {
                Rgb::BLACK
            } else {
                Rgb::WHITE
            };
            let toward = |min| {
                [0.7, 0.75, 0.8, 0.85, 0.9, 0.95]
                    .into_iter()
                    .map(|k| mix(bg, on, k))
                    .find(|m| contrast(*m, bg) >= min)
                    .unwrap_or(on)
            };
            let dark = contrast(Rgb::WHITE, bg) > contrast(Rgb::BLACK, bg);
            Theme {
                tone: Some(tone),
                dark,
                logo: logo_on(t, dark),
                c: Colors {
                    bg,
                    surface: mix(bg, away, 0.12),
                    surface2: mix(bg, away, 0.2),
                    text: on,
                    muted: toward(4.6),
                    accent: on,
                    on_accent: bg,
                    fill: Some(on),
                    border: mix(bg, on, 0.3),
                    good: toward(4.6),
                    bad: toward(4.6),
                    chart: c
                        .chart
                        .iter()
                        .enumerate()
                        .map(|(i, x)| {
                            if i > 0 {
                                ensure_contrast(*x, bg, 3.0)
                            } else {
                                on
                            }
                        })
                        .collect(),
                    ..c.clone()
                },
                ..t.clone()
            }
        }
        Tone::Invert => {
            let (bg, text) = (c.text, c.bg);
            let (surface, surface2) = (mix(bg, text, 0.08), mix(bg, text, 0.14));
            Theme {
                tone: Some(tone),
                dark: !t.dark,
                logo: logo_on(t, !t.dark),
                c: Colors {
                    bg,
                    text,
                    surface,
                    surface2,
                    border: mix(bg, text, 0.22),
                    muted: ensure_contrast(mix(bg, text, 0.65), surface2, 4.6),
                    accent: ensure_contrast(c.accent, surface, 4.6),
                    accent2: ensure_contrast(c.accent2, bg, 3.0),
                    good: ensure_contrast(c.good, surface, 4.6),
                    bad: ensure_contrast(c.bad, surface, 4.6),
                    chart: c
                        .chart
                        .iter()
                        .map(|x| ensure_contrast(*x, bg, 3.0))
                        .collect(),
                    ..c.clone()
                },
                ..t.clone()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kataloge() {
        assert_eq!(themes().len(), 20);
        assert_eq!(catalog_themes().count(), 9);
        assert_eq!(fonts::FONT_LIST.len(), 20);
        assert!(
            fonts::FONT_LIST
                .iter()
                .all(|(_, f)| f.embed.is_none_or(|e| fonts::win(e).is_some()))
        );
        assert_eq!(font_ref(Some("Arial"), None).unwrap().css, "Arimo");
        assert_eq!(font_ref(Some("Calibri"), None).unwrap().css, "Carlito");
        assert_eq!(font_ref(Some(" work sans "), None).unwrap().css, "Inter"); // Katalog ohne Dateien → Ersatz
        assert!(
            known_font("Inter Tight") && !known_font("inter tight") && !known_font("Comic Sans")
        );
        assert_eq!(fonts::suggest_font("Inter Tigth"), Some("Inter Tight"));
        assert_eq!(fonts::nearest_weight(font_info("Lato").unwrap(), 500), 400);
        assert_eq!(fonts::instance_family("Inter", 600), "Inter SemiBold");
    }

    #[test]
    fn win_der_ttf() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/fonts");
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let n = e.file_name().into_string().unwrap();
            let Some(stem) = n
                .strip_suffix(".ttf")
                .and_then(|s| s.rsplit_once('-'))
                .map(|s| s.0)
            else {
                continue;
            };
            let w = fonts::win_of_ttf(&std::fs::read(e.path()).unwrap()).unwrap();
            assert!((fonts::win(stem).unwrap() - w).abs() < 0.0006, "{n}: {w}");
        }
        assert_eq!(fonts::win_of_ttf(&[]), None);
        assert_eq!(fonts::win_of_ttf(&[255; 200]), None);
        assert_eq!(fonts::win_of_ttf(&[0; 12]), None);
    }

    #[test]
    fn tokens() {
        let r = |j: &str| resolve_theme(&serde_json::from_str(j).unwrap(), None);
        let t = r(r#"{"id":"beratung"}"#);
        let k = Tokens::new(&t, 1280., 720.);
        assert_eq!(
            (k.m_l, k.m_t, k.m_foot, k.measure, k.rule),
            (72., 60., 24., None, Some(Rule::Under))
        );
        assert_eq!(k.font_size(Role::Display, 0, 0, 1.), 76.);
        let t = r(
            r#"{"id":"keynote","tune":{"margin":"generous","measure":"narrow","leading":"open","signature":{"kind":"passepartout","size":20}}}"#,
        );
        let k = Tokens::new(&t, 1280., 720.);
        assert_eq!(
            (k.m_l, k.m_foot, k.measure, k.sig_s),
            (112., 40., Some(760.), Some(8.))
        );
        assert!((k.font_size(Role::Display, 0, 0, 1.) - 76. * 1.22).abs() < 1e-9);
        assert_eq!(k.font_size(Role::Display, 3, 0, 1.), 50.); // kleinste Stufe = Normalgröße
        assert!(
            (k.line_height(Role::Body, 0) - 1.38 * 1.1).abs() < 1e-9
                && k.line_height(Role::Body, 3) == 1.38
        );
        let k = Tokens::new(&t, 1080., 1350.); // Hochformat: Standardränder, kein --measure
        assert_eq!((k.m_l, k.measure), (72., None));
    }

    // Bewusste Abweichungen von TS (dort rechnete culori mit dem ungültigen Wert weiter und lieferte Unsinn)
    #[test]
    fn ungueltige_eingaben() {
        let r = |j: &str| resolve_theme(&serde_json::from_str(j).unwrap(), None);
        let base = r(r##"{"id":"beratung"}"##);
        // ungültige Brand-Primärfarbe: Brand-Kit fällt ganz weg (auch Schriften und Logo)
        assert_eq!(
            r(r##"{"id":"beratung","brand":{"primary":"rot","headFont":"Inter","logo":"x"}}"##),
            base
        );
        // ungültiger Enum-Wert in tune: nur dieser Token fällt weg
        let t = r(
            r##"{"id":"beratung","tune":{"titleSize":"riesig","margin":"generous","field":"#zz"}}"##,
        );
        assert_eq!(
            (t.head_scale, t.margin, t.field),
            (None, Some(Margin::Generous), None)
        );
        // ungültige optionale Farbe im Spec: wie nicht angegeben
        let spec = r##"{"name":"X","bg":"#F7F7F8","accent":"#4F52D9","headFont":"Inter","bodyFont":"Inter","radius":4,"decor":"none""##;
        let with = format!(r##"{{"id":"custom","custom":{spec},"accent2":"blau"}}}}"##);
        let without = format!(r##"{{"id":"custom","custom":{spec}}}}}"##);
        assert_eq!(r(&with), r(&without));
        // ohne gültiges bg/accent kein eigenes Design: ID-Lookup, „custom“ ist unbekannt → erstes Theme
        assert_eq!(
            r(r##"{"id":"custom","custom":{"name":"X","bg":"#12","accent":"#4F52D9"}}"##),
            base
        );
        // kaputter fontFiles-Eintrag nimmt die anderen nicht mit
        let t = r(
            r##"{"id":"beratung","fonts":["Bodoni Moda","Newsreader"],"fontFiles":{"Bodoni Moda":{"regular":"a"},"Newsreader":42}}"##,
        );
        assert_eq!(
            (t.head.font.css.as_str(), t.body.css.as_str()),
            ("Bodoni Moda", "Gelasio")
        );
    }
}
