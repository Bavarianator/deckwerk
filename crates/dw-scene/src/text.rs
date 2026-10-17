//! Textknoten (`<T role slot>`): Markdown-Auszug, Satz mit parley, Zeilen, Runs und Glyphen.

use dw_color::Rgb;
use dw_model::{Align, Glyph, GlyphRun, Run};
use parley::{
    Alignment, AlignmentOptions, FontFamily, FontWeight, Layout, LineHeight, PositionedLayoutItem,
    StyleProperty, TextWrapMode, WhiteSpaceCollapse,
};
use taffy::{AvailableSpace, Size};

use crate::fonts::FontStore;
use crate::theme::Role;

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
    pub text: String, // Rohtext mit Markdown
    pub family: &'static str,
    pub size: f32,
    pub lh: f32, // Faktor
    pub tracking_em: f32,
    pub weight: f32,
    pub color: Rgb,
    pub link_color: Rgb,
    pub center: bool,
    pub nowrap: bool,
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
        for s in rich(&spec.text) {
            let start = plain.len();
            plain.push_str(&s.text);
            spans.push((start..plain.len(), s));
        }
        let mut b = fonts.lcx.ranged_builder(&mut fonts.fcx, &plain, 1.0, false); // Zeilen mit exakter line-height wie Chromium
        b.push_default(StyleProperty::FontFamily(FontFamily::named(spec.family)));
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

    /// Endgültiger Umbruch in der Box; Titel mit text-wrap: balance.
    pub fn finish(&mut self, w: f32) {
        self.break_at(w);
        let n = self.layout.len();
        if self.spec.head() && !self.spec.nowrap && (2..=6).contains(&n) {
            // schmalste Breite mit gleicher Zeilenzahl (Chromium balanciert bis 6 Zeilen)
            let (mut lo, mut hi) = (0.0f32, w);
            for _ in 0..14 {
                let mid = (lo + hi) / 2.;
                self.break_at(mid);
                if self.layout.len() == n {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            self.break_at(hi);
        }
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
                size_px: None,
                tracking_px: None,
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

#[cfg(test)]
mod tests {
    use super::*;

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
