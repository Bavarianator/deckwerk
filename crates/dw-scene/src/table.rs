//! Tabelle (`.free-table` in slide.css, measure.ts „table“): feste Spaltenbreiten (table-layout: fixed, gleich breit),
//! Zellen mit parley gesetzt, Polsterung 0,45 em × TABLE_PAD, Kopfzeile fett über 2-px-Linie, sonst 1-px-Haarlinien.

use dw_color::Rgb;
use dw_model::{Align, FontRole, GlyphRun, Node, NodeMeta, Paint, TableEl};
use dw_theme::Role;
use kurbo::Rect;
use taffy::{AvailableSpace, Size};

use crate::fonts::FontStore;
use crate::text::{TextNode, TextSpec, hex};
use crate::tree::color;

/// px links/rechts je Zelle, wie export-pptx.ts
pub const TABLE_PAD: f32 = 8.;

#[derive(Debug, Clone)]
pub struct TableSpec {
    pub slot: String,
    pub build: Option<u32>,
    /// erste Zeile = Kopf
    pub cells: Vec<Vec<String>>,
    pub size: f32,
    /// CSS-Schriftliste
    pub family: String,
    pub head_font: bool,
    pub face: Option<String>,
    pub color: Rgb,
    pub line: Rgb,
    /// je Spalte (Zahlenspalten rechts)
    pub align: Vec<Align>,
}

pub(crate) struct TableNode {
    pub spec: TableSpec,
    cells: Vec<Vec<TextNode>>,
    col_w: Vec<f32>,
    row_h: Vec<f32>,
}

impl TableNode {
    pub fn new(spec: TableSpec, fonts: &mut FontStore) -> TableNode {
        let cells = spec
            .cells
            .iter()
            .enumerate()
            .map(|(r, row)| {
                row.iter()
                    .enumerate()
                    .map(|(c, text)| {
                        let t = TextSpec {
                            role: Role::Body,
                            slot: format!("{}.{r}.{c}", spec.slot),
                            build: spec.build,
                            max_lines: None,
                            text: text.clone(),
                            family: spec.family.clone(),
                            size: spec.size,
                            lh: 1.25,
                            tracking_em: 0.,
                            weight: if r == 0 { 700. } else { 400. },
                            color: spec.color,
                            link_color: spec.color,
                            center: false,
                            nowrap: false,
                            upper: false,
                            face: None,
                            unit: false,
                        };
                        TextNode::new(t, fonts)
                    })
                    .collect()
            })
            .collect();
        TableNode {
            spec,
            cells,
            col_w: Vec::new(),
            row_h: Vec::new(),
        }
    }

    fn cols(&self) -> usize {
        self.cells.iter().map(Vec::len).max().unwrap_or(0)
    }

    /// Spalten gleich breit; Zeilenhöhe = höchste Zelle + Polsterung + Unterkante.
    fn lay(&mut self, w: f32) {
        let n = self.cols().max(1);
        let cw = w / n as f32;
        self.col_w = vec![cw; n];
        let pad = 0.45 * self.spec.size * 2.;
        self.row_h = self
            .cells
            .iter_mut()
            .enumerate()
            .map(|(r, row)| {
                let h = row
                    .iter_mut()
                    .map(|t| {
                        t.finish((cw - 2. * TABLE_PAD).max(0.));
                        t.height().max(t.spec.line_height_px())
                    })
                    .fold(0., f32::max);
                h + pad + if r == 0 { 2. } else { 1. }
            })
            .collect();
    }

    pub fn measure(&mut self, known: Size<Option<f32>>, avail: Size<AvailableSpace>) -> Size<f32> {
        let w = known.width.unwrap_or(match avail.width {
            AvailableSpace::Definite(w) => w,
            _ => 0.,
        });
        self.lay(w);
        Size {
            width: w,
            height: known.height.unwrap_or(self.row_h.iter().sum()),
        }
    }

    /// Knoten (nativ in der PPTX: export) und TableEl an (x, y) mit Breite w.
    pub fn emit(
        &mut self,
        fonts: &FontStore,
        x: f32,
        y: f32,
        w: f32,
        base: dw_model::Base,
    ) -> (Vec<Node>, TableEl) {
        self.lay(w);
        let meta = NodeMeta {
            slot: Some(self.spec.slot.clone()),
            export: true,
        };
        let mut nodes = Vec::new();
        let mut ry = y;
        for (r, row) in self.cells.iter().enumerate() {
            let rh = self.row_h[r];
            let border = if r == 0 { 2. } else { 1. };
            let mut cx = x;
            for (c, t) in row.iter().enumerate() {
                let cw = self.col_w[c];
                let inner = cw - 2. * TABLE_PAD;
                let right = self.spec.align.get(c) == Some(&Align::Right);
                let dx = if right {
                    (inner - t.content_width()).max(0.)
                } else {
                    0.
                };
                // vertical-align: middle
                let dy = (rh - border - t.height()) / 2.;
                let runs: Vec<GlyphRun> = t.glyph_runs(fonts, cx + TABLE_PAD + dx, ry + dy, inner);
                nodes.extend(runs.into_iter().map(|run| Node::Glyphs {
                    meta: meta.clone(),
                    run,
                }));
                cx += cw;
            }
            let line = if r == 0 {
                self.spec.color
            } else {
                self.spec.line
            };
            nodes.push(Node::Rect {
                meta: meta.clone(),
                rect: Rect::new(
                    x as f64,
                    (ry + rh - border) as f64,
                    (x + w) as f64,
                    (ry + rh) as f64,
                ),
                radius: 0.,
                fill: Some(Paint::Solid(color(line))),
                stroke: None,
                shadow: None,
            });
            ry += rh;
        }
        let el = TableEl {
            base,
            cells: self.spec.cells.clone(),
            col_w: self.col_w.iter().map(|&v| v as f64).collect(),
            row_h: self.row_h.iter().map(|&v| v as f64).collect(),
            size_px: self.spec.size as f64,
            font: if self.spec.head_font {
                FontRole::Head
            } else {
                FontRole::Body
            },
            font_face: self.spec.face.clone(),
            color: hex(self.spec.color),
            line: hex(self.spec.line),
            align: (0..self.cols())
                .map(|c| self.spec.align.get(c).copied().unwrap_or(Align::Left))
                .collect(),
        };
        (nodes, el)
    }
}
