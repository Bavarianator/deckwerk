//! Textknoten (`<T role slot>`): Markdown-Auszug, Satz mit parley, Zeilen, Runs und Glyphen.

use dw_color::Rgb;
use dw_model::{Align, Glyph, GlyphRun, Run};
use dw_theme::Role;
use parley::{
    Alignment, AlignmentOptions, BreakReason, FontFamily, FontWeight, Layout, LineHeight,
    PositionedLayoutItem, StyleProperty, TextWrapMode, WhiteSpaceCollapse,
};
use taffy::{AvailableSpace, Size};

use crate::fonts::FontStore;
use crate::wrap::{self, Cand};

fn r3(v: f32) -> f64 {
    (v as f64 * 1000.).round() / 1000.
}

pub(crate) fn hex(c: Rgb) -> String {
    format!("#{:02X}{:02X}{:02X}", c.r, c.g, c.b)
}

fn pack(c: Rgb) -> u32 {
    u32::from_be_bytes([c.r, c.g, c.b, c.a])
}

pub(crate) fn unpack(v: u32) -> dw_model::Color {
    let [r, g, b, a] = v.to_be_bytes();
    dw_model::Color { r, g, b, a }
}

/// Teilstück aus `rich()` (slide.tsx:38): **fett** und [Text](https://…).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Span {
    pub text: String,
    pub bold: bool,
    pub link: Option<String>,
    /// Einheit einer Kennzahl (.unit)
    pub unit: bool,
}

/// Kennzahl → [Einheit vorn, Zahl, Einheit hinten] wie splitUnit (layouts.tsx), z. B. „855 €“ → ["", "855", " €"].
/// Nur mit Zahl vorn und ohne Ziffern in der Einheit; sonst None.
pub fn split_unit(v: &str) -> Option<(&str, &str, &str)> {
    let b = v.as_bytes();
    let ch = |i: usize| v[i..].chars().next();
    let ws = |c: Option<char>| c.is_some_and(char::is_whitespace);
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    let digits = |mut i: usize| {
        while digit(i) {
            i += 1;
        }
        i
    };
    let skip_ws = |i: usize| {
        if ws(ch(i).filter(|_| i < v.len())) {
            i + ch(i).unwrap().len_utf8()
        } else {
            i
        }
    };
    let mut i = 0;
    if let Some(c) = ch(0).filter(|c| "€$£¥".contains(*c)) {
        i = skip_ws(c.len_utf8());
    }
    let pre_end = i;
    if let Some(c) = ch(i).filter(|c| "+-−–±~≈<>".contains(*c)) {
        i = skip_ws(i + c.len_utf8());
    }
    let start_digits = i;
    i = digits(i);
    if i == start_digits {
        return None;
    }
    // Tausendergruppen [.,\s]ddd, dann Nachkommastellen, dann Bereich „30–45“
    while let Some(c) = ch(i).filter(|c| *c == '.' || *c == ',' || c.is_whitespace()) {
        let j = i + c.len_utf8();
        if digits(j) != j + 3 {
            break;
        }
        i = j + 3;
    }
    if matches!(ch(i), Some('.' | ',')) && digit(i + 1) {
        i = digits(i + 1);
    }
    let mut j = skip_ws(i);
    if let Some(c) = ch(j).filter(|c| *c == '–' || *c == '-') {
        j = skip_ws(j + c.len_utf8());
        if digit(j) {
            i = digits(j);
            if matches!(ch(i), Some('.' | ',')) && digit(i + 1) {
                i = digits(i + 1);
            }
        }
    }
    let post = &v[i..];
    if post
        .chars()
        .any(|c| c.is_ascii_digit() || c == '*' || c == '[')
    {
        return None;
    }
    (pre_end > 0 || !post.is_empty()).then(|| (&v[..pre_end], &v[pre_end..i], post))
}

pub(crate) fn rich(src: &str) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    let mut plain = String::new();
    let mut i = 0;
    let flush = |plain: &mut String, out: &mut Vec<Span>| {
        if !plain.is_empty() {
            out.push(Span {
                text: std::mem::take(plain),
                bold: false,
                link: None,
                unit: false,
            });
        }
    };
    while i < src.len() {
        let rest = &src[i..];
        // \*\*.+?\*\*  (. ohne Zeilenumbruch, mindestens ein Zeichen)
        if let Some(body) = rest.strip_prefix("**") {
            let end = body
                .char_indices()
                .skip(1)
                .find(|&(j, _)| body[j..].starts_with("**"))
                .map(|(j, _)| j);
            if let Some(j) = end.filter(|&j| !body[..j].contains('\n')) {
                flush(&mut plain, &mut out);
                out.push(Span {
                    text: body[..j].to_string(),
                    bold: true,
                    link: None,
                    unit: false,
                });
                i += 4 + j;
                continue;
            }
        }
        // \[[^\]]+\]\((?:https?:|mailto:)[^)\s]+\)
        if let Some(body) = rest.strip_prefix('[')
            && let Some(close) = body.find(']').filter(|&c| c > 0)
            && let Some(after) = body[close + 1..].strip_prefix('(')
            && ["http:", "https:", "mailto:"]
                .iter()
                .any(|p| after.starts_with(p))
            && let Some(end) = after.find(|c: char| c == ')' || c.is_whitespace())
            && after[end..].starts_with(')')
        {
            flush(&mut plain, &mut out);
            out.push(Span {
                text: body[..close].to_string(),
                bold: false,
                link: Some(after[..end].to_string()),
                unit: false,
            });
            i += 1 + close + 2 + end + 1;
            continue;
        }
        let ch = rest.chars().next().unwrap();
        plain.push(ch);
        i += ch.len_utf8();
    }
    flush(&mut plain, &mut out);
    out
}

/// Aufgelöster Stil eines Textknotens (Rolle + Klassen des Layouts).
#[derive(Debug, Clone)]
pub(crate) struct TextSpec {
    pub role: Role,
    pub slot: String,
    pub build: Option<u32>,
    pub max_lines: Option<u32>,
    pub text: String,   // Rohtext mit Markdown
    pub family: String, // CSS-Schriftliste („'Inter', 'IBM Plex Sans'“)
    pub size: f32,
    pub lh: f32, // Faktor
    pub tracking_em: f32,
    pub weight: f32,
    pub color: Rgb,
    pub link_color: Rgb,
    pub center: bool,
    pub nowrap: bool,
    /// text-transform: uppercase (lab-caps)
    pub upper: bool,
    /// data-face: PPTX-Schrift abweichend von Titel/Text (Mono-Labels, sub-body)
    pub face: Option<String>,
    /// Kennzahl: Einheit klein (.unit, 0,45 em, ohne Laufweite), siehe split_unit
    pub unit: bool,
}

impl TextSpec {
    pub fn line_height_px(&self) -> f32 {
        self.lh * self.size
    }
    pub fn tracking_px(&self) -> f32 {
        self.tracking_em * self.size
    }
    pub fn head(&self) -> bool {
        self.role.head_font()
    }
    /// text-wrap: pretty (slide.css .r-body, .r-label, .r-small)
    pub fn pretty(&self) -> bool {
        matches!(self.role, Role::Body | Role::Label | Role::Small)
    }
}

pub(crate) struct TextNode {
    pub spec: TextSpec,
    pub plain: String,
    spans: Vec<(std::ops::Range<usize>, Span)>,
    pub layout: Layout<u32>,
    min_w: f32,
    max_w: f32,
}

// Gleitkomma-Reserve: genau die max-content-Breite darf nicht umbrechen
const EPS: f32 = 0.01;

impl TextNode {
    pub fn new(spec: TextSpec, fonts: &mut FontStore) -> TextNode {
        let mut plain = String::new();
        let mut spans = Vec::new();
        let parts = match spec.unit.then(|| split_unit(&spec.text)).flatten() {
            Some((pre, num, post)) => [(pre, true), (num, false), (post, true)]
                .into_iter()
                .filter(|(t, _)| !t.is_empty())
                .map(|(t, unit)| Span {
                    text: t.to_string(),
                    bold: false,
                    link: None,
                    unit,
                })
                .collect(),
            None => rich(&spec.text),
        };
        for mut s in parts {
            if spec.upper {
                s.text = s.text.to_uppercase();
            }
            let start = plain.len();
            plain.push_str(&s.text);
            spans.push((start..plain.len(), s));
        }
        let mut b = fonts.lcx.ranged_builder(&mut fonts.fcx, &plain, 1.0, false); // Zeilen mit exakter line-height wie Chromium
        b.push_default(StyleProperty::FontFamily(FontFamily::Source(
            spec.family.clone().into(),
        )));
        b.push_default(StyleProperty::FontSize(spec.size));
        b.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
            spec.lh,
        )));
        b.push_default(StyleProperty::LetterSpacing(spec.tracking_px()));
        b.push_default(StyleProperty::FontWeight(FontWeight::new(spec.weight)));
        b.push_default(StyleProperty::Brush(pack(spec.color)));
        // white-space: pre-line
        b.push_default(StyleProperty::WhiteSpaceCollapse(
            WhiteSpaceCollapse::PreserveBreaks,
        ));
        if spec.nowrap {
            b.push_default(StyleProperty::TextWrapMode(TextWrapMode::NoWrap));
        }
        for (r, s) in &spans {
            if s.bold {
                b.push(StyleProperty::FontWeight(FontWeight::new(700.)), r.clone());
            }
            if s.link.is_some() {
                b.push(StyleProperty::Brush(pack(spec.link_color)), r.clone());
                b.push(StyleProperty::Underline(true), r.clone());
            }
            if s.unit {
                b.push(StyleProperty::FontSize(spec.size * 0.45), r.clone());
                b.push(StyleProperty::LetterSpacing(0.), r.clone());
            }
        }
        let mut layout = b.build(&plain);
        // .t.hang: „ hängt in den Rand, text-indent: max(-0.4em, -44px); zentriert nicht
        let mut ch = spec.text.chars();
        if spec.head()
            && !spec.center
            && ch.next().is_some_and(|c| "„“‚»«\"".contains(c))
            && ch.next().is_some_and(|c| !c.is_whitespace())
        {
            layout.set_text_indent(-(0.4 * spec.size).min(44.), Default::default());
        }
        let cw = layout.calculate_content_widths();
        layout.break_all_lines(None);
        TextNode {
            spec,
            plain,
            spans,
            layout,
            min_w: cw.min,
            max_w: cw.max,
        }
    }

    fn break_at(&mut self, w: f32) {
        let max = if self.spec.nowrap {
            None
        } else {
            Some(w + EPS)
        };
        self.layout.break_all_lines(max);
        self.layout
            .align(Alignment::Start, AlignmentOptions::default());
    }

    /// taffy-Messfunktion: Breite wie shrink-to-fit, Höhe aus den Zeilen.
    pub fn measure(&mut self, known: Size<Option<f32>>, avail: Size<AvailableSpace>) -> Size<f32> {
        let width = known.width.unwrap_or(match avail.width {
            AvailableSpace::Definite(w) => self.max_w.min(w.max(self.min_w)),
            AvailableSpace::MinContent => self.min_w,
            AvailableSpace::MaxContent => self.max_w,
        });
        self.break_at(width);
        Size {
            width,
            height: known.height.unwrap_or(self.height()),
        }
    }

    /// Endgültiger Umbruch in der Box: greedy, dann Titel mit text-wrap: balance, Fließtext mit pretty (wrap.rs).
    pub fn finish(&mut self, w: f32) {
        self.break_at(w);
        let (head, pretty) = (self.spec.head(), self.spec.pretty());
        if self.spec.nowrap || self.plain.is_empty() || !(head || pretty) {
            return;
        }
        // greedy Zeilen: (Bytebereich, Breite ohne Leerraum am Ende, Absatzende)
        let lines: Vec<(std::ops::Range<usize>, f32, bool)> = self
            .layout
            .lines()
            .map(|l| {
                let r = l.break_reason();
                (
                    l.text_range(),
                    Self::line_width(&l),
                    matches!(r, BreakReason::Explicit | BreakReason::None),
                )
            })
            .collect();
        if lines.iter().any(|l| l.0.is_empty()) {
            return; // Leerzeilen (\n\n): Absatzgrenzen wären unklar
        }
        let indent = self
            .layout
            .lines()
            .next()
            .map_or(0., |l| l.metrics().indent);
        let avail = w;
        // Absätze = Zeilen bis zum harten Umbruch bzw. Textende
        let mut windows = Vec::new(); // (erste Zeile, Zeilen, balanciert)
        let mut a = 0;
        for (i, l) in lines.iter().enumerate() {
            if !l.2 {
                continue;
            }
            let n = i + 1 - a;
            if head && (2..=wrap::MAX_LINES_BALANCE).contains(&n) {
                windows.push((a, n, true));
            } else if pretty && n >= 2 {
                let text = self.plain[l.0.clone()].trim_end();
                let has_break = !breaks(text).is_empty();
                if wrap::should_optimize(l.1, avail, has_break) {
                    let k = n.min(wrap::MAX_LINES_PRETTY);
                    windows.push((i + 1 - k, k, false));
                }
            }
            a = i + 1;
        }
        if windows.is_empty() {
            return;
        }
        // Positionen aus dem ungebrochenen Satz: je Absatz eine Zeile
        self.layout.break_all_lines(None);
        let xs = self.cluster_xs();
        let mut widths: Vec<Option<f32>> = vec![None; lines.len()];
        let mut starts: Vec<usize> = lines.iter().map(|l| l.0.start).collect();
        for (first, n, balanced) in windows {
            let range = lines[first].0.start..lines[first + n - 1].0.end;
            let (cands, offs) = candidates(&self.plain, &xs, range);
            let a0 = if first == 0 { avail - indent } else { avail };
            let Some(ends) = wrap::optimal(cands.clone(), a0, avail, self.spec.size, balanced, n)
            else {
                continue;
            };
            let mut s = 0;
            for (j, &e) in ends.iter().enumerate() {
                let content = cands[e].if_break - cands[s].no_break;
                // Breite knapp über der Zeile: greedy bricht genau an der gewählten Stelle
                widths[first + j] = Some(content + 0.05 + if first + j == 0 { indent } else { 0. });
                if j > 0 {
                    starts[first + j] = offs[s];
                }
                s = e;
            }
        }
        self.break_lines(w, &widths);
        let ok = self.layout.len() == starts.len()
            && self
                .layout
                .lines()
                .zip(&starts)
                .all(|(l, &s)| l.text_range().start == s);
        if !ok {
            self.break_at(w);
        }
    }

    /// Umbruch mit eigener Breite je Zeile (None = Boxbreite).
    fn break_lines(&mut self, w: f32, widths: &[Option<f32>]) {
        let mut b = self.layout.break_lines();
        b.state_mut().set_layout_max_advance(f32::INFINITY);
        let mut i = 0;
        loop {
            let max = widths.get(i).copied().flatten().unwrap_or(w + EPS);
            b.state_mut().set_line_max_advance(max);
            if b.break_next().is_none() {
                break;
            }
            i += 1;
        }
        b.finish();
        self.layout
            .align(Alignment::Start, AlignmentOptions::default());
    }

    /// (Byteanfang, x0, x1, Leerraum) je Cluster; x je Zeile ab 0.
    fn cluster_xs(&self) -> Vec<(usize, f32, f32, bool)> {
        let mut out = Vec::new();
        for line in self.layout.lines() {
            let mut x = 0.;
            for run in line.runs() {
                for c in run.visual_clusters() {
                    let a = c.advance();
                    out.push((c.text_range().start, x, x + a, c.is_space_or_nbsp()));
                    x += a;
                }
            }
        }
        out
    }

    /// Zeilentexte (Debug, Umbruchvergleich): ohne Leerraum am Zeilenende.
    pub fn lines_text(&self) -> Vec<String> {
        if self.plain.is_empty() {
            return Vec::new();
        }
        self.layout
            .lines()
            .map(|l| self.plain[l.text_range()].trim_end().to_string())
            .collect()
    }

    // leerer Text: Chromium setzt keine Zeile, die Box ist 0 hoch
    pub fn lines(&self) -> u32 {
        if self.plain.is_empty() {
            0
        } else {
            self.layout.len() as u32
        }
    }

    pub fn height(&self) -> f32 {
        if self.plain.is_empty() {
            0.
        } else {
            self.layout.height()
        }
    }

    fn line_width(line: &parley::Line<'_, u32>) -> f32 {
        let m = line.metrics();
        m.advance - m.hanging_advance
    }

    /// breiteste Zeile (scrollWidth)
    pub fn content_width(&self) -> f32 {
        self.layout
            .lines()
            .map(|l| Self::line_width(&l))
            .fold(0., f32::max)
    }

    /// Glyphen in Folienkoordinaten; Box-Ursprung (x, y), Boxbreite w für Zentrierung.
    pub fn glyph_runs(&self, fonts: &FontStore, x: f32, y: f32, w: f32) -> Vec<GlyphRun> {
        let mut out = Vec::new();
        for line in self.layout.lines() {
            let dx = if self.spec.center {
                ((w - Self::line_width(&line)) / 2.).max(0.)
            } else {
                0.
            };
            let lr = line.text_range();
            for item in line.items() {
                let PositionedLayoutItem::GlyphRun(gr) = item else {
                    continue;
                };
                let run = gr.run();
                // Blink rundet Aufstieg und Abstieg, teilt den Zeilenabstand aber ungerundet
                let fm = run.font_metrics();
                let dy = (fm.ascent.round() - fm.ascent)
                    - ((fm.ascent.round() + fm.descent.round()) - (fm.ascent + fm.descent)) / 2.;
                let tr = run.text_range();
                let text = self
                    .plain
                    .get(tr.start.max(lr.start)..tr.end.min(lr.end))
                    .unwrap_or_default()
                    .to_string();
                let glyphs: Vec<Glyph> = gr
                    .positioned_glyphs()
                    .map(|g| Glyph {
                        id: g.id,
                        x: x + dx + g.x,
                        y: y + dy + g.y,
                    })
                    .collect();
                if glyphs.is_empty() {
                    continue;
                }
                out.push(GlyphRun {
                    font: fonts.font_data(run.font()),
                    size: run.font_size(),
                    color: unpack(gr.style().brush),
                    glyphs,
                    text,
                });
            }
        }
        out
    }

    /// Runs wie runsOf (measure.ts): Titel (hardwrap) mit den gewählten Zeilenumbrüchen.
    pub fn runs(&self) -> Vec<Run> {
        let base_bold = self.spec.weight >= 600.;
        let breaks: Vec<usize> = if self.spec.head() {
            self.layout
                .lines()
                .skip(1)
                .map(|l| l.text_range().start)
                .collect()
        } else {
            Vec::new()
        };
        let mut runs: Vec<Run> = Vec::new();
        let push = |runs: &mut Vec<Run>, text: &str, s: &Span| {
            let bold = base_bold || s.bold;
            let underline = s.link.as_ref().map(|_| true);
            let color = hex(if s.link.is_some() {
                self.spec.link_color
            } else {
                self.spec.color
            });
            if let Some(p) = runs.last_mut()
                && p.break_after.is_none()
                && p.bold == bold
                && p.underline == underline
                && p.color == color
                && p.link == s.link
                && p.size_px.is_some() == s.unit
            {
                p.text.push_str(text);
                return;
            }
            runs.push(Run {
                text: text.to_string(),
                bold,
                italic: false,
                underline,
                color,
                break_after: None,
                link: s.link.clone(),
                size_px: s.unit.then(|| r3(self.spec.size * 0.45)),
                tracking_px: s.unit.then_some(0.),
            });
        };
        let end_line = |runs: &mut Vec<Run>| {
            if let Some(p) = runs.last_mut() {
                p.text = p.text.trim_end().to_string();
                p.break_after = Some(true);
            }
        };
        for (range, s) in &self.spans {
            if range.start > 0 && breaks.contains(&range.start) {
                end_line(&mut runs);
            }
            let mut at = range.start;
            // harte Zeilenumbrüche (\n) und gewählte Umbrüche der Titel
            let mut cuts: Vec<(usize, bool)> = breaks
                .iter()
                .filter(|&&b| b > range.start && b < range.end)
                .map(|&b| (b, false))
                .collect();
            cuts.extend(
                self.plain[range.clone()]
                    .match_indices('\n')
                    .map(|(j, _)| (range.start + j, true)),
            );
            cuts.sort();
            for (cut, newline) in cuts {
                if cut > at {
                    push(&mut runs, &self.plain[at..cut], s);
                }
                end_line(&mut runs);
                at = if newline { cut + 1 } else { cut };
            }
            if range.end > at {
                push(&mut runs, &self.plain[at..range.end], s);
            }
        }
        if let Some(p) = runs.last_mut() {
            p.text = p.text.trim_end().to_string();
        }
        runs.retain(|r| !r.text.is_empty() || r.break_after.is_some());
        runs
    }

    pub fn align(&self) -> Align {
        if self.spec.center {
            Align::Center
        } else {
            Align::Left
        }
    }
}

/// Umbruchstellen in einem Text (Byteoffset des Zeilenanfangs danach), wie UAX #14 für unsere Texte:
/// nach Leerraum, nach „-“ vor einem Nicht-Ziffer-Zeichen, nach Gedankenstrich/Schrägstrich-freien BA-Zeichen (– —).
/// ponytail: nur die Klassen, die in Folientexten vorkommen; volle UAX #14 über parleys Analyse, falls Abweichungen auffallen
fn breaks(text: &str) -> Vec<usize> {
    let ch: Vec<(usize, char)> = text.char_indices().collect();
    let mut out = Vec::new();
    for k in 1..ch.len() {
        let (i, c) = ch[k];
        let (_, p) = ch[k - 1];
        if c.is_whitespace() {
            continue;
        }
        let word_before = k >= 2 && !ch[k - 2].1.is_whitespace();
        if p.is_whitespace() && p != '\u{a0}'
            || (p == '-' && word_before && !c.is_ascii_digit())
            || (matches!(p, '–' | '—') && word_before)
        {
            out.push(i);
        }
    }
    out
}

/// Kandidaten für wrap::optimal im Bytebereich eines Absatzfensters, dazu der Zeilenanfang je Kandidat.
fn candidates(
    plain: &str,
    xs: &[(usize, f32, f32, bool)],
    range: std::ops::Range<usize>,
) -> (Vec<Cand>, Vec<usize>) {
    let at = |b: usize| xs.iter().position(|c| c.0 >= b).unwrap_or(xs.len());
    let (i0, i1) = (at(range.start), at(range.end));
    let base = xs.get(i0).map_or(0., |c| c.1);
    // Ende des letzten sichtbaren Clusters vor Index i
    let ink_end = |i: usize| xs[i0..i].iter().rev().find(|c| !c.3).map_or(base, |c| c.2) - base;
    let mut cands = vec![Cand {
        no_break: 0.,
        if_break: 0.,
        penalty: 0.,
    }];
    let mut offs = vec![range.start];
    let text = &plain[range.clone()];
    for b in breaks(text) {
        let j = at(range.start + b);
        if j >= i1 {
            continue;
        }
        cands.push(Cand {
            no_break: xs[j].1 - base,
            if_break: ink_end(j),
            penalty: 0.,
        });
        offs.push(range.start + b);
    }
    let end = ink_end(i1);
    cands.push(Cand {
        no_break: end,
        if_break: end,
        penalty: 0.,
    });
    offs.push(range.end);
    (cands, offs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units() {
        assert_eq!(split_unit("855 €"), Some(("", "855", " €")));
        assert_eq!(split_unit("€ 12"), Some(("€ ", "12", "")));
        assert_eq!(split_unit("+12,5 %"), Some(("", "+12,5", " %")));
        assert_eq!(split_unit("1.200 Mio"), Some(("", "1.200", " Mio")));
        assert_eq!(split_unit("30–45 Tage"), Some(("", "30–45", " Tage")));
        assert_eq!(split_unit("Q3"), None);
        assert_eq!(split_unit("24/7"), None);
        assert_eq!(split_unit("42"), None);
    }

    #[test]
    fn break_opportunities() {
        assert_eq!(breaks("Q3-Review in 30-45 Tagen"), vec![3, 10, 13, 19]);
        assert_eq!(breaks("Wort"), Vec::<usize>::new());
    }

    #[test]
    fn rich_parts() {
        let s = rich("80 % **Zufriedenheit** und [Link](https://x.de) **");
        assert_eq!(s.len(), 5);
        assert!(s[1].bold && s[1].text == "Zufriedenheit");
        assert_eq!(s[3].link.as_deref(), Some("https://x.de"));
        assert_eq!(s[4].text, " **");
        assert_eq!(rich("****")[0].text, "****");
    }
}
