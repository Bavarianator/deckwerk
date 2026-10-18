//! Gemeinsame Bausteine der Layouts (slide.tsx Frame/Header/T/Points, slide.css): Kontext `Cx`, Stil-Helfer,
//! Inhalt lesen, Rahmen mit Satzspiegel, Kopf, Fußzeile, Punkte, Linien. Layouts in `layouts/*.rs` bauen nur daraus.
// Bausteine für die Layout-Gruppen: bis zu deren Port teils ungenutzt
#![allow(dead_code)]

use dw_color::Rgb;
use dw_model::{Deck, Profile};
use dw_theme::{Elements, FontRef, Role, SigKind, Theme, Tokens, margins_of};
use serde_json::Value;
use taffy::prelude::*;

use crate::Error;
use crate::decor;
use crate::table::TableSpec;
use crate::text::TextSpec;
use crate::tree::{BoxSpec, ChartBox, Div, ImgSpec, Kind};
use dw_model::{Align, BoxShadow, ImgFit};

/// Komposition der Folie (Slide.frame); `top` ist der Standard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameId {
    Top,
    Split,
    Band,
    Center,
}

impl FrameId {
    pub fn parse(s: &str) -> Option<FrameId> {
        match s {
            "top" => Some(FrameId::Top),
            "split" => Some(FrameId::Split),
            "band" => Some(FrameId::Band),
            "center" => Some(FrameId::Center),
            _ => None,
        }
    }
}

/// Farben, die CSS über --text/--muted/--accent erbt (auf Farbflächen umgesetzt).
#[derive(Debug, Clone, Copy)]
pub struct Pal {
    pub text: Rgb,
    pub muted: Rgb,
    pub accent: Rgb,
}

/// Alles, was ein Layout zum Bauen braucht: getöntes Theme, Tokens, Autofit-Stufe, Format, Komposition.
#[derive(Clone)]
pub struct Cx<'a> {
    pub deck: &'a Deck,
    pub index: usize,
    /// Theme im Folien-Ton (withTone)
    pub theme: &'a Theme,
    pub tk: &'a Tokens,
    pub pal: Pal,
    pub head: usize,
    pub body: usize,
    /// Schriftfaktor des Formats (font_factor)
    pub k: f64,
    pub w: f32,
    pub h: f32,
    pub frame: FrameId,
    pub profile: Profile,
    /// .fmt-tall: Hochformat und Quadrat (w/h ≤ 1,2)
    pub tall: bool,
    /// .fmt-narrow: Breite ≤ 800 px
    pub narrow: bool,
}

/// CSS-Schriftliste einer Schrift samt gebündeltem Ersatz. Zuletzt eine Schrift aus assets/fonts, damit Text auch
/// dann gesetzt wird, wenn eine Katalogschrift nicht beiliegt.
/// ponytail: Arimo, Carlito und Gelasio (legacy-Themes) fehlen in assets/fonts; bis sie beiliegen Plex als Ersatz
pub fn family(f: &FontRef) -> String {
    let mut s = format!("'{}'", f.css);
    if let Some(fb) = &f.fallback {
        s += &format!(", '{fb}'");
    }
    s + if f.serif {
        ", 'IBM Plex Serif'"
    } else {
        ", 'IBM Plex Sans'"
    }
}

impl<'a> Cx<'a> {
    /// Schriftgröße wie .r-* (mit Plakat-Faktor --hs).
    pub fn fs(&self, role: Role) -> f32 {
        self.tk.font_size(role, self.head, self.body, self.k) as f32
    }
    /// --fs-<role> ohne --hs (für calc(var(--fs-…) …) in Layout-CSS).
    pub fn fs_raw(&self, role: Role) -> f32 {
        dw_theme::fs(role, self.head, self.body, self.k) as f32
    }
    /// Gleicher Kontext mit anderen Erbfarben (Farbfläche, Hervorhebung).
    pub fn on(&self, pal: Pal) -> Cx<'a> {
        Cx {
            pal,
            ..self.clone()
        }
    }
    /// Farben auf der Akzentfläche (--fill): onAccent, onAccentSoft.
    pub fn on_fill(&self) -> Cx<'a> {
        let tk = self.tk;
        self.on(Pal {
            text: tk.on_accent,
            muted: tk.on_accent_soft,
            accent: tk.on_accent,
        })
    }
    /// max-width: var(--measure, fallback); None = unbegrenzt.
    pub fn measure(&self, fallback: f32) -> Option<f32> {
        match self.tk.measure {
            None => Some(fallback),
            Some(m) if m.is_finite() => Some(m as f32),
            Some(_) => None,
        }
    }
    pub fn elements(&self) -> Elements {
        self.tk.elements
    }
    /// useWide(): Breitformat für die „few“-Vergrößerungen
    pub fn wide(&self) -> bool {
        self.w / self.h >= 1.6
    }

    /// `<T role slot>` mit den Rollen-Stilen aus slide.css.
    pub fn t(&self, role: Role, slot: impl Into<String>, text: &str) -> TextSpec {
        let tk = self.tk;
        let label = matches!(role, Role::Eyebrow | Role::Footer);
        let sub = tk.sub_body && matches!(role, Role::H2 | Role::H3);
        TextSpec {
            role,
            slot: slot.into(),
            build: None,
            max_lines: None,
            text: text.to_string(),
            family: family(tk.font(role)),
            size: self.fs(role),
            lh: tk.line_height(role, self.head) as f32,
            tracking_em: tk.tracking_em(role, self.head) as f32,
            weight: tk.weight(role) as f32,
            color: if matches!(role, Role::Small | Role::Eyebrow | Role::Footer) {
                self.pal.muted
            } else {
                self.pal.text
            },
            link_color: self.pal.accent,
            center: false,
            nowrap: matches!(role, Role::Hero | Role::Kpi),
            upper: tk.lab_caps && role == Role::Eyebrow,
            face: if label && tk.font_label.is_some() {
                Some("IBM Plex Mono".into())
            } else if sub {
                Some(tk.font_body.pptx.clone())
            } else {
                None
            },
            unit: false,
        }
    }
}

// ---------- Stil-Helfer ----------

pub fn px(v: f32) -> LengthPercentage {
    LengthPercentage::length(v)
}
pub fn pxa(v: f32) -> LengthPercentageAuto {
    LengthPercentageAuto::length(v)
}
pub fn auto_lp() -> LengthPercentageAuto {
    LengthPercentageAuto::auto()
}

fn flex(dir: FlexDirection, gap: f32) -> Style {
    Style {
        display: Display::Flex,
        flex_direction: dir,
        gap: Size {
            width: px(gap),
            height: px(gap),
        },
        ..Style::DEFAULT
    }
}
/// display: flex; flex-direction: column; gap
pub fn col(gap: f32) -> Style {
    flex(FlexDirection::Column, gap)
}
/// display: flex; gap
pub fn row(gap: f32) -> Style {
    flex(FlexDirection::Row, gap)
}
/// display: grid mit gap
pub fn grid(gap: f32) -> Style {
    Style {
        display: Display::Grid,
        gap: Size {
            width: px(gap),
            height: px(gap),
        },
        ..Style::DEFAULT
    }
}

/// position: absolute mit left/right/top/bottom (None = auto)
pub fn abs(l: Option<f32>, r: Option<f32>, t: Option<f32>, b: Option<f32>) -> Style {
    let a = |v: Option<f32>| v.map_or(auto_lp(), pxa);
    Style {
        position: Position::Absolute,
        inset: Rect {
            left: a(l),
            right: a(r),
            top: a(t),
            bottom: a(b),
        },
        ..Style::DEFAULT
    }
}

/// Kurzschreibweisen für CSS-Eigenschaften.
pub trait StyleExt {
    fn grow(self) -> Self; // flex: 1
    fn none(self) -> Self; // flex: none
    fn min_h0(self) -> Self;
    fn min_w0(self) -> Self;
    fn max_w(self, w: f32) -> Self;
    /// max-width: var(--measure) aus Cx::measure (None = keine Grenze)
    fn max_wo(self, w: Option<f32>) -> Self;
    fn wh(self, w: f32, h: f32) -> Self;
    fn h(self, h: f32) -> Self;
    fn pad(self, t: f32, r: f32, b: f32, l: f32) -> Self;
    fn margin(self, t: f32, r: f32, b: f32, l: f32) -> Self;
    fn mt(self, v: f32) -> Self;
    fn mb(self, v: f32) -> Self;
    fn rel(self) -> Self; // position: relative
    fn rel_top(self, v: f32) -> Self;
    fn justify(self, j: JustifyContent) -> Self;
    fn items(self, a: AlignItems) -> Self;
}

impl StyleExt for Style {
    fn grow(mut self) -> Self {
        self.flex_grow = 1.;
        self.flex_shrink = 1.;
        self.flex_basis = Dimension::percent(0.);
        self
    }
    fn none(mut self) -> Self {
        self.flex_grow = 0.;
        self.flex_shrink = 0.;
        self
    }
    fn min_h0(mut self) -> Self {
        self.min_size.height = pxa(0.);
        self
    }
    fn min_w0(mut self) -> Self {
        self.min_size.width = pxa(0.);
        self
    }
    fn max_w(mut self, w: f32) -> Self {
        self.max_size.width = pxa(w);
        self
    }
    fn max_wo(mut self, w: Option<f32>) -> Self {
        self.max_size.width = w.map_or(auto_lp(), pxa);
        self
    }
    fn wh(mut self, w: f32, h: f32) -> Self {
        self.size = Size {
            width: Dimension::length(w),
            height: Dimension::length(h),
        };
        self
    }
    fn h(mut self, h: f32) -> Self {
        self.size.height = Dimension::length(h);
        self
    }
    fn pad(mut self, t: f32, r: f32, b: f32, l: f32) -> Self {
        self.padding = Rect {
            top: px(t),
            right: px(r),
            bottom: px(b),
            left: px(l),
        };
        self
    }
    fn margin(mut self, t: f32, r: f32, b: f32, l: f32) -> Self {
        self.margin = Rect {
            top: pxa(t),
            right: pxa(r),
            bottom: pxa(b),
            left: pxa(l),
        };
        self
    }
    fn mt(mut self, v: f32) -> Self {
        self.margin.top = pxa(v);
        self
    }
    fn mb(mut self, v: f32) -> Self {
        self.margin.bottom = pxa(v);
        self
    }
    fn rel(mut self) -> Self {
        self.position = Position::Relative;
        self
    }
    fn rel_top(mut self, v: f32) -> Self {
        self.position = Position::Relative;
        self.inset.top = pxa(v);
        self
    }
    fn justify(mut self, j: JustifyContent) -> Self {
        self.justify_content = j;
        self
    }
    fn items(mut self, a: AlignItems) -> Self {
        self.align_items = a;
        self
    }
}

// ---------- Inhalt lesen ----------

/// Text eines Felds; leer zählt wie fehlend (JS: `c.subtitle && …`).
pub fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}
/// Pflichtfeld
pub fn req<'a>(v: &'a Value, k: &str) -> Result<&'a str, Error> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Content(format!("Feld {k} fehlt")))
}
pub fn strs(v: &Value, k: &str) -> Vec<String> {
    v.get(k)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}
pub fn arr<'a>(v: &'a Value, k: &str) -> Vec<&'a Value> {
    v.get(k)
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}
/// längstes Wort (UTF-16 wie JS .length), getrennt an Leerraum und Bindestrich
pub fn longest_word(texts: &[&str]) -> usize {
    texts
        .iter()
        .flat_map(|t| t.split(|ch: char| ch.is_whitespace() || ch == '-'))
        .map(|w| w.encode_utf16().count())
        .max()
        .unwrap_or(0)
}

// ---------- Elemente ----------

/// `.t`: min-width 0
pub fn t(spec: TextSpec) -> Div {
    Div::text(spec, Style::DEFAULT.min_w0())
}
pub fn t_styled(spec: TextSpec, style: Style) -> Div {
    Div::text(spec, style.min_w0())
}

/// Linie statt ::before (left 0, right 0, top 0): landet im Hintergrundbild.
pub fn top_line(height: f32, c: Rgb) -> Div {
    Div::new(abs(Some(0.), Some(0.), Some(0.), None).h(height)).paint(c)
}

/// data-pptx="box" ohne Rundung
pub fn bx(slot: impl Into<String>, build: Option<u32>, fill: Option<Rgb>) -> BoxSpec {
    BoxSpec {
        slot: slot.into(),
        build,
        fill,
        radius: 0.,
        ellipse: false,
        gradient: None,
        border: None,
        shadow: None,
    }
}

/// Icon (lucide, alle Icons aus assets/lucide.txt; unbekannt = Sparkles) in Größe `size`, Strich 1,75 wie Icon.
pub fn icon(slot: String, build: Option<u32>, name: &str, color: Rgb, size: f32) -> Div {
    Div {
        kind: Kind::Icon {
            slot,
            build,
            name: name.to_string(),
            color,
            stroke: 1.75,
        },
        ..Div::new(Style::DEFAULT.none().wh(size, size))
    }
}

/// Bild-Vorgabe: cover, mittig, ohne Radius (Felder danach anpassen).
pub fn img_spec(slot: &str, src: &str) -> ImgSpec {
    ImgSpec {
        slot: slot.to_string(),
        src: src.to_string(),
        build: None,
        fit: ImgFit::Cover,
        focus: (0.5, 0.5),
        radius: 0.,
        round: false,
        under: false,
        look: None,
        alpha: None,
    }
}

/// Bild aus einer Vorgabe
pub fn image(spec: ImgSpec, style: Style) -> Div {
    Div {
        kind: Kind::Img(Box::new(spec)),
        ..Div::new(style)
    }
}

/// Logo bzw. Bild als CSS-Hintergrund (contain = Logo), `pos` = background-position 0..1
/// (.cover-logo links mittig (0, 0.5), .footer-logo rechts mittig (1, 0.5), Schluss rechts unten (1, 1)).
pub fn img(slot: &str, src: &str, contain: bool, pos: (f64, f64), style: Style) -> Div {
    image(
        ImgSpec {
            fit: if contain {
                ImgFit::Contain
            } else {
                ImgFit::Cover
            },
            focus: pos,
            ..img_spec(slot, src)
        },
        style,
    )
}

/// Foto eines Layouts: Fokus (Slide-Inhalt `{src, focus, look}` oder String) und Bildstil des Themes (theme.images).
pub fn photo(cx: &Cx, slot: &str, v: &Value, style: Style) -> Option<Div> {
    let (src, focus, look) = match v {
        Value::String(s) => (s.as_str(), None, None),
        Value::Object(_) => (
            v.get("src")?.as_str()?,
            v.get("focus"),
            v.get("look").and_then(Value::as_str),
        ),
        _ => return None,
    };
    if src.is_empty() {
        return None;
    }
    let focus = match focus {
        Some(Value::String(f)) => match f.as_str() {
            "top" => (0.5, 0.25),
            "bottom" => (0.5, 0.8),
            "left" => (0.2, 0.5),
            "right" => (0.8, 0.5),
            _ => (0.5, 0.5),
        },
        Some(o @ Value::Object(_)) => (
            o.get("x").and_then(Value::as_f64).unwrap_or(0.5),
            o.get("y").and_then(Value::as_f64).unwrap_or(0.5),
        ),
        _ => (0.5, 0.5),
    };
    let look = look
        .map(str::to_string)
        .or(cx.theme.images.map(|i| i.as_str().to_string()))
        .filter(|l| l != "natural");
    Some(image(
        ImgSpec {
            focus,
            look,
            ..img_spec(slot, src)
        },
        style,
    ))
}

/// Verlauf über einem Foto (Backdrop-Scrim, slide.tsx SCRIM): left, bottom, full; Box `_scrim` mit Gradient.
pub fn scrim(cx: &Cx, kind: &str) -> Option<Div> {
    let d = dw_color::mix(Rgb::BLACK, cx.theme.c.accent, 0.12).to_hex();
    let stops: &[(f64, f64)] = match kind {
        "left" => &[(0., 0.9), (0.5, 0.8), (0.8, 0.62), (0.9, 0.4), (1., 0.15)],
        "bottom" => &[(0., 0.9), (0.5, 0.8), (0.78, 0.66), (0.92, 0.3), (1., 0.1)],
        "full" => &[(0., 0.7), (1., 0.7)],
        _ => return None,
    };
    let gradient = dw_model::Gradient {
        angle: if kind == "left" { 90. } else { 0. },
        stops: stops
            .iter()
            .map(|&(pos, alpha)| dw_model::GradientStop {
                color: d.clone(),
                alpha,
                pos,
            })
            .collect(),
    };
    Some(
        Div::new(abs(Some(0.), Some(0.), Some(0.), Some(0.))).boxel(BoxSpec {
            gradient: Some(gradient),
            ..bx("_scrim", None, None)
        }),
    )
}

/// Erbfarben auf einem Foto (onPhoto): weiß, Akzent aufgehellt.
pub fn on_photo<'a>(cx: &Cx<'a>) -> Cx<'a> {
    cx.on(Pal {
        text: Rgb::WHITE,
        muted: Rgb::parse("#E9E9E9").expect("Farbe"),
        accent: dw_color::mix(Rgb::WHITE, cx.theme.c.accent, 0.3),
    })
}

// ---------- Karten, Spalten, Medien ----------

/// Innenabstände einer Karte je `elements` (oben, rechts, unten, links) und optional ein Schatten.
#[derive(Debug, Clone)]
pub struct CardStyle {
    pub solid: [f32; 4],
    pub line: [f32; 4],
    pub plain: [f32; 4],
    pub gap: f32,
    pub shadow: Option<BoxShadow>,
}

impl Default for CardStyle {
    /// .card (32 px) bzw. .el-line (28 0 4) / .el-plain (0 0 4)
    fn default() -> Self {
        CardStyle {
            solid: [32.; 4],
            line: [28., 0., 4., 0.],
            plain: [0., 0., 4., 0.],
            gap: 14.,
            shadow: None,
        }
    }
}

/// Kontext für den Karteninhalt: hervorgehobene Karte in solid steht auf der Akzentfläche.
pub fn card_cx<'a>(cx: &Cx<'a>, hl: bool) -> Cx<'a> {
    if hl && cx.elements() == Elements::Solid {
        cx.on_fill()
    } else {
        cx.clone()
    }
}

/// Karte (.card, data-fit) je Theme-Hebel: solid = Fläche surface (hl: fill) mit Radius, line = 1-px-Kopflinie in
/// Textfarbe (hl: 2 px Akzent), plain = nur Abstand. Inhalt mit `card_cx` bauen.
pub fn card(
    cx: &Cx,
    slot: String,
    build: Option<u32>,
    hl: bool,
    st: &CardStyle,
    kids: Vec<Div>,
) -> Div {
    let tk = cx.tk;
    let el = cx.elements();
    let (pad, fill) = match el {
        Elements::Solid => (st.solid, Some(if hl { tk.fill } else { tk.surface })),
        Elements::Line => (st.line, None),
        Elements::Plain => (st.plain, None),
    };
    let line = match el {
        Elements::Line if hl => Some(top_line(2., cx.pal.accent)),
        Elements::Line => Some(top_line(1., cx.pal.text)),
        _ => None,
    };
    let style = col(st.gap)
        .pad(pad[0], pad[1], pad[2], pad[3])
        .min_w0()
        .min_h0()
        .rel();
    Div::new(style)
        .kids(line.into_iter().chain(kids))
        .boxel(BoxSpec {
            radius: if fill.is_some() { tk.radius as f32 } else { 0. },
            shadow: st.shadow.clone(),
            ..bx(slot.clone(), build, fill)
        })
        .fit(&slot)
        .clip()
}

/// Wie ein Raster in den Formaten umbricht (Block „Formate“ in slide.css).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stack {
    /// bleibt nebeneinander
    Keep,
    /// .fmt-narrow: eine Spalte (agenda, cols, chart-wrap.with-take, kpis, team, logos, tl, opt …)
    Narrow,
    /// zusätzlich .fmt-tall: eine Spalte (Zeitstrahl)
    Tall,
    /// .fmt-tall: Kennzahlen zu zweit, 2–3 untereinander; .fmt-narrow: eine Spalte
    Kpis,
}

/// Spaltenzahl eines Rasters mit `n` Spalten im aktuellen Format.
pub fn columns(cx: &Cx, n: usize, stack: Stack) -> usize {
    match stack {
        Stack::Keep => n,
        _ if cx.narrow => 1,
        Stack::Tall if cx.tall => 1,
        Stack::Kpis if cx.tall && n > 1 => {
            if n <= 3 {
                1
            } else {
                2
            }
        }
        _ => n,
    }
}

/// Raster mit Spaltenanteilen `fr` (minmax(0, k fr)); bricht das Format um, gleich breite Spalten.
pub fn grid_cols(cx: &Cx, fr_: &[f32], gap: f32, stack: Stack) -> Style {
    let k = columns(cx, fr_.len(), stack);
    let cols = if k == fr_.len() {
        fr_.iter().map(|&f| minmax(length(0.), fr(f))).collect()
    } else {
        vec![minmax(length(0.), fr(1.)); k]
    };
    Style {
        grid_template_columns: cols,
        ..grid(gap)
    }
}

/// Lage eines randabfallenden Fotos (.media, slide.css „image + text“ und „Bild neben Text“).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaSide {
    /// .media: links 600 px, Satzspiegel rechts (.safe-right)
    Left,
    /// .media.right: rechts 600 px, Satzspiegel links (.safe-left)
    Right,
    /// .side-media: rechts 7/12, Text in schmaler Spalte links (.side-safe)
    Side,
}

fn side_w(cx: &Cx) -> f32 {
    (cx.w * 0.58333).min(cx.w - 448. - cx.tk.m_l as f32)
}

/// Container des Fotos (Frame.media); im Hochformat oben über die volle Breite, 42 % hoch.
pub fn media(cx: &Cx, side: MediaSide, kids: Vec<Div>) -> Div {
    let st = if cx.tall {
        abs(Some(0.), Some(0.), Some(0.), None).h(cx.h * 0.42)
    } else {
        let mut st = match side {
            MediaSide::Left => abs(Some(0.), None, Some(0.), Some(0.)),
            _ => abs(None, Some(0.), Some(0.), Some(0.)),
        };
        st.size.width = Dimension::length(if side == MediaSide::Side {
            side_w(cx)
        } else {
            600.
        });
        st
    };
    Div::new(st).kids(kids).clip()
}

/// Satzspiegel neben dem Foto (Body.safe): .safe-right/.safe-left/.side-safe, im Hochformat unter dem Foto.
pub fn media_safe(cx: &Cx, side: MediaSide) -> Rect<LengthPercentageAuto> {
    let tk = cx.tk;
    let (ml, mr, mt, mb) = (tk.m_l as f32, tk.m_r as f32, tk.m_t as f32, tk.m_b as f32);
    if cx.tall {
        return Rect {
            left: pxa(ml),
            right: pxa(mr),
            top: pxa(cx.h * 0.42 + 40.),
            bottom: pxa(mb),
        };
    }
    let (left, right) = match side {
        MediaSide::Left => (664., mr),
        MediaSide::Right => (ml, 664.),
        MediaSide::Side => (ml, side_w(cx) + 64.),
    };
    Rect {
        left: pxa(left),
        right: pxa(right),
        top: pxa(mt),
        bottom: pxa(mb),
    }
}

// ---------- Daten ----------

/// isNum (layouts-extra.tsx): Zahl mit optionaler Einheit → rechtsbündig
pub fn is_num(v: &str) -> bool {
    let v = v.trim();
    let mut c = v.chars().peekable();
    if matches!(c.peek(), Some('€' | '$')) {
        c.next();
        if c.peek().is_some_and(|c| c.is_whitespace()) {
            c.next();
        }
        return c
            .next()
            .is_some_and(|c| c.is_ascii_digit() || c == '.' || c == ',');
    }
    let body = v.trim_start_matches(['−', '+', '-']);
    let num_end = body
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == ',' || c.is_whitespace()))
        .unwrap_or(body.len());
    let (num, rest) = body.split_at(num_end);
    if !num
        .chars()
        .any(|c| c.is_ascii_digit() || c == '.' || c == ',')
        && num.trim().is_empty()
    {
        return false;
    }
    let rest = rest.trim_end().trim_end_matches('€').trim_end();
    let unit_ok = |u: &str| {
        let u = u.trim_start();
        u.is_empty()
            || [
                "%", "€", "Mio", "Mrd", "Pkt", "Pkt.", "Tsd", "Tsd.", "k", "M", "€k", "€M",
            ]
            .contains(&u.replace(char::is_whitespace, "").as_str())
    };
    !num.is_empty() && unit_ok(rest)
}

/// Tabelle (.free-table): Kopfzeile fett, Zahlenspalten rechts, Textschrift in `size` px.
pub fn table(
    cx: &Cx,
    slot: &str,
    build: Option<u32>,
    cells: Vec<Vec<String>>,
    size: f32,
    style: Style,
) -> Div {
    let n = cells.iter().map(Vec::len).max().unwrap_or(0);
    let body: Vec<&Vec<String>> = cells.iter().skip(1).collect();
    let align = (0..n)
        .map(|i| {
            let col = || body.iter().filter_map(|r| r.get(i)).map(String::as_str);
            if col().any(|v| !v.trim().is_empty())
                && col().all(|v| v.trim().is_empty() || is_num(v))
            {
                Align::Right
            } else {
                Align::Left
            }
        })
        .collect();
    let tk = cx.tk;
    Div {
        kind: Kind::Table(Box::new(TableSpec {
            slot: slot.to_string(),
            build,
            cells,
            size,
            family: family(&tk.font_body),
            head_font: false,
            face: None,
            color: cx.pal.text,
            line: tk.border,
            align,
        })),
        ..Div::new(style)
    }
}

/// Diagramm (ChartBox): Spezifikation aus dem Inhalt, gezeichnet von chart::draw.
pub fn chart(
    cx: &Cx,
    slot: &str,
    build: Option<u32>,
    spec: &Value,
    style: Style,
) -> Result<Div, Error> {
    let spec =
        serde_json::from_value(spec.clone()).map_err(|e| Error::Content(format!("{slot}: {e}")))?;
    Ok(Div {
        kind: Kind::Chart(Box::new(ChartBox {
            slot: slot.to_string(),
            build,
            spec,
            theme: cx.theme.clone(),
        })),
        ..Div::new(style)
    })
}

/// Kennzahl (.kpi-value): Rolle kpi in Akzent, Einheit klein (unit).
pub fn kpi_value(cx: &Cx, slot: impl Into<String>, text: &str, build: Option<u32>) -> TextSpec {
    let mut s = cx.t(Role::Kpi, slot, text);
    s.unit = true;
    s.build = build;
    s.color = cx.pal.accent;
    s
}

/// Veränderung einer Kennzahl (.kpi-delta): Pfeil bei +/−, Text klein fett in good/bad/muted.
pub fn kpi_delta(
    cx: &Cx,
    i: usize,
    delta: &str,
    sentiment: Option<&str>,
    build: Option<u32>,
) -> Div {
    let tk = cx.tk;
    let c = match sentiment {
        Some("positive") => tk.good,
        Some("negative") => tk.bad,
        _ => cx.pal.muted,
    };
    let d = delta.trim();
    let arrow = if d.starts_with(['−', '-']) {
        Some("arrow-down-right")
    } else if d.starts_with('+') {
        Some("arrow-up-right")
    } else {
        None
    };
    let mut spec = cx.t(Role::Small, format!("kpis.{i}.delta"), delta);
    spec.build = build;
    spec.color = c;
    spec.weight = 700.;
    let kids = arrow
        .map(|a| icon(format!("_arrow.{i}"), build, a, c, 18.))
        .into_iter()
        .chain([t(spec)]);
    Div::new(row(6.).items(AlignItems::CENTER).mt(4.)).kids(kids)
}

/// Großes Anführungszeichen des Zitats (.quote-mark): 190 px, Akzent, oben abgeschnitten auf 104 px.
pub fn quote_mark(cx: &Cx) -> Div {
    let mut s = cx.t(Role::Display, "_mark", "\u{201C}");
    s.size = 190.;
    s.lh = 0.82;
    s.color = cx.pal.accent;
    s.nowrap = true;
    t_styled(s, Style::DEFAULT.h(104.)).clip()
}

/// Zeile unter dem Zitat (.quote-by): Autor fett, Rolle klein.
pub fn quote_by(cx: &Cx, author: &str, role: Option<&str>, build: Option<u32>) -> Div {
    let mut a = cx.t(Role::Label, "author", author);
    a.weight = 700.;
    a.build = build;
    let r = role.map(|r| {
        let mut s = cx.t(Role::Small, "role", r);
        s.build = build;
        t(s)
    });
    Div::new(col(4.)).kids([t(a)].into_iter().chain(r))
}

/// Logo-Kachel (.lg-tile): 110 px hoch, Logo contain mittig; solid = Fläche, line = Kopflinie, plain = frei.
pub fn logo_tile(cx: &Cx, i: usize, src: &str, build: Option<u32>) -> Div {
    let tk = cx.tk;
    let el = cx.elements();
    let mut d = Div::new(
        row(0.)
            .items(AlignItems::CENTER)
            .justify(JustifyContent::CENTER)
            .h(110.)
            .pad(20., 24., 20., 24.)
            .min_w0()
            .rel(),
    );
    if el == Elements::Solid {
        d = d.boxel(BoxSpec {
            radius: tk.radius as f32,
            ..bx(format!("_tile.{i}"), build, Some(tk.surface))
        });
    }
    let line = (el == Elements::Line).then(|| top_line(1., cx.pal.text));
    let mut logo = img(
        &format!("logos.{i}"),
        src,
        true,
        (0.5, 0.5),
        Style::DEFAULT.grow(),
    );
    logo.style.size.height = Dimension::percent(1.);
    d.kids(line.into_iter().chain([logo]))
}

/// Icon in Kachel (40 × 40, Box `_ib.i`) oder frei in der Zeile (`tile = false`), Strich in `color`.
pub fn icon_mark(
    name: &str,
    i: usize,
    build: Option<u32>,
    color: Rgb,
    size: f32,
    tile: bool,
) -> Div {
    let ic = icon(format!("_icon.{i}"), build, name, color, size);
    if !tile {
        return ic;
    }
    Div::new(
        row(0.)
            .items(AlignItems::CENTER)
            .justify(JustifyContent::CENTER)
            .none()
            .wh(40., 40.),
    )
    .boxel(bx(format!("_ib.{i}"), build, None))
    .kids([ic])
}

/// Eyebrow (Überzeile)
pub fn eyebrow(cx: &Cx, text: Option<&str>, center: bool) -> Option<Div> {
    let text = text?;
    let mut st = row(12.).items(AlignItems::CENTER);
    if center {
        st.justify_content = JustifyContent::CENTER;
    }
    let mut spec = cx.t(Role::Eyebrow, "eyebrow", text);
    spec.center = center;
    Some(Div::new(st).kids([t(spec)]))
}

/// Header: Überzeile + Titel (h1) je Komposition und Theme-Linie (.hdr in slide.css).
pub fn header(cx: &Cx, c: &Value, max_lines: u32) -> Result<Div, Error> {
    let tk = cx.tk;
    let split = cx.frame == FrameId::Split;
    let max_lines = if split { 6 } else { max_lines }; // schmale Titelspalte
    let mut st = col(14.).none().mb(40.).max_wo(cx.measure(1000.));
    // Breite der Kinder (rule-under, band): max-width auf Überzeile und Titel
    let mut kid_w = None;
    let mut cxh = cx.clone();
    let mut fill = None;
    match cx.frame {
        FrameId::Top if tk.rule == Some(dw_theme::Rule::Under) => {
            st = st.max_wo(None).pad(0., 0., 20., 0.).mb(20.);
            st.border.bottom = px(1.);
            kid_w = cx.measure(1000.);
        }
        FrameId::Split if !cx.tall => {
            st = abs(Some(0.), None, Some(0.), Some(0.));
            st.display = Display::Flex;
            st.flex_direction = FlexDirection::Column;
            st.gap = Size {
                width: px(20.),
                height: px(20.),
            };
            st.size.width = Dimension::length(492.);
            st = st.pad(60., 48., 72., 72.).justify(JustifyContent::CENTER);
            fill = Some(tk.fill);
        }
        FrameId::Split => {
            let (ml, mr) = (tk.m_l as f32, tk.m_r as f32);
            st = col(14.)
                .none()
                .margin(0., -mr, 28., -ml)
                .pad(56., mr, 36., ml);
            fill = Some(tk.fill);
        }
        FrameId::Band => {
            let (ml, mr) = (tk.m_l as f32, tk.m_r as f32);
            st = col(14.)
                .none()
                .margin(0., -mr, 28., -ml)
                .pad(48., mr, 32., ml);
            kid_w = cx.measure(1060.);
            fill = Some(tk.fill);
        }
        FrameId::Center => {
            st.align_self = Some(AlignSelf::CENTER);
            st.align_items = AlignItems::CENTER;
        }
        FrameId::Top => {}
    }
    if fill.is_some() {
        cxh = cx.on_fill();
    }
    if cx.tall {
        st = st.max_wo(None);
        kid_w = None;
    }
    let center = cx.frame == FrameId::Center;
    let mut title = cxh.t(Role::H1, "title", req(c, "title")?);
    title.max_lines = Some(max_lines);
    title.center = center;
    let mut kids = Vec::new();
    if let Some(mut e) = eyebrow(&cxh, s(c, "eyebrow"), center) {
        e.style = e.style.max_wo(kid_w);
        kids.push(e);
    }
    kids.push(t_styled(title, Style::DEFAULT.max_wo(kid_w)));
    let mut d = Div::new(st).kids(kids);
    d.hdr = true;
    if let Some(f) = fill {
        d = d.paint(f);
    }
    if cx.frame == FrameId::Top && tk.rule == Some(dw_theme::Rule::Under) {
        d.border = Some(tk.border);
    }
    Ok(d)
}

/// Points (Spalten, Bild+Text): Strich/Punkt je `elements`, Text in Body (× `kb`).
pub fn points(
    cx: &Cx,
    items: &[String],
    base: &str,
    build: Option<u32>,
    kb: f32,
    gap: f32,
    dot: Rgb,
) -> Option<Div> {
    if items.is_empty() {
        return None;
    }
    let body = cx.fs_raw(Role::Body);
    let rows = items.iter().enumerate().map(|(j, p)| {
        let mut spec = cx.t(Role::Body, format!("{base}.{j}"), p);
        spec.build = build;
        spec.size = cx.fs(Role::Body) * kb;
        let text = t_styled(spec, Style::DEFAULT.grow());
        let mt = body * kb * 0.69 - 4.;
        let mark = match cx.elements() {
            Elements::Plain => None,
            Elements::Line => Some(
                Div::new(Style::DEFAULT.none().wh(14., 2.).mt(mt).rel_top(3.)).boxel(bx(
                    format!("_pd.{base}.{j}"),
                    build,
                    Some(dot),
                )),
            ),
            Elements::Solid => Some(Div::new(Style::DEFAULT.none().wh(8., 8.).mt(mt)).boxel(
                BoxSpec {
                    ellipse: true,
                    radius: 4.,
                    ..bx(format!("_pd.{base}.{j}"), build, Some(dot))
                },
            )),
        };
        Div::new(row(14.).items(AlignItems::FLEX_START)).kids(mark.into_iter().chain([text]))
    });
    Some(Div::new(col(gap)).kids(rows))
}

// ---------- Rahmen ----------

/// Was ein Layout an den Rahmen gibt: Inhalt des Satzspiegels, randabfallende Medien, eigener Satzspiegel.
pub struct Body {
    pub content: Vec<Div>,
    /// liegt unter dem Satzspiegel (Frame.media), Folienkoordinaten
    pub media: Vec<Div>,
    /// eigene Lage des Satzspiegels und der Fußzeile (safe-left/-right), nur bei Komposition top
    pub safe: Option<Rect<LengthPercentageAuto>>,
}

impl From<Vec<Div>> for Body {
    fn from(content: Vec<Div>) -> Body {
        Body {
            content,
            media: Vec::new(),
            safe: None,
        }
    }
}

/// Folien, die absichtlich luftig sind, haben keine Fußzeile (lint.ts AIRY)
pub const AIRY: &[&str] = &[
    "cover",
    "section",
    "statement",
    "big-number",
    "photo",
    "quote",
    "closing",
    "blank",
    "clip",
];

/// Frame (slide.tsx): Hintergrund (Farbe/Bild/Dekor), Signatur, Medien, Satzspiegel (.safe, data-fit), Fußzeile.
pub fn frame(cx: &Cx, layout: &str, footer: bool, hero: bool, body: Body) -> Div {
    let (tk, th, deck) = (cx.tk, cx.theme, cx.deck);
    let slide = &deck.slides[cx.index];
    let (w, h) = (cx.w, cx.h);
    let bg = slide.bg.as_ref();
    let bg_image = bg.and_then(|b| b.get("image")).and_then(Value::as_str);
    let sig = th.signature.as_ref().filter(|s| s.kind != SigKind::None);
    let frame_line = sig.is_some_and(|s| s.kind == SigKind::Passepartout)
        && !matches!(cx.frame, FrameId::Split | FrameId::Band)
        && body.media.is_empty()
        && bg_image.is_none();
    let m_foot = if sig.is_some_and(|s| s.kind == SigKind::Passepartout) && !frame_line {
        margins_of(th.margin, w as f64, h as f64).foot
    } else {
        tk.m_foot
    } as f32;
    let (ml, mr, mt, mb) = (tk.m_l as f32, tk.m_r as f32, tk.m_t as f32, tk.m_b as f32);

    let mut root = Div::new(
        Style {
            display: Display::Block,
            position: Position::Relative,
            ..Style::DEFAULT
        }
        .wh(w, h),
    )
    .clip();
    // Hintergrund: Farbe/Verlauf der Folie, sonst Theme-Grund (Scene.background); Foto statt Dekor
    root.pre = decor::background(cx, bg);
    let mut kids = Vec::new();
    if let Some(src) = bg_image {
        kids.push(image(
            ImgSpec {
                under: true,
                ..img_spec("_bg", src)
            },
            abs(Some(0.), Some(0.), Some(0.), Some(0.)),
        ));
    } else {
        let id = slide
            .extra
            .get("decor")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or(th.decor);
        root.pre.extend(decor::motif(cx, id, hero));
    }
    if let Some(s) = sig.filter(|s| s.kind == SigKind::Edge || frame_line) {
        root.pre.extend(decor::signature(cx, s));
    }
    kids.extend(body.media);

    // Satzspiegel je Komposition (slide.css .safe, .fr-*)
    let mut st = col(0.);
    st.position = Position::Absolute;
    st.inset = Rect {
        left: pxa(ml),
        right: pxa(mr),
        top: pxa(mt),
        bottom: pxa(mb),
    };
    let (mut fl, mut fr) = (pxa(ml), pxa(mr));
    match (cx.frame, cx.tall) {
        (FrameId::Split, false) => {
            st.inset = Rect {
                left: pxa(0.),
                right: pxa(72.),
                top: pxa(0.),
                bottom: pxa(0.),
            };
            st = st.pad(60., 0., 72., 560.);
            (fl, fr) = (pxa(560.), pxa(72.));
        }
        (FrameId::Split, true) => {
            // .fmt-tall.fr-split .safe setzt left/right/top; bottom: 0 bleibt aus .fr-split .safe (höhere Spezifität als .safe)
            st.inset = Rect {
                left: pxa(0.),
                right: pxa(0.),
                top: pxa(0.),
                bottom: pxa(0.),
            };
            st = st.pad(0., mr, 0., ml);
        }
        (FrameId::Band, _) => {
            st.inset.left = pxa(0.);
            st.inset.right = pxa(0.);
            st.inset.top = pxa(0.);
            st = st.pad(0., mr, 0., ml);
        }
        (_, _) => {
            if let Some(safe) = body.safe {
                st.inset = safe;
                (fl, fr) = (safe.left, safe.right);
            }
        }
    }
    let mut content = body.content;
    let has_hdr = content.first().is_some_and(|d| d.hdr);
    if cx.frame == FrameId::Top && tk.rule == Some(dw_theme::Rule::Over) && has_hdr {
        // Kopflinie über dem Titel: 36 + 2 + 22 = 60, der Titel steht wie ohne Linie
        st.inset.top = pxa(mt - 24.);
        let s = tk.rule_s.unwrap_or(2.) as f32;
        let mut ls = Style::DEFAULT.none().h(s).mb(24. - s);
        if let Some(rw) = tk.rule_w {
            ls.size.width = Dimension::length(rw as f32);
        }
        content.insert(0, Div::new(ls).paint(tk.rule_c.unwrap_or(tk.text)));
    }
    kids.push(Div::new(st).kids(content).fit("_slide").clip());

    if let Some(f) = footer_div(cx, layout, footer, fl, fr, m_foot) {
        kids.push(f);
    }
    root.kids(kids)
}

/// Fußzeile nur als Navigation: Kapitel links, „3 / 12“ rechts; A4 mit Decktitel, Seite und Logo auf Seite 1.
fn footer_div(
    cx: &Cx,
    layout: &str,
    def_footer: bool,
    left_x: LengthPercentageAuto,
    right_x: LengthPercentageAuto,
    m_foot: f32,
) -> Option<Div> {
    let deck = cx.deck;
    let i = cx.index;
    let doc = cx.profile == Profile::Doc;
    let nav = !doc && deck.extra.get("style").and_then(Value::as_str) != Some("mutig");
    let left = if doc {
        Some(deck.title.clone())
    } else if nav {
        deck.slides[..i]
            .iter()
            .rev()
            .find(|s| s.layout == "section")
            .and_then(|s| s.content.get("title")?.as_str().map(str::to_string))
    } else {
        None
    };
    let page = if doc {
        Some((i + 1).to_string())
    } else if nav {
        Some(format!("{} / {}", i + 1, deck.slides.len()))
    } else {
        None
    };
    // Logo nie als Wasserzeichen: bei A4 wie ein Briefkopf nur auf Seite 1
    let logo = cx.theme.logo.as_deref().filter(|_| doc && i == 0);
    if !def_footer
        || (!doc && AIRY.contains(&layout))
        || (left.is_none() && page.is_none() && logo.is_none())
    {
        return None;
    }
    let social = cx.profile == Profile::Social;
    let mut st = row(24.)
        .justify(JustifyContent::SPACE_BETWEEN)
        .items(AlignItems::CENTER);
    if !social {
        st = st.h(22.);
    }
    st.position = Position::Absolute;
    st.inset = Rect {
        left: left_x,
        right: right_x,
        top: auto_lp(),
        bottom: pxa(if social { 40. } else { m_foot }),
    };
    let foot = |slot: &str, text: &str| {
        let mut spec = cx.t(Role::Footer, slot, text);
        spec.upper = cx.tk.lab_caps;
        spec
    };
    let mut fk = Vec::new();
    if let Some(left) = &left {
        let mut spec = foot("_footer.title", left);
        spec.nowrap = true;
        let mut s = Style::DEFAULT;
        s.max_size.width = LengthPercentageAuto::percent(0.7);
        fk.push(t_styled(spec, s).clip());
    }
    let mut right = row(16.).items(AlignItems::CENTER);
    right.margin.left = auto_lp();
    let mut rk = Vec::new();
    if let Some(src) = logo {
        rk.push(img(
            "_footer.logo",
            src,
            true,
            (1., 0.5),
            Style::DEFAULT.none().wh(90., 20.),
        ));
    }
    if let Some(p) = &page {
        rk.push(t(foot("_footer.page", p)));
    }
    fk.push(Div::new(right).kids(rk));
    Some(Div::new(st).kids(fk))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fonts::FontStore;
    use crate::tree;
    use dw_model::{El, Measured};
    use dw_theme::{Tokens, resolve_theme};
    use serde_json::json;

    /// Baut mit `f` den Inhalt einer Folie (Theme, Größe) und setzt ihn.
    fn lay_with(theme: &str, w: f32, h: f32, f: impl FnOnce(&Cx) -> Body) -> Measured {
        let mut deck =
            crate::samples::deck("bullets", "list", json!({ "title": "T", "items": [] }));
        deck.theme.id = theme.into();
        deck.size = Some(dw_model::Size {
            w: w as f64,
            h: h as f64,
        });
        let th = resolve_theme(&deck.theme, None);
        let tk = Tokens::new(&th, w as f64, h as f64);
        let profile = dw_model::profile_of(deck.size);
        let cx = Cx {
            deck: &deck,
            index: 0,
            theme: &th,
            tk: &tk,
            pal: Pal {
                text: tk.text,
                muted: tk.muted,
                accent: tk.accent,
            },
            head: 0,
            body: 0,
            k: dw_theme::font_factor(profile, w as f64),
            w,
            h,
            frame: FrameId::Top,
            profile,
            tall: w / h <= 1.2,
            narrow: w <= 800.,
        };
        let root = frame(&cx, "bullets", false, false, f(&cx));
        let mut fonts = FontStore::from_dir(&FontStore::default_dir()).unwrap();
        let laid = tree::lay(root, &mut fonts, w, h, tk.bg);
        Measured {
            els: laid.els,
            fit: dw_model::Fit {
                ok: laid.overflow.is_empty(),
                head: 0,
                body: 0,
                overflow: laid.overflow,
            },
        }
    }

    fn el<'a>(m: &'a Measured, slot: &str) -> &'a El {
        m.els
            .iter()
            .find(|e| e.base().slot == slot)
            .unwrap_or_else(|| panic!("{slot} fehlt"))
    }

    #[test]
    fn cards_by_elements() {
        let mk = |cx: &Cx| {
            Body::from(vec![
                Div::new(grid_cols(cx, &[1., 1.], 24., Stack::Narrow)).kids([
                    card(
                        cx,
                        "_card.0".into(),
                        Some(0),
                        false,
                        &CardStyle::default(),
                        vec![t(cx.t(Role::H3, "a", "Eins"))],
                    ),
                    card(
                        cx,
                        "_card.1".into(),
                        Some(1),
                        true,
                        &CardStyle::default(),
                        vec![t(card_cx(cx, true).t(Role::H3, "b", "Zwei"))],
                    ),
                ]),
            ])
        };
        // solid (legacy): Fläche, hervorgehoben auf fill
        let m = lay_with("corporate", 1280., 720., mk);
        let El::Box(b) = el(&m, "_card.1") else {
            panic!()
        };
        assert!(b.fill.is_some() && b.radius > 0.);
        let El::Text(tb) = el(&m, "b") else { panic!() };
        assert_eq!(tb.bg, b.fill.as_ref().unwrap().color);
        // line: keine Fläche; nebeneinander
        let m = lay_with("beratung", 1280., 720., mk);
        let (El::Box(a), El::Box(b)) = (el(&m, "_card.0"), el(&m, "_card.1")) else {
            panic!()
        };
        assert!(a.fill.is_none() && (a.base.bbox.y - b.base.bbox.y).abs() < 0.01);
        // fmt-narrow: untereinander
        let m = lay_with("beratung", 720., 1280., mk);
        let (El::Box(a), El::Box(b)) = (el(&m, "_card.0"), el(&m, "_card.1")) else {
            panic!()
        };
        assert!(b.base.bbox.y > a.base.bbox.y && a.base.bbox.x == b.base.bbox.x);
    }

    #[test]
    fn stacking() {
        let m = |w: f32, h: f32, n, s| {
            let mut cols = 0;
            lay_with("beratung", w, h, |cx| {
                cols = columns(cx, n, s);
                vec![].into()
            });
            cols
        };
        assert_eq!(m(1280., 720., 4, Stack::Kpis), 4);
        assert_eq!(m(1080., 1350., 4, Stack::Kpis), 2);
        assert_eq!(m(1080., 1350., 3, Stack::Kpis), 1);
        assert_eq!(m(1080., 1350., 3, Stack::Narrow), 3);
        assert_eq!(m(1080., 1350., 3, Stack::Tall), 1);
        assert_eq!(m(720., 1280., 3, Stack::Keep), 3);
    }

    #[test]
    fn media_and_images() {
        let m = lay_with("beratung", 1280., 720., |cx| Body {
            content: vec![],
            media: vec![
                media(
                    cx,
                    MediaSide::Right,
                    vec![image(
                        img_spec("image", "/x.jpg"),
                        abs(Some(0.), Some(0.), Some(0.), Some(0.)),
                    )],
                ),
                scrim(cx, "left").unwrap(),
            ],
            safe: Some(media_safe(cx, MediaSide::Left)),
        });
        let El::Img(i) = el(&m, "image") else {
            panic!()
        };
        assert_eq!((i.base.bbox.x, i.base.bbox.w), (680., 600.));
        let El::Box(s) = el(&m, "_scrim") else {
            panic!()
        };
        assert_eq!(s.gradient.as_ref().unwrap().stops.len(), 5);
        // Satzspiegel neben bzw. im Hochformat unter dem Foto
        lay_with("beratung", 1080., 1350., |cx| {
            let r = media_safe(cx, MediaSide::Left);
            assert_eq!(r.top, pxa(1350. * 0.42 + 40.));
            vec![].into()
        });
        lay_with("beratung", 1280., 720., |cx| {
            assert_eq!(media_safe(cx, MediaSide::Left).left, pxa(664.));
            assert_eq!(
                media_safe(cx, MediaSide::Side).right,
                pxa(1280. * 0.58333 + 64.)
            );
            vec![].into()
        });
    }

    #[test]
    fn table_chart_kpi_quote_logo_icons() {
        let m = lay_with("beratung", 1280., 720., |cx| {
            let cells = vec![
                vec!["Posten".into(), "2025".into()],
                vec![
                    "Umsatz mit sehr langem Namen, der umbricht".into(),
                    "1.200 €".into(),
                ],
            ];
            Body::from(vec![
                table(cx, "rows", None, cells, 20., Style::DEFAULT.max_w(400.)),
                chart(cx, "chart", None, &json!({ "type": "bar", "categories": ["A", "B"], "series": [{ "name": "S", "values": [1, 2] }] }), Style::DEFAULT.h(100.)).unwrap(),
                t(kpi_value(cx, "kpis.0.value", "855 €", Some(0))),
                kpi_delta(cx, 0, "+12 %", Some("positive"), Some(0)),
                quote_mark(cx),
                quote_by(cx, "Erika", Some("CEO"), None),
                logo_tile(cx, 0, "/logo.png", None),
                icon_mark("rocket", 0, None, cx.pal.text, 26., true),
            ])
        });
        let El::Table(tb) = el(&m, "rows") else {
            panic!()
        };
        assert_eq!(tb.col_w, vec![200., 200.]);
        assert_eq!(tb.align, vec![Align::Left, Align::Right]);
        assert!(
            tb.row_h[1] > tb.row_h[0],
            "zweizeilige Zelle: {:?}",
            tb.row_h
        );
        assert!(matches!(el(&m, "chart"), El::Chart(_)));
        let El::Text(k) = el(&m, "kpis.0.value") else {
            panic!()
        };
        assert_eq!(k.runs.len(), 2);
        assert_eq!(k.runs[1].size_px, Some(72. * 0.45));
        assert!(matches!(el(&m, "_arrow.0"), El::Icon(_)));
        let El::Icon(i) = el(&m, "_icon.0") else {
            panic!()
        };
        assert!(i.svg.contains("stroke-width=\"1.75\"") && !i.svg.contains("M20 6 9 17"));
        assert!(matches!(el(&m, "logos.0"), El::Img(i) if i.fit == ImgFit::Contain));
        assert!(matches!(el(&m, "author"), El::Text(t) if t.runs[0].bold));
        let El::Text(q) = el(&m, "_mark") else {
            panic!()
        };
        assert_eq!(q.size_px, 190.);
    }

    #[test]
    fn numbers() {
        for v in ["1.200 €", "+12 %", "−3,5", "€ 12", "42 Mio", "7 Pkt."] {
            assert!(is_num(v), "{v}");
        }
        for v in ["Q3", "Umsatz", "24/7 Support"] {
            assert!(!is_num(v), "{v}");
        }
    }
}
