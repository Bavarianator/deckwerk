//! Folien-, Deck- und Motion-Lint (lint.ts): Überlauf, Rand, Kontrast (auch über Fotos), Dichte, Leere, KI-Merkmale
//! in Text und Dramaturgie, Morph und Klicks. Layout-Katalog, Schema-Prüfung, Satzspiegel und Film-Lint kommen über [`LintCtx`].

use std::collections::HashSet;
use std::sync::LazyLock;

use dw_color::{Rgb, contrast};
use dw_model::{BoxEl, Deck, El, ElBox, Gradient, ImgEl, ImgFit, Measured, Profile, Slide, TextEl, format, profile_of};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js::{self, is_ws, len16, num, round, to_fixed, trim};
use crate::typo::is_letter;
use crate::{Issue, SchemaCheck, Severity};

/// Was der Lint vom Layout-Katalog wissen muss (layouts*.ts), in Katalogreihenfolge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutInfo {
    pub id: String,
    /// Formate (FormatId), in denen das Layout gilt; fehlt = alle
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sizes: Option<Vec<String>>,
    /// hat `frames` (Kompositionen)
    #[serde(default)]
    pub frames: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_build: Option<String>,
}

/// Aus dem aufgelösten Theme (`resolveTheme(deck.theme)`) braucht der Lint nur den Satzspiegel-Token.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LintTheme {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin: Option<String>,
}

pub type FilmLint<'a> = dyn Fn(&Deck, &[Measured]) -> Vec<Issue> + 'a;

pub struct LintCtx<'a> {
    pub layouts: &'a [LayoutInfo],
    pub theme: LintTheme,
    pub schema: &'a SchemaCheck<'a>,
    /// film-lint.ts `lintFilm`, nur für Decks mit `film`; fehlt = keine Film-Befunde
    pub film: Option<&'a FilmLint<'a>>,
}

impl LintCtx<'_> {
    fn layout(&self, id: &str) -> Option<&LayoutInfo> {
        self.layouts.iter().find(|l| l.id == id)
    }
}

const MARGIN: f64 = 24.0; // kein Text näher am Folienrand
pub const AIRY: [&str; 9] = ["cover", "section", "statement", "big-number", "photo", "quote", "closing", "blank", "clip"];
const SPARSE: f64 = 0.67; // Füllgrad des Satzspiegels, darunter wirkt eine Inhaltsfolie leer

struct Prof {
    min_px: fn(f64) -> f64,
    words: usize,
    goal: usize,
    unit: &'static str,
    deck_rules: bool,
}

fn prof(p: Profile) -> Prof {
    match p {
        Profile::Slides => Prof { min_px: |_| 13.0, words: 50, goal: 40, unit: "Folie", deck_rules: true },
        Profile::Social => Prof { min_px: |w| w / 60.0, words: 30, goal: 25, unit: "Folie", deck_rules: false },
        Profile::Doc => Prof { min_px: |_| 12.0, words: 350, goal: 300, unit: "Seite", deck_rules: false },
    }
}

/// Satzspiegel (themes.ts `marginsOf`).
pub fn margins_of(m: Option<&str>, w: f64, h: f64) -> [f64; 4] {
    let px = |m: &str| match m {
        "standard" => Some([72.0, 72.0, 60.0, 72.0]),
        "generous" => Some([112.0, 112.0, 72.0, 80.0]),
        "asymmetric" => Some([152.0, 72.0, 60.0, 72.0]),
        _ => None,
    };
    let s = px("standard").unwrap();
    let v = px(m.unwrap_or("standard")).unwrap_or(s);
    let k = if w / h <= 1.2 { 0.0 } else if w <= 800.0 { 0.5 } else { 1.0 };
    [0, 1, 2, 3].map(|i| s[i] + (v[i] - s[i]) * k) // l, r, t, b
}

fn overlap_area(a: &ElBox, b: &ElBox) -> f64 {
    0f64.max((a.x + a.w).min(b.x + b.w) - a.x.max(b.x)) * 0f64.max((a.y + a.h).min(b.y + b.h) - a.y.max(b.y))
}

fn is_video(deck: &Deck) -> bool {
    deck.slides.iter().any(|s| s.layout == "clip")
}

fn words_of(t: &TextEl) -> usize {
    js::words(&t.runs.iter().map(|r| r.text.as_str()).collect::<Vec<_>>().join(" ")).len()
}

fn wcag(a: &str, b: &str) -> f64 {
    let p = |s: &str| if s == "transparent" { Some(Rgb::BLACK) } else { Rgb::parse(s) };
    match (p(a), p(b)) {
        (Some(a), Some(b)) => contrast(a, b),
        _ => f64::NAN,
    }
}

// ---------- JS-Werte ----------

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v ?? '')`
fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn plain(v: Option<&Value>) -> String {
    js_string(v).replace("**", "")
}

fn content<'a>(s: &'a Slide, k: &str) -> Option<&'a Value> {
    s.content.get(k)
}

fn json(v: &Value) -> String {
    if v.is_null() { "{}".into() } else { serde_json::to_string(v).unwrap_or_default() }
}

fn extra_str<'a>(m: &'a serde_json::Map<String, Value>, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str)
}

// ---------- KI-Merkmale im Text ----------

// Floskeln; die abschließende Klasse ersetzt den Lookahead (?![\p{L}\d]) und wird vom Treffer wieder abgezogen
static FLOSKELN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(nahtlos\p{L}*|ganzheitlich\p{L}*|innovativ(?:e[rnms]?)?|revolution[äa]r\p{L}*|maßgeschneidert\p{L}*|synergie\p{L}*|mehrwert\p{L}*",
        r"|auf (?:das |die )?nächsten? (?:level|stufe)|game[- ]?changer|in der heutigen (?:schnelllebigen )?(?:welt|zeit)|schnelllebig\p{L}*",
        r"|entfessel\p{L}*|transformativ\p{L}*|potenzial\p{L}* (?:\p{L}+ )?(?:entfalt|freisetz|freizusetz|freigesetzt)\p{L}*|aus einer hand",
        r"|zukunftssicher\p{L}*|state of the art|leuchtturm(?:projekt\p{L}*)?)(?:[^\p{L}0-9]|$)"
    ))
    .unwrap()
});
static NICHT_NUR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)nicht nur(?-u:\b)[^.!?]*(?-u:\b)sondern(?-u:\b)").unwrap());
static EMOJI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Emoji_Presentation}").unwrap());

fn floskeln(t: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = 0;
    while at <= t.len() {
        let Some(c) = FLOSKELN.captures_at(t, at) else { break };
        let m = c.get(1).unwrap();
        let before = t[..m.start()].chars().next_back();
        // Lookbehind (?<![\p{L}\d]) und mehrwert(?!steuer)
        let bad = before.is_some_and(|b| is_letter(b) || b.is_ascii_digit()) || m.as_str().to_lowercase().starts_with("mehrwertsteuer");
        if bad {
            at = m.start() + t[m.start()..].chars().next().map_or(1, char::len_utf8);
        } else {
            out.push(m.as_str().to_string());
            at = m.end().max(m.start() + 1);
        }
    }
    out
}

static NO_TEXT: [&str; 8] = ["src", "url", "image", "icon", "qr", "video", "captions", "pauses"];

fn texts_of(v: &Value, key: &str, out: &mut Vec<String>) {
    static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\]\([^)]*\)").unwrap());
    if NO_TEXT.contains(&key) {
        return;
    }
    match v {
        Value::String(s) => out.push(LINK.replace_all(&s.replace("**", ""), "]").into_owned()),
        Value::Array(a) => a.iter().for_each(|x| texts_of(x, key, out)),
        Value::Object(o) => o.iter().for_each(|(k, x)| texts_of(x, k, out)),
        _ => {}
    }
}

// ---------- Text auf Foto ----------

// rgb() aus lint.ts: parseInt je Hex-Paar, NaN bei Müll
fn rgb(h: &str) -> [f64; 3] {
    let u: Vec<u16> = h.encode_utf16().collect();
    [1, 3, 5].map(|i| {
        let s = String::from_utf16_lossy(u.get(i..(i + 2).min(u.len())).unwrap_or(&[]));
        let d: String = s.chars().take_while(char::is_ascii_hexdigit).collect();
        if d.is_empty() { f64::NAN } else { i64::from_str_radix(&d, 16).unwrap() as f64 }
    })
}

fn to_hex(c: [f64; 3]) -> String {
    let mut s = String::from("#");
    for v in c {
        let x = round(v.clamp(0.0, 255.0));
        if v.is_nan() {
            s.push_str("NaN");
        } else {
            s.push_str(&format!("{:02x}", x as u32));
        }
    }
    s
}

fn over(base: &str, color: &str, alpha: f64) -> String {
    let (b, c) = (rgb(base), rgb(color));
    to_hex([0, 1, 2].map(|i| b[i] * (1.0 - alpha) + c[i] * alpha))
}

fn gradient_at(g: &Gradient, b: &ElBox, x: f64, y: f64) -> (String, f64) {
    let r = (g.angle * std::f64::consts::PI) / 180.0;
    let (sx, sy) = (r.sin(), -r.cos());
    let len = (b.w * sx).abs() + (b.h * sy).abs();
    let p = (((x - b.x - b.w / 2.0) * sx + (y - b.y - b.h / 2.0) * sy) / len + 0.5).clamp(0.0, 1.0); // clamp lässt NaN stehen wie Math.max/min
    let fi = g.stops.iter().position(|s| s.pos >= p).map_or(-1, |i| i as i64);
    let i = 0.max(fi - 1) as usize;
    let (a, z) = (&g.stops[i], &g.stops[(i + 1).min(g.stops.len() - 1)]);
    let k = if z.pos > a.pos { ((p - a.pos) / (z.pos - a.pos)).clamp(0.0, 1.0) } else { 0.0 };
    (over(&a.color, &z.color, k), a.alpha + (z.alpha - a.alpha) * k)
}

// Worst Case: helle Schrift über weißem, dunkle über schwarzem Foto, darüber alle Overlays in DOM-Reihenfolge; schlechteste Ecke
fn bg_over_photo(t: &TextEl, photo: usize, els: &[El]) -> String {
    let col = t.runs.first().map_or("#000000", |r| r.color.as_str());
    let light = wcag(col, "#000000") > wcag(col, "#FFFFFF");
    let overlays: Vec<&BoxEl> = els[photo + 1..]
        .iter()
        .filter_map(|e| match e {
            El::Box(b) if (b.fill.is_some() || b.gradient.is_some()) && overlap_area(&b.base.bbox, &t.base.bbox) > 0.0 => Some(b),
            _ => None,
        })
        .collect();
    let b = t.base.bbox;
    let corners = [(b.x, b.y), (b.x + b.w, b.y), (b.x, b.y + b.h), (b.x + b.w, b.y + b.h)];
    let bgs: Vec<String> = corners
        .iter()
        .map(|&(x, y)| {
            overlays.iter().fold(if light { "#FFFFFF" } else { "#000000" }.to_string(), |acc, o| {
                let ob = o.base.bbox;
                if x < ob.x || x > ob.x + ob.w || y < ob.y || y > ob.y + ob.h {
                    return acc;
                }
                let (c, a) = match &o.gradient {
                    Some(g) => gradient_at(g, &ob, x, y),
                    None => {
                        let f = o.fill.as_ref().unwrap();
                        (f.color.clone(), f.alpha)
                    }
                };
                over(&acc, &c, a)
            })
        })
        .collect();
    bgs.into_iter().reduce(|w, c| if wcag(col, &c) < wcag(col, &w) { c } else { w }).unwrap()
}

fn is_text(e: &El) -> Option<&TextEl> {
    match e {
        El::Text(t) => Some(t),
        _ => None,
    }
}

pub fn lint_slide(deck: &Deck, i: usize, m: &Measured, ctx: &LintCtx) -> Vec<Issue> {
    let s = &deck.slides[i];
    let profile = profile_of(deck.size);
    let prof = prof(profile);
    let mut out: Vec<Issue> = Vec::new();
    let mut add = |severity: Severity, rule: &str, message: String, slot: Option<&str>| {
        out.push(Issue { slide: i, slide_id: s.id.clone(), slot: slot.map(str::to_string), severity, rule: rule.into(), message })
    };
    use Severity::{Error, Warn};

    let Some(def) = ctx.layout(&s.layout) else {
        let ids: Vec<&str> = ctx.layouts.iter().map(|l| l.id.as_str()).collect();
        add(Error, "layout", format!("Unbekanntes Layout \"{}\". Erlaubt: {}", s.layout, ids.join(", ")), None);
        return out;
    };
    let size = deck.size();
    let (pw, ph) = (size.w, size.h);
    if let Some(sizes) = &def.sizes
        && !sizes.iter().any(|f| format(f).is_some_and(|f| f.w == pw && f.h == ph))
    {
        let names: Vec<&str> = sizes.iter().map(|f| format(f).map_or("undefined", |f| f.name)).collect();
        add(
            Warn,
            "format",
            format!(
                "Layout \"{}\" ist für {} gedacht, das Deck hat {}×{}. Format mit update_deck umstellen oder ein anderes Layout wählen.",
                s.layout,
                names.join(" oder "),
                num(pw),
                num(ph)
            ),
            None,
        );
    }
    for e in (ctx.schema)(&s.layout, &s.content).unwrap_or_default() {
        let p = e.path.join(".");
        let slot = e.path.first().cloned().unwrap_or_default();
        add(Error, "schema", format!("{}: {}", if p.is_empty() { "content" } else { &p }, e.message), Some(&slot));
    }

    for o in &m.fit.overflow {
        use dw_model::OverflowKind::*;
        let what = match o.kind {
            Lines => "hat zu viele Zeilen".to_string(),
            Width => "hat ein zu langes Wort".to_string(),
            Height => format!("läuft um {} px über", num(round(o.over_px))),
        };
        add(Error, "overflow", format!("\"{}\" {what}, auch in der kleinsten Schriftstufe. Text kürzen oder Inhalt auf zwei Folien verteilen.", o.slot), Some(&o.slot));
    }

    let texts: Vec<&TextEl> = m.els.iter().filter_map(is_text).collect();
    // freie Elemente (items.*) platziert der Mensch bewusst, auch überlappend
    let solids: Vec<&El> = m
        .els
        .iter()
        .filter(|e| !matches!(e, El::Box(_)) && !matches!(e, El::Img(im) if im.under == Some(true)) && !e.base().slot.starts_with("items."))
        .collect();
    let photos: Vec<(usize, &ImgEl)> = m
        .els
        .iter()
        .enumerate()
        .filter_map(|(k, e)| match e {
            El::Img(im) if im.under == Some(true) => Some((k, im)),
            _ => None,
        })
        .collect();
    for t in &texts {
        let b = t.base.bbox;
        let slot = t.base.slot.as_str();
        if !slot.starts_with("items.") && (b.x < MARGIN || b.y < MARGIN || b.x + b.w > size.w - MARGIN || b.y + b.h > size.h - MARGIN) {
            add(Error, "frame", format!("\"{slot}\" ragt in den Rand der Folie."), Some(slot));
        }
        if t.size_px < (prof.min_px)(size.w) {
            add(Error, "min-size", format!("\"{slot}\" ist mit {} pt zu klein.", num(round(t.size_px * 0.75))), Some(slot));
        }
        let photo = photos.iter().find(|(_, p)| overlap_area(&p.base.bbox, &b) > 4.0);
        let bg = match photo {
            Some((k, _)) => bg_over_photo(t, *k, &m.els),
            None => t.bg.clone(),
        };
        if !bg.is_empty() {
            let big = t.size_px >= 24.0 || (t.size_px >= 18.6 && t.runs.iter().any(|r| r.bold));
            for r in &t.runs {
                let ratio = wcag(&r.color, &bg);
                if ratio < if big { 3.0 } else { 4.5 } {
                    // freie Elemente: Hintergrund darunter kennt der DOM-Test nicht, daher nur Warnung
                    let sev = if slot.starts_with("items.") { Warn } else { Error };
                    let msg = if photo.is_some() {
                        format!("\"{slot}\" liegt auf dem Foto und ist im ungünstigsten Fall kaum lesbar ({}:1). Overlay verstärken oder Text auf eine Karte setzen.", to_fixed(ratio, 1))
                    } else {
                        format!("\"{slot}\" hat zu wenig Kontrast ({}:1).", to_fixed(ratio, 1))
                    };
                    add(sev, if photo.is_some() { "photo-contrast" } else { "contrast" }, msg, Some(slot));
                    break;
                }
            }
        }
        if t.font == dw_model::FontRole::Head && t.lines > 1 && t.list.is_none() {
            let all: String = t.runs.iter().map(|r| format!("{}{}", r.text, if r.break_after == Some(true) { "\n" } else { " " })).collect();
            let last = trim(&all).split('\n').next_back().unwrap_or("");
            if js::words(trim(last)).len() <= 1 {
                add(Warn, "widow", format!("\"{slot}\" endet mit einem einzelnen Wort in der letzten Zeile – umformulieren."), Some(slot));
            }
        }
    }
    for (a, x) in solids.iter().enumerate() {
        for y in &solids[a + 1..] {
            if overlap_area(&x.base().bbox, &y.base().bbox) > 4.0 {
                let sa = x.base().slot.as_str();
                add(Error, "overlap", format!("\"{sa}\" überlappt \"{}\".", y.base().slot), Some(sa));
            }
        }
    }

    // Fußzeile (Kapitel, Seitenzahl) zählt nicht
    let count: usize = texts.iter().filter(|t| !t.base.slot.starts_with("_footer")).map(|t| words_of(t)).sum();
    if count > prof.words {
        let msg = if profile == Profile::Slides {
            format!("{count} Wörter auf der Folie – in 3 Sekunden nicht erfassbar (Ziel: unter 40). Kürzen, Rest in die Speaker Notes.")
        } else {
            format!("{count} Wörter auf der {} – zu viel für dieses Format (Ziel: unter {}). Kürzen oder auf eine weitere {} verteilen.", prof.unit, prof.goal, prof.unit)
        };
        add(Warn, "density", msg, None);
    }
    let cj = json(&s.content);
    if cj.contains("\"src\":\"\"") || cj.contains("\"image\":\"\"") {
        add(Warn, "image", "Kein Bild gesetzt – es wird ein Platzhalter angezeigt. Mit find_images ein Foto suchen oder eigenes Bild einsetzen.".into(), None);
    }
    for it in s.items.iter().flatten() {
        if it.kind == dw_model::ItemKind::Image && extra_str(&it.extra, "alt").is_none_or(|a| trim(a).is_empty()) {
            add(
                Warn,
                "alt-fehlt",
                "Bild ohne Alternativtext – Screenreader lesen nichts vor. Alternativtext setzen (alt), z. B. was das Bild zeigt.".into(),
                Some(&format!("items.{}", it.id)),
            );
        }
    }
    for it in s.items.iter().flatten() {
        let Some(link) = extra_str(&it.extra, "link") else { continue };
        let Some(d) = link.strip_prefix('#').filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())) else { continue };
        let n: f64 = d.parse().unwrap_or(f64::INFINITY);
        if n < 1.0 || n > deck.slides.len() as f64 {
            add(
                Warn,
                "link-ziel",
                format!("Link {link} zeigt auf keine Folie – das Deck hat {} Folien. Ziel korrigieren oder link entfernen.", deck.slides.len()),
                Some(&format!("items.{}", it.id)),
            );
        }
    }
    // Druck: Logos (_-Slots) und kleine Bilder zählen nicht
    if profile == Profile::Doc {
        for e in &m.els {
            let El::Img(e) = e else { continue };
            let Some(nat) = e.nat.filter(|n| n.w != 0.0 && n.h != 0.0 && !n.w.is_nan() && !n.h.is_nan()) else { continue };
            let bx = e.base.bbox;
            if e.src.is_empty() || e.base.slot.starts_with('_') || bx.w * bx.h < (pw * ph) / 12.0 {
                continue;
            }
            let (cw, ch) = e.crop.map_or((1.0, 1.0), |c| (c.w, c.h));
            let r = [bx.w / cw / nat.w, bx.h / ch / nat.h];
            let k = if e.fit == ImgFit::Cover || e.crop.is_some() { js_max(&r) } else { js_min(&r) };
            let ppi = round(96.0 / k);
            if ppi < 250.0 {
                add(
                    Warn,
                    "print-res",
                    format!("Foto für den Druck zu klein: ca. {} ppi bei A4-Größe (Druckereien verlangen 250–300 ppi). Hochformat-Foto nehmen (find_images orientation portrait), ein größeres Bild wählen oder das Foto kleiner einsetzen.", num(ppi)),
                    Some(&e.base.slot),
                );
            }
        }
    }
    // Live-Test: die KI lässt highlight trotz Schema-Hinweis weg
    if let Some(chart) = content(s, "chart").filter(|c| truthy(Some(c)))
        && !truthy(chart.get("highlight"))
        && chart.get("categories").and_then(Value::as_array).is_some_and(|c| c.len() > 2)
        && chart.get("type").and_then(Value::as_str) != Some("waterfall")
    {
        add(Warn, "highlight", "Diagramm ohne highlight: Alle Werte sind gleich stark. Die Kategorie oder Serie, die der Titel meint, als highlight setzen.".into(), Some("chart"));
    }
    // Wirkt leer: Hülle aller Inhalte samt Titel bedeckt nur einen kleinen Teil des Satzspiegels
    let has_image = s.content.as_object().is_some_and(|o| o.contains_key("image"));
    if !AIRY.contains(&s.layout.as_str()) && s.layout != "agenda" && s.frame.as_deref() != Some("split") && !has_image && count <= prof.words && prof.deck_rules {
        let (w, h) = (size.w, size.h);
        let used: Vec<&ElBox> = m
            .els
            .iter()
            .map(|e| e.base())
            .filter(|b| !(b.slot.starts_with("_footer") || b.slot == "source" || b.slot == "note") && b.bbox.w * b.bbox.h < 0.6 * w * h)
            .map(|b| &b.bbox)
            .collect();
        if !used.is_empty() {
            let x0 = js_min(&used.iter().map(|b| b.x).collect::<Vec<_>>());
            let y0 = js_min(&used.iter().map(|b| b.y).collect::<Vec<_>>());
            let x1 = js_max(&used.iter().map(|b| b.x + b.w).collect::<Vec<_>>());
            let y1 = js_max(&used.iter().map(|b| b.y + b.h).collect::<Vec<_>>());
            let [l, r, t, b] = margins_of(ctx.theme.margin.as_deref(), w, h);
            let fill = ((x1.min(w - r) - x0.max(l)) * (y1.min(h - b) - y0.max(t))) / ((w - l - r) * (h - t - b));
            if fill < SPARSE {
                add(Warn, "sparse", format!("Folie wirkt leer: Titel und Inhalt füllen nur {} % des Satzspiegels. Mehr Substanz ergänzen (Zahl, Beispiel, Beleg), ein Foto dazunehmen (image-text), auf eine luftige Form wechseln (statement, big-number) oder mit der Nachbarfolie zusammenlegen.", num(round(fill * 100.0))), None);
            }
        }
    }
    let mut found: Vec<String> = Vec::new();
    let mut put = |x: String| {
        if !found.contains(&x) {
            found.push(x);
        }
    };
    let mut ts = Vec::new();
    texts_of(&s.content, "", &mut ts);
    for t in &ts {
        for f in floskeln(t) {
            put(format!("„{f}“"));
        }
        if NICHT_NUR.is_match(t) {
            put("„nicht nur … sondern“".into());
        }
        if EMOJI.is_match(t) {
            put("Emoji".into());
        }
    }
    if !found.is_empty() {
        add(Warn, "ki-sprache", format!("Klingt generiert: {}. Stattdessen konkret werden (Zahl, Name, Beispiel aus dem Material) und in eigenen Worten sagen, was passiert.", found.join(", ")), None);
    }
    out
}

// Math.min/max über eine Liste: NaN gewinnt
fn js_min(v: &[f64]) -> f64 {
    v.iter().fold(f64::INFINITY, |a, &b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) })
}
fn js_max(v: &[f64]) -> f64 {
    v.iter().fold(f64::NEG_INFINITY, |a, &b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) })
}

pub fn lint_deck(deck: &Deck, measured: &[Measured], ctx: &LintCtx) -> Vec<Issue> {
    let mut out: Vec<Issue> = (0..deck.slides.len()).flat_map(|i| lint_slide(deck, i, &measured[i], ctx)).collect();
    if deck.extra.get("film").is_some_and(|f| truthy(Some(f)))
        && let Some(film) = ctx.film
    {
        out.extend(film(deck, measured));
    }
    if !prof(profile_of(deck.size)).deck_rules {
        out.extend(lint_motion(deck, measured, ctx));
        return out;
    }
    let s = &deck.slides;
    let mut warn = |i: usize, rule: &str, message: String| {
        out.push(Issue { slide: i, slide_id: s[i].id.clone(), slot: None, severity: Severity::Warn, rule: rule.into(), message })
    };
    let video = is_video(deck);
    let n = s.len();
    if !video && n > 0 && s[0].layout != "cover" {
        warn(0, "structure", "Das Deck beginnt nicht mit einer Titelfolie (cover).".into());
    }
    if !video && n > 3 && s[n - 1].layout != "closing" {
        warn(n - 1, "structure", "Das Deck endet nicht mit einer Abschlussfolie (closing).".into());
    }
    for i in 2..n {
        if !video && s[i].layout == s[i - 1].layout && s[i].layout == s[i - 2].layout {
            warn(i, "rhythm", format!("Drittes \"{}\" in Folge – Layout abwechseln, damit das Deck lebendig bleibt.", s[i].layout));
        }
    }
    // drei gleich aufgebaute Folien ohne Bild hintereinander wirken wie eine Vorlage
    let look = |x: &Slide| {
        if !ctx.layout(&x.layout).is_some_and(|l| l.frames) {
            return format!("-{}", x.id);
        }
        let photo = json(&x.content).contains("\"src\":\"asset") || x.bg.as_ref().is_some_and(|b| truthy(b.get("image")));
        format!("{}|{}|{photo}", x.frame.as_deref().unwrap_or("top"), x.tone.as_deref().unwrap_or(""))
    };
    let looks: Vec<String> = s.iter().map(look).collect();
    for i in 2..n {
        if looks[i].ends_with("false") && looks[i] == looks[i - 1] && looks[i] == looks[i - 2] {
            warn(i, "monotone", "Dritte Folie in Folge mit gleicher Komposition, gleichem Ton und ohne Foto – ein Foto, eine luftige Folie (statement, big-number) oder einen anderen frame einsetzen.".into());
        }
    }
    let cards = |x: &Slide| x.variant.as_deref() == Some("cards") || ["icon-grid", "process", "pricing", "team"].contains(&x.layout.as_str());
    for i in 1..n {
        if cards(&s[i]) && cards(&s[i - 1]) {
            warn(i, "cards", "Zweites Kartenraster in Folge – wirkt wie generiert. Eine der Folien als Liste, Zahlenzeile, Statement oder Chart setzen.".into());
        }
    }
    let icon_slides: Vec<usize> = (0..n).filter(|&i| json(&s[i].content).contains("\"icon\":")).collect();
    if icon_slides.len() > 2 {
        warn(icon_slides[2], "icons", format!("Icons auf {} Folien – als Schmuck wirken sie generiert. Nur behalten, wo das Symbol selbst Information trägt.", icon_slides.len()));
    }
    let mut run = 0;
    for (i, x) in s.iter().enumerate() {
        run = if AIRY.contains(&x.layout.as_str()) { 0 } else { run + 1 };
        if run == 5 {
            warn(i, "breath", "Fünf dichte Folien in Folge – eine luftige Folie einschieben (statement, big-number oder photo mit einem Satz).".into());
        }
    }
    // Generierte Dramaturgie: immer drei Punkte, Doppelpunkt- und Gedankenstrich-Titel
    const LISTS: [&str; 7] = ["bullets", "process", "timeline", "kpi-grid", "icon-grid", "image-text", "two-column"];
    const LIST_SKIP: [&str; 6] = ["columns", "rows", "criteria", "options", "quadrants", "contact"];
    let main_list = |x: &Slide| -> Option<usize> {
        x.content.as_object()?.iter().find_map(|(k, v)| match v {
            Value::Array(a) if !LIST_SKIP.contains(&k.as_str()) && a.iter().all(|e| e.is_string() || e.is_object() || e.is_array()) => Some(a.len()),
            _ => None,
        })
    };
    let threes: Vec<usize> = (0..n).filter(|&i| LISTS.contains(&s[i].layout.as_str()) && main_list(&s[i]) == Some(3)).collect();
    if threes.len() > 2 {
        warn(threes[2], "ki-muster", format!("Auf {} Folien genau drei Punkte – immer genau drei wirkt generiert. So viele Punkte nehmen, wie das Material hergibt: zwei, vier, oder einen einzigen als Statement.", threes.len()));
    }
    let titles: Vec<(usize, &str)> = (0..n).filter_map(|i| content(&s[i], "title").and_then(Value::as_str).map(|t| (i, t))).collect();
    let mut pattern = |test: &dyn Fn(&str) -> bool, message: &str| {
        let hits: Vec<usize> = titles.iter().filter(|(_, t)| test(t)).map(|(i, _)| *i).collect();
        if titles.len() >= 3 && hits.len() as f64 > titles.len() as f64 / 3.0 {
            warn(hits[0], "ki-muster", format!("{} von {} Titeln {message}", hits.len(), titles.len()));
        }
    };
    // /^[^:]{1,40}:\s+\S/
    let stichwort = |t: &str| {
        let u: Vec<char> = t.chars().collect();
        let Some(c) = u.iter().position(|&c| c == ':') else { return false };
        (1..=40).contains(&len16(&t[..t.char_indices().nth(c).unwrap().0])) && {
            let ws = u[c + 1..].iter().take_while(|c| is_ws(**c)).count();
            ws > 0 && u.get(c + 1 + ws).is_some()
        }
    };
    pattern(&stichwort, "nach dem Muster „Stichwort: Aussage“ – wirkt generiert. Die Aussage als ganzen Satz schreiben, ohne Vorspann.");
    pattern(&|t: &str| t.contains(" – ") || t.contains('—'), "mit Gedankenstrich – eine Häufung wirkt generiert. Lieber Punkt oder Komma, oder zwei Sätze daraus machen.");
    // Vorlagen-Muster: Ornamente ohne Information, gespiegelter Schluss, alle Titel gleich gebaut
    let inhalt: Vec<usize> = (0..n).filter(|&i| !AIRY.contains(&s[i].layout.as_str())).collect();
    let brows: Vec<usize> = inhalt.iter().copied().filter(|&i| !trim(&plain(content(&s[i], "eyebrow"))).is_empty()).collect();
    if n >= 6 && brows.len() as f64 > inhalt.len() as f64 / 3.0 {
        warn(brows[0], "ornament", format!("Eyebrow auf {} von {} Inhaltsfolien – eine Überzeile über jedem Titel wirkt wie Vorlage. Nur dort setzen, wo es Orientierung gibt (Kapitel, Stand), sonst eyebrow weglassen.", brows.len(), inhalt.len()));
    }
    let src = |x: &Slide| -> Option<Value> {
        match content(x, "image") {
            Some(Value::String(v)) => Some(Value::String(v.clone())),
            Some(v) => v.get("src").cloned(),
            None => None,
        }
    };
    if let Some(cover) = s.iter().find(|x| x.layout == "cover").and_then(src).filter(|c| truthy(Some(c))) {
        for (i, x) in s.iter().enumerate() {
            if x.layout == "closing" && src(x).is_some_and(|v| v == cover) {
                warn(i, "echo", "Schluss wiederholt das Cover-Foto – der Bogen wirkt wie Vorlage. Ein anderes Bild (find_images) oder einen rein typografischen Schluss ohne image setzen.".into());
            }
        }
    }
    // ponytail: Titellänge in Zeichen statt gemessener Zeilen (wie TS)
    let heads: Vec<usize> = inhalt.iter().copied().filter(|&i| content(&s[i], "title").is_some_and(Value::is_string)).collect();
    let formel: Vec<usize> = heads
        .iter()
        .copied()
        .filter(|&i| {
            let l = len16(&plain(content(&s[i], "title")));
            (45..=90).contains(&l)
        })
        .collect();
    let stage = s.iter().any(|x| {
        x.layout == "big-number" || (x.layout == "statement" && len16(&plain(content(x, "text"))) < 45) || (x.layout == "photo" && len16(&plain(content(x, "title"))) < 45)
    });
    if n >= 8 && !heads.is_empty() && formel.len() as f64 >= 0.8 * heads.len() as f64 && !stage {
        warn(formel[0], "titel-formel", format!("{} von {} Titeln sind gleich gebaute Zwei- bis Dreizeiler – wirkt wie Vorlage. Ein bis zwei Folien mit kurzem Titel (höchstens 5 Wörter) bauen oder als Bühnenfolie (statement mit kurzem Satz, big-number, photo).", formel.len(), heads.len()));
    }
    // Mut: ein Mensch bricht mindestens einmal den Rhythmus
    let img_src = |x: &Slide| truthy(content(x, "image").and_then(|v| v.get("src")));
    let bold = |x: &Slide| {
        let tone = x.tone.as_deref();
        ((tone == Some("accent") || tone == Some("invert")) && x.layout != "section")
            || x.layout == "photo"
            || (x.variant.as_deref() == Some("poster")
                && ((x.layout == "big-number" && !img_src(x)) || (x.layout == "statement" && len16(&plain(content(x, "text"))) <= 60)))
            || (x.layout == "cover" && x.variant.as_deref() == Some("bottom") && img_src(x))
    };
    if n >= 8 && !s.iter().any(bold) {
        warn(0, "mut", "Kein mutiger Moment im Deck – alle Folien im gleichen Ton. Ein Mensch würde einmal den Rhythmus brechen: riesige Zahl auf Akzentfläche (big-number, tone accent oder Variante poster), eine Frage auf dunklem Grund (statement, tone invert), ein Vollbildfoto (photo).".into());
    }
    out.extend(lint_motion(deck, measured, ctx));
    out
}

// ---------- Animation ----------

/// deck.ts `morphText`: ohne Leerraum, klein, mindestens 2 UTF-16-Einheiten
fn morph_text(t: &str) -> Option<String> {
    let k: String = t.chars().filter(|c| !is_ws(*c)).collect::<String>().to_lowercase();
    (len16(&k) > 1).then_some(k)
}

pub fn morph_key(e: &El) -> Option<String> {
    match e {
        El::Text(t) => morph_text(&t.runs.iter().map(|r| r.text.as_str()).collect::<String>()),
        El::Img(i) => Some(format!("img:{}", i.src)),
        _ => None,
    }
}

/// deck.ts `morphNames`: gleicher Inhalt wandert zuerst, danach gleicher Slot; Name je Element von next.
pub fn morph_names(prev: &[(String, Option<String>)], next: &[(String, Option<String>)]) -> Vec<String> {
    let slots: HashSet<&str> = prev.iter().map(|(s, _)| s.as_str()).collect();
    let mut taken: HashSet<String> = HashSet::new();
    let by_key: Vec<Option<String>> = next
        .iter()
        .map(|(slot, key)| {
            let cands: Vec<&String> = prev.iter().filter(|(ps, pk)| pk.is_some() && pk == key && !taken.contains(ps)).map(|(ps, _)| ps).collect();
            let s = if cands.contains(&slot) { Some(slot.clone()) } else { cands.first().map(|c| (*c).clone()) };
            if let Some(s) = &s {
                taken.insert(s.clone());
            }
            s
        })
        .collect();
    next.iter()
        .zip(by_key)
        .map(|((slot, _), k)| {
            if let Some(k) = k {
                return k;
            }
            if !slots.contains(slot.as_str()) {
                return slot.clone();
            }
            if taken.contains(slot) {
                return format!("{slot}~"); // eigener Slot wandert schon in ein anderes Element
            }
            taken.insert(slot.clone());
            slot.clone()
        })
        .collect()
}

fn transition_of(deck: &Deck, i: usize) -> Option<String> {
    if i == 0 {
        return Some("none".into());
    }
    match deck.slides.get(i).and_then(|s| s.extra.get("transition")) {
        Some(Value::String(t)) => Some(t.clone()),
        Some(v) if !v.is_null() => Some(js_string(Some(v))),
        _ => deck.transition.clone(),
    }
}

/// layouts.ts `buildOf`: eigener build > Bewegungsstil des Decks > Standard des Layouts.
pub fn build_of(deck: &Deck, i: usize, ctx: &LintCtx) -> String {
    let s = &deck.slides[i];
    if let Some(b) = s.extra.get("build").filter(|b| truthy(Some(b))) {
        return js_string(Some(b));
    }
    let def = ctx.layout(&s.layout).and_then(|l| l.default_build.clone()).unwrap_or_else(|| "none".into());
    let motion = extra_str(&deck.extra, "motion");
    match motion {
        Some("none") => "none".into(),
        Some("calm") => if def == "none" { "none" } else { "fade" }.into(),
        Some("lively") => {
            static PHOTO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""src":"(asset|file|https?):"#).unwrap());
            let img = match content(s, "image") {
                None | Some(Value::Null) => "\"\"".to_string(),
                Some(v) => serde_json::to_string(v).unwrap_or_default(),
            };
            if s.layout != "gallery" && PHOTO.is_match(&img) {
                "photo".into()
            } else if def == "none" {
                if s.layout == "blank" { "none" } else { "fade" }.into()
            } else if def == "fade" && s.layout != "statement" && s.layout != "quote" {
                "stagger".into()
            } else {
                def
            }
        }
        _ => def,
    }
}

/// deck.ts `itemClicks`: Klicks der freien Elemente im Klick-Modus.
pub fn item_clicks(s: &Slide) -> usize {
    s.items
        .iter()
        .flatten()
        .filter(|it| {
            let anim = extra_str(&it.extra, "anim");
            anim.is_some_and(|a| !a.is_empty() && a != "none" && a != "breathe") && extra_str(&it.extra, "animStart").unwrap_or("click") == "click"
        })
        .count()
}

/// Morph braucht gemeinsame Elemente, ein Übergangstyp pro Deck, der Vortrag soll nicht im Klicken stocken.
pub fn lint_motion(deck: &Deck, measured: &[Measured], ctx: &LintCtx) -> Vec<Issue> {
    let mut out = Vec::new();
    let mut warn = |i: usize, rule: &str, message: String| {
        out.push(Issue { slide: i, slide_id: deck.slides[i].id.clone(), slot: None, severity: Severity::Warn, rule: rule.into(), message })
    };
    let video = is_video(deck);
    let own = |k: usize| -> Vec<(String, Option<String>)> { measured[k].els.iter().map(|e| (e.base().slot.clone(), morph_key(e))).collect() };
    for (i, s) in deck.slides.iter().enumerate() {
        if transition_of(deck, i).as_deref() == Some("morph") && i > 0 && measured.get(i).is_some() && measured.get(i - 1).is_some() {
            // Titel und Rahmen (Fußzeile) zählen nicht
            let prev = own(i - 1);
            let before: HashSet<&str> = prev.iter().map(|(s, _)| s.as_str()).collect();
            if !morph_names(&prev, &own(i)).iter().any(|n| before.contains(n.as_str()) && n != "title" && !n.starts_with('_')) {
                warn(i, "morph", "Morph ohne gemeinsames Element mit der vorigen Folie (außer dem Titel) – wirkt nur wie Überblenden. Morph braucht wörtlich denselben Text (Agenda-Punkt = Kapiteltitel, Kennzahl = große Zahl), dasselbe Foto oder dasselbe Layout mit anderem focus/highlight; sonst transition weglassen.".into());
            }
        }
        if let Some(t) = extra_str(&s.extra, "transition").filter(|t| !t.is_empty())
            && !video
            && t != "morph"
            && t != "none"
            && Some(t) != deck.transition.as_deref()
        {
            warn(i, "transition", format!("Übergang {t} weicht vom Deck-Übergang {} ab. Ein Übergangstyp pro Deck; pro Folie nur morph.", deck.transition.as_deref().unwrap_or("undefined")));
        }
        let Some(m) = measured.get(i) else { continue };
        if deck.mode.as_deref() != Some("click") {
            continue;
        }
        let groups = m.els.iter().filter_map(|e| e.base().build).collect::<HashSet<_>>().len();
        let clicks = if build_of(deck, i, ctx) == "list" { groups } else { 0 } + item_clicks(s);
        if clicks > 5 {
            warn(i, "clicks", format!("{clicks} Klicks, bis die Folie steht – der Vortrag stockt. Aufbau stagger statt list, weniger animierte Elemente oder Folie teilen."));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floskel() {
        assert_eq!(floskeln("Ein nahtloser Ablauf, Mehrwertsteuer und Mehrwert."), vec!["nahtloser", "Mehrwert"]);
        assert_eq!(floskeln("innovative2 innovativen xinnovativ innovativ"), vec!["innovativen", "innovativ"]);
        assert!(NICHT_NUR.is_match("Nicht nur schnell, sondern gut"));
    }
}
