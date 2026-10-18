//! Theme-Lint (theme-lint.ts): prüft eigene Themes auf Merkmale generierter Designs und auf Satz-Probleme.
//! Der Schriftkatalog kommt als Parameter (font-catalog.ts liegt bei dw-theme).

use dw_color::{Rgb, contrast, delta_e};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::js::to_fixed;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeIssue {
    pub level: Level,
    pub rule: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Signature {
    pub kind: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Die Felder von `ThemeSpec`, die der Lint liest; der Rest bleibt in `extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSpec {
    pub name: String,
    pub bg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub accent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent2: Option<String>,
    pub head_font: String,
    pub body_font: String,
    pub radius: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vivid: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_weight: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measure: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<Signature>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hero_tone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Eintrag des Schriftkatalogs (font-catalog.ts `FontInfo`), soweit der Lint ihn braucht.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FontInfo {
    pub family: String,
    pub cat: String,
    pub role: String,
    pub weights: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
}

pub fn font_info<'a>(catalog: &'a [FontInfo], name: &str) -> Option<&'a FontInfo> {
    let k = crate::js::trim(name).to_lowercase();
    // Map aus dem Katalog: bei gleichem Namen gewinnt der letzte Eintrag
    catalog.iter().rev().find(|i| i.family.to_lowercase() == k)
}

/// „meintest du ‚Inter Tight‘?“ – Levenshtein auf Kleinbuchstaben ohne Leerraum.
pub fn suggest_font(catalog: &[FontInfo], name: &str) -> Option<String> {
    let norm = |s: &str| -> Vec<u16> { s.to_lowercase().chars().filter(|c| !crate::js::is_ws(*c)).collect::<String>().encode_utf16().collect() };
    let a = norm(name);
    let dist = |b: &[u16]| {
        let mut d: Vec<usize> = (0..=b.len()).collect();
        for i in 1..=a.len() {
            let mut prev = d[0];
            d[0] = i;
            for j in 1..=b.len() {
                let t = d[j];
                d[j] = (d[j] + 1).min(d[j - 1] + 1).min(prev + usize::from(a[i - 1] != b[j - 1]));
                prev = t;
            }
        }
        d[b.len()]
    };
    // sort ist stabil: bei Gleichstand der erste Eintrag
    let best = catalog.iter().map(|i| (i, dist(&norm(&i.family)))).min_by_key(|(_, d)| *d)?;
    (best.1 <= 2.max(a.len() / 3)).then(|| best.0.family.clone())
}

#[derive(Clone, Copy)]
struct Lch {
    l: f64,
    c: f64,
    h: f64,
}

// culori oklch: c = √(a²+b²), h nur bei c ≠ 0
fn ok(hex: &str) -> Lch {
    let Some(rgb) = Rgb::parse(hex) else { return Lch { l: 0.0, c: 0.0, h: 0.0 } };
    let o = rgb.to_oklab();
    let c = (o.a * o.a + o.b * o.b).sqrt();
    let h = if c != 0.0 {
        let h = (o.b.atan2(o.a) * 180.0 / std::f64::consts::PI) % 360.0;
        if h < 0.0 { h + 360.0 } else { h }
    } else {
        0.0
    };
    Lch { l: o.l, c, h }
}

fn wcag(a: &str, b: &str) -> f64 {
    match (Rgb::parse(a), Rgb::parse(b)) {
        (Some(a), Some(b)) => contrast(a, b),
        _ => f64::NAN,
    }
}

fn dist(a: &str, b: &str) -> f64 {
    match (Rgb::parse(a), Rgb::parse(b)) {
        (Some(a), Some(b)) => delta_e(a, b),
        _ => f64::NAN,
    }
}

struct Cliche {
    name: &'static str,
    bg: Option<fn(Lch) -> bool>,
    accent: &'static str,
    level: Level,
}

const CLICHES: [Cliche; 9] = [
    Cliche { name: "Creme + Terrakotta", bg: Some(|b| b.l >= 0.9 && b.c > 0.008 && b.h >= 50.0 && b.h <= 110.0), accent: "#C4552D", level: Level::Error },
    Cliche { name: "Schwarz + Säuregrün", bg: Some(|b| b.l <= 0.3), accent: "#C6FF00", level: Level::Error },
    Cliche { name: "Navy + Gold", bg: Some(|b| b.l <= 0.35 && b.c > 0.03 && b.h >= 230.0 && b.h <= 275.0), accent: "#C9A227", level: Level::Error },
    Cliche { name: "Slate + Cyan (Tailwind)", bg: Some(|b| b.l <= 0.35 && b.c > 0.02 && b.h >= 235.0 && b.h <= 285.0), accent: "#22D3EE", level: Level::Error },
    Cliche { name: "Tailwind-Indigo", bg: None, accent: "#6366F1", level: Level::Error },
    Cliche { name: "KI-Violett", bg: None, accent: "#7C3AED", level: Level::Error },
    Cliche { name: "Office-Blau", bg: None, accent: "#4472C4", level: Level::Warn },
    Cliche { name: "Bootstrap-Blau", bg: None, accent: "#0D6EFD", level: Level::Warn },
    Cliche { name: "SaaS-Mint", bg: None, accent: "#10B981", level: Level::Warn },
];

const SANS: [&str; 3] = ["grotesk", "humanist", "geometric"];

/// Vom Brand-Kit vorgegeben (Markenvorgabe, wird nicht gelintet).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandGiven {
    #[serde(default)]
    pub accent: bool,
    #[serde(default)]
    pub head_font: bool,
    #[serde(default)]
    pub body_font: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeLintOpts {
    #[serde(default)]
    pub r#override: bool,
    #[serde(default)]
    pub brand: BrandGiven,
}

fn weights(w: &[f64]) -> String {
    w.iter().map(|x| crate::js::num(*x)).collect::<Vec<_>>().join(", ")
}

pub fn lint_theme(s: &ThemeSpec, opts: ThemeLintOpts, catalog: &[FontInfo]) -> Vec<ThemeIssue> {
    let mut out: Vec<ThemeIssue> = Vec::new();
    let mut add = |level: Level, rule: &str, message: String| {
        let level = if level == Level::Error && opts.r#override { Level::Warn } else { level };
        out.push(ThemeIssue { level, rule: rule.into(), message });
    };
    let (bg, acc) = (ok(&s.bg), ok(&s.accent));
    let f2 = |x: f64| to_fixed(x, 2);
    let f3 = |x: f64| to_fixed(x, 3);

    // Grund: sehr hell und fast neutral oder sehr dunkel; vivid (Stil mutig) will einen kräftigen Farbgrund
    if s.vivid == Some(true) {
    } else if bg.l > 0.25 && bg.l < 0.94 {
        add(Level::Error, "bg-mid", format!("Grund {} ist ein Mittelton (OKLCH L {}). Hell: L ≥ 0.94 (z. B. #FAFAF8), dunkel: L ≤ 0.25 (z. B. #121214).", s.bg, f2(bg.l)));
    } else if bg.l >= 0.94 && bg.c > 0.013 {
        add(Level::Error, "bg-tint", format!("Grund {} ist Creme/Pastell (Chroma {}). Fast neutral bleiben (C ≤ 0.006, z. B. #FAFAF8, #F3F2EF); Wärme über einen Hauch Gelb.", s.bg, f3(bg.c)));
    } else if bg.l >= 0.94 && bg.c > 0.008 {
        add(Level::Warn, "bg-tint", format!("Grund {} ist merklich getönt (Chroma {}), wie Papier. Gewollt? Sonst neutraler (C ≤ 0.006).", s.bg, f3(bg.c)));
    } else if bg.l <= 0.25 && bg.c > 0.05 {
        add(Level::Warn, "bg-tint", format!("Dunkler Grund {} ist stark gefärbt (Chroma {}), das wirkt schnell wie ein App-Theme. Fast-Schwarz mit leichtem Farbstich ist edler.", s.bg, f3(bg.c)));
    }

    let brand = opts.brand;
    if brand.accent {
    } else if acc.c > 0.26 {
        add(Level::Error, "neon", format!("Akzent {} ist Neon (Chroma {}). Unter 0.2 bleiben; Wirkung kommt aus der Seltenheit, nicht der Sättigung.", s.accent, f2(acc.c)));
    } else if acc.c > 0.22 {
        add(Level::Warn, "neon", format!("Akzent {} ist sehr gesättigt (Chroma {}). 0.08–0.18 wirkt hochwertiger.", s.accent, f2(acc.c)));
    }
    if !brand.accent && wcag(&s.accent, &s.bg) < 3.0 {
        add(Level::Info, "accent-contrast", format!("Akzent {} hat nur {}:1 auf dem Grund; die Engine dunkelt/hellt ihn ab. Für große Flächen field nutzen.", s.accent, to_fixed(wcag(&s.accent, &s.bg), 1)));
    }
    if let Some(t) = s.text.as_deref().filter(|t| !t.is_empty())
        && wcag(t, &s.bg) < 8.0
    {
        add(Level::Info, "text-contrast", format!("Text {t} hat {}:1; die Engine hebt ihn auf 8:1 an.", to_fixed(wcag(t, &s.bg), 1)));
    }
    if let Some(f) = s.field.as_deref().filter(|f| !f.is_empty())
        && dist(f, &s.accent) < 8.0
    {
        add(Level::Warn, "field", format!("field {f} ist fast gleich dem Akzent – weglassen (Standard = Akzent) oder als eigene Stimme wählen."));
    }

    // Klischee-Paletten, dazu die Farbfamilien drumherum
    let mut cliche = false;
    for c in &CLICHES {
        if !brand.accent && dist(&s.accent, c.accent) <= 12.0 && c.bg.is_none_or(|f| f(bg)) {
            add(c.level, "cliche", format!("{} ist eine typische Palette generierter Decks. Akzent aus dem Stoff des Themas ableiten.", c.name));
            cliche = true;
        }
    }
    if !brand.accent && bg.l < 0.4 && acc.c > 0.15 && acc.h >= 115.0 && acc.h <= 135.0 && !cliche {
        add(Level::Error, "cliche", format!("Säuregrün {} auf dunklem Grund ist eine typische Palette generierter Decks. Akzent aus dem Stoff des Themas ableiten.", s.accent));
        cliche = true;
    }
    if !brand.accent && acc.c > 0.12 && acc.h >= 265.0 && acc.h <= 305.0 && !cliche {
        add(Level::Warn, "cliche", format!("Violett-Akzent {}: Lila-Blau gilt als KI-Look. Nur mit Grund (Marke, Thema).", s.accent));
    }

    // Schriften
    let head = font_info(catalog, &s.head_font);
    let body = font_info(catalog, &s.body_font);
    for (name, info, given) in [(&s.head_font, head, brand.head_font), (&s.body_font, body, brand.body_font)] {
        if given {
            continue;
        }
        let Some(info) = info else {
            let tail = match suggest_font(catalog, name) {
                Some(x) => format!(" – meintest du „{x}“?"),
                None => ".".into(),
            };
            add(Level::Error, "font-unknown", format!("Schrift „{name}“ ist nicht im Katalog{tail}"));
            continue;
        };
        match info.flag.as_deref() {
            Some("slop") => add(Level::Error, "font", format!("{} ist Standard generierter Designs. Nur auf ausdrücklichen Wunsch (override).", info.family)),
            Some("common") => add(
                Level::Info,
                "font-common",
                format!("{} ist sehr verbreitet – gut, wenn Neutralität gewollt ist; eigenständiger wirkt eine weniger bekannte Familie.", info.family),
            ),
            _ => {}
        }
    }
    if !brand.body_font
        && let Some(b) = body.filter(|b| b.role == "head")
    {
        add(Level::Error, "pairing", format!("{} ist eine Titelschrift, als Text unleserlich. Textschrift mit role both/body wählen.", b.family));
    }
    if !brand.head_font
        && !brand.body_font
        && let (Some(h), Some(b)) = (head, body)
        && h.family != b.family
    {
        let first = |s: &str| s.split(' ').next().unwrap_or("").to_string();
        if h.cat == "display-serif" && b.cat == "display-serif" {
            add(Level::Error, "pairing", "Zwei Display-Serifen: eine für Titel, für Text eine ruhige Serif oder Grotesk.".into());
        } else if SANS.contains(&h.cat.as_str()) && SANS.contains(&b.cat.as_str()) && first(&h.family) != first(&b.family) {
            add(
                Level::Warn,
                "pairing",
                format!("Zwei verschiedene serifenlose ({} + {}) wirken wie ein Versehen. Besser eine Familie in zwei Gewichten oder Kontrast (Serif + Grotesk).", h.family, b.family),
            );
        }
    }
    if !brand.head_font
        && let (Some(h), Some(w)) = (head, s.head_weight.filter(|w| *w != 0.0))
        && w != 400.0
        && w != 700.0
        && !h.weights.contains(&w)
    {
        add(Level::Info, "weight", format!("{} hat kein Gewicht {}; verfügbar: {}. Die Engine nimmt das nächste.", h.family, crate::js::num(w), weights(&h.weights)));
    }

    // Satz
    if s.title_size.as_deref() == Some("huge") && s.measure.as_deref() == Some("narrow") {
        add(Level::Error, "overflow", "titleSize huge mit measure narrow: Titel mit 80 Zeichen brechen dreizeilig. Eines von beiden lockern.".into());
    }
    if s.radius > 6.0 {
        add(Level::Warn, "radius", format!("radius {}: runde Ecken über 6 px wirken schnell nach Vorlage.", crate::js::num(s.radius)));
    }
    if s.decor.as_deref() != Some("none") {
        add(Level::Warn, "decor", format!("decor {}: Motive nur auf ausdrücklichen Wunsch; Eigenständigkeit kommt über signature.", s.decor.as_deref().unwrap_or("undefined")));
    }
    if s.texture.as_deref().is_some_and(|t| !t.is_empty()) {
        add(Level::Warn, "decor", "texture nur auf Wunsch.".into());
    }
    if s.accent2.as_deref().is_some_and(|t| !t.is_empty()) && s.chart.as_deref() != Some("duo") {
        add(Level::Info, "accent2", "accent2 ist nur mit chart: \"duo\" sichtbar; sonst weglassen.".into());
    }
    out
}

/// Achsen, auf denen sich vorgeschlagene Looks unterscheiden sollen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookAxes {
    pub name: String,
    pub dark: bool,
    pub head_font: String,
    pub accent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_weight: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hero_tone: Option<String>,
}

pub fn axes_of(s: &ThemeSpec) -> LookAxes {
    let space: Vec<&str> = [s.margin.as_deref(), s.measure.as_deref()].into_iter().flatten().filter(|v| !v.is_empty() && *v != "standard").collect();
    LookAxes {
        name: s.name.clone(),
        dark: ok(&s.bg).l < 0.5,
        head_font: s.head_font.clone(),
        accent: s.accent.clone(),
        head_weight: s.head_weight,
        title_size: s.title_size.clone(),
        field: Some(s.field.as_deref().is_some_and(|f| !f.is_empty() && dist(f, &s.accent) >= 8.0)),
        signature: s.signature.as_ref().map(|x| x.kind.clone()),
        space: (!space.is_empty()).then(|| space.join("+")),
        hero_tone: s.hero_tone.clone(),
    }
}

fn weight_class(w: Option<f64>) -> u8 {
    // `w = 700` gilt nur für undefined; 0 bleibt 0
    let w = w.unwrap_or(700.0);
    if w <= 300.0 {
        0
    } else if w <= 500.0 {
        1
    } else {
        2
    }
}

// Farbstrategie: unbunter Akzent (Tinte) ist eine eigene Klasse, sonst Farbtonabstand > 40°
fn hue_differs(a: &str, b: &str) -> bool {
    let (x, y) = (ok(a), ok(b));
    if (x.c < 0.04) != (y.c < 0.04) {
        return true;
    }
    if x.c < 0.04 {
        return false;
    }
    let d = (x.h - y.h).abs();
    d.min(360.0 - d) > 40.0
}

pub fn lint_looks(looks: &[LookAxes], catalog: &[FontInfo]) -> Vec<ThemeIssue> {
    let mut out = Vec::new();
    let cat = |f: &str| font_info(catalog, f).map(|i| i.cat.clone());
    for (i, a) in looks.iter().enumerate() {
        for b in &looks[i + 1..] {
            let axes = [
                a.dark != b.dark,
                cat(&a.head_font) != cat(&b.head_font),
                hue_differs(&a.accent, &b.accent),
                weight_class(a.head_weight) != weight_class(b.head_weight),
                a.title_size.as_deref().unwrap_or("normal") != b.title_size.as_deref().unwrap_or("normal"),
                a.field.unwrap_or(false) != b.field.unwrap_or(false),
                a.signature.as_deref().unwrap_or("none") != b.signature.as_deref().unwrap_or("none"),
                a.space != b.space,
                a.hero_tone.as_deref().unwrap_or("normal") != b.hero_tone.as_deref().unwrap_or("normal"),
            ]
            .into_iter()
            .filter(|x| *x)
            .count();
            if axes < 2 {
                out.push(ThemeIssue {
                    level: Level::Warn,
                    rule: "similar".into(),
                    message: format!(
                        "„{}“ und „{}“ sind zu ähnlich ({axes} von 9 Achsen verschieden). Schriftgenre, Hell/Dunkel, Farbstrategie oder Raum variieren.",
                        a.name, b.name
                    ),
                });
            }
        }
    }
    out
}
