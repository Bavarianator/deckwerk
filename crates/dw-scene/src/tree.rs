//! Box-Baum der Layouts → taffy + parley → Szene, gemessene Elemente und Überlauf.

use dw_color::Rgb;
use dw_model::{
    Base, BoxEl, BoxFill, El, ElBox, IconEl, Node, NodeMeta, Overflow, OverflowKind, Paint, Stroke,
    TextEl,
};
use kurbo::{BezPath, Rect};
use taffy::prelude::*;

use crate::fonts::FontStore;
use crate::text::{TextNode, TextSpec, hex, unpack};

pub(crate) fn color(c: Rgb) -> dw_model::Color {
    unpack(u32::from_be_bytes([c.r, c.g, c.b, c.a]))
}

/// data-pptx="box"
#[derive(Debug, Clone)]
pub(crate) struct BoxSpec {
    pub slot: String,
    pub build: Option<u32>,
    pub fill: Option<Rgb>,
    pub radius: f32,
    pub ellipse: bool,
}

pub(crate) enum Kind {
    Block,
    Text(Box<TextSpec>),
    Icon {
        slot: String,
        build: Option<u32>,
        name: String,
        color: Rgb,
    },
}

/// Ein Element wie im DOM: taffy-Stil plus das, was CSS-Klassen und data-* beitragen.
pub(crate) struct Div {
    pub style: Style,
    pub kind: Kind,
    pub children: Vec<Div>,
    pub boxel: Option<BoxSpec>,
    pub paint: Option<Rgb>, // Fläche im Hintergrundbild (Linien statt ::before)
    pub border: Option<Rgb>, // Farbe von style.border
    pub fit: Option<String>, // [data-fit] mit Slot
    pub clip: bool,         // overflow: hidden
}

impl Div {
    pub fn new(style: Style) -> Div {
        Div {
            style,
            kind: Kind::Block,
            children: Vec::new(),
            boxel: None,
            paint: None,
            border: None,
            fit: None,
            clip: false,
        }
    }
    pub fn text(spec: TextSpec, style: Style) -> Div {
        Div {
            kind: Kind::Text(Box::new(spec)),
            ..Div::new(style)
        }
    }
    pub fn kids(mut self, kids: impl IntoIterator<Item = Div>) -> Div {
        self.children.extend(kids);
        self
    }
    pub fn fit(mut self, slot: &str) -> Div {
        self.fit = Some(slot.to_string());
        self
    }
    pub fn clip(mut self) -> Div {
        self.clip = true;
        self
    }
    pub fn boxel(mut self, b: BoxSpec) -> Div {
        self.boxel = Some(b);
        self
    }
}

enum Leaf {
    None,
    Text(Box<TextNode>),
    Icon,
}

struct Ctx {
    leaf: Leaf,
    kind: Kind,
    boxel: Option<BoxSpec>,
    paint: Option<Rgb>,
    border: Option<Rgb>,
    fit: Option<String>,
    clip: bool,
}

pub(crate) struct Laid {
    pub nodes: Vec<Node>,
    pub els: Vec<El>,
    pub overflow: Vec<Overflow>,
}

fn insert(t: &mut TaffyTree<Ctx>, d: Div, fonts: &mut FontStore) -> NodeId {
    let kids: Vec<NodeId> = d
        .children
        .into_iter()
        .map(|c| insert(t, c, fonts))
        .collect();
    let leaf = match &d.kind {
        Kind::Text(spec) => Leaf::Text(Box::new(TextNode::new((**spec).clone(), fonts))),
        Kind::Icon { .. } => Leaf::Icon,
        Kind::Block => Leaf::None,
    };
    let ctx = Ctx {
        leaf,
        kind: d.kind,
        boxel: d.boxel,
        paint: d.paint,
        border: d.border,
        fit: d.fit,
        clip: d.clip,
    };
    let id = t.new_with_children(d.style, &kids).expect("taffy");
    t.set_node_context(id, Some(ctx)).expect("taffy");
    id
}

struct Walk<'a> {
    fonts: &'a FontStore,
    nodes: Vec<Node>,
    els: Vec<El>,
    height: Vec<(usize, Overflow)>, // (Dokumentreihenfolge, Überlauf) der [data-fit]
    text: Vec<Overflow>,
    order: usize,
}

// f32 → f64 ohne Darstellungsrauschen (33.8 statt 33.799999)
fn r3(v: f32) -> f64 {
    (v as f64 * 1000.).round() / 1000.
}

fn ebox(x: f32, y: f32, w: f32, h: f32) -> ElBox {
    ElBox {
        x: x as f64,
        y: y as f64,
        w: w as f64,
        h: h as f64,
    }
}

fn base(slot: &str, b: ElBox, build: Option<u32>) -> Base {
    Base {
        slot: slot.to_string(),
        bbox: b,
        build,
        rot: None,
        anim: None,
        anim_dir: None,
        anim_speed: None,
        link: None,
    }
}

fn rect_node(slot: Option<String>, export: bool, r: Rect, radius: f64, fill: Rgb) -> Node {
    Node::Rect {
        meta: NodeMeta { slot, export },
        rect: r,
        radius,
        fill: Some(Paint::Solid(color(fill))),
        stroke: None,
        shadow: None,
    }
}

/// lucide-Pfade (24er-Raster); nur, was die Beispiele brauchen.
fn icon_path(name: &str) -> Option<&'static str> {
    match name {
        "check" => Some("M20 6 9 17l-5-5"),
        _ => None,
    }
}

impl Walk<'_> {
    /// Liefert die untere Kante samt sichtbarem Überlauf (für scrollHeight der Eltern).
    fn walk(&mut self, t: &mut TaffyTree<Ctx>, id: NodeId, ox: f32, oy: f32, bg: Rgb) -> f32 {
        let l = *t.layout(id).expect("taffy");
        let (x, y, w, h) = (
            ox + l.location.x,
            oy + l.location.y,
            l.size.width,
            l.size.height,
        );
        let order = self.order;
        self.order += 1;
        let kids: Vec<NodeId> = t.children(id).expect("taffy");
        let ctx = t.get_node_context_mut(id).expect("Kontext");
        let r = Rect::new(x as f64, y as f64, (x + w) as f64, (y + h) as f64);
        let mut bottom = y + h;
        let mut bg = bg;

        if let Some(c) = ctx.paint {
            self.nodes.push(rect_node(None, false, r, 0., c));
        }
        if let Some(c) = ctx.border {
            let b = l.border;
            for (side, on) in [
                (Rect::new(r.x0, r.y0, r.x1, r.y0 + b.top as f64), b.top > 0.),
                (
                    Rect::new(r.x0, r.y1 - b.bottom as f64, r.x1, r.y1),
                    b.bottom > 0.,
                ),
                (
                    Rect::new(r.x0, r.y0, r.x0 + b.left as f64, r.y1),
                    b.left > 0.,
                ),
                (
                    Rect::new(r.x1 - b.right as f64, r.y0, r.x1, r.y1),
                    b.right > 0.,
                ),
            ] {
                if on {
                    self.nodes.push(rect_node(None, false, side, 0., c));
                }
            }
        }
        // extract() überspringt Elemente ohne Fläche
        let visible = w > 0. && h > 0.;
        if let Some(b) = ctx.boxel.as_ref().filter(|_| visible) {
            if let Some(f) = b.fill {
                bg = f;
                self.nodes
                    .push(rect_node(Some(b.slot.clone()), true, r, b.radius as f64, f));
            }
            self.els.push(El::Box(BoxEl {
                base: base(&b.slot, ebox(x, y, w, h), b.build),
                fill: b.fill.map(|f| BoxFill {
                    color: hex(f),
                    alpha: 1.,
                }),
                border: None,
                radius: b.radius as f64,
                shadow: None,
                ellipse: b.ellipse,
                gradient: None,
                shape: None,
                line_start: None,
                line_end: None,
                dash: None,
            }));
        }
        match (&mut ctx.leaf, &ctx.kind) {
            (Leaf::Text(tn), Kind::Text(spec)) => {
                tn.finish(w);
                bottom = bottom.max(y + tn.height());
                let cw = tn.content_width();
                if cw - w > 1. {
                    self.text.push(Overflow {
                        slot: spec.slot.clone(),
                        over_px: (cw - w) as f64,
                        kind: OverflowKind::Width,
                    });
                }
                if spec.max_lines.is_some_and(|m| tn.lines() > m) {
                    self.text.push(Overflow {
                        slot: spec.slot.clone(),
                        over_px: 0.,
                        kind: OverflowKind::Lines,
                    });
                }
                // ohne Fläche weder El noch Glyphen; die Überlaufprüfung oben läuft trotzdem (findOverflow)
                if visible {
                    for run in tn.glyph_runs(self.fonts, x, y, w) {
                        self.nodes.push(Node::Glyphs {
                            meta: NodeMeta {
                                slot: Some(spec.slot.clone()),
                                export: true,
                            },
                            run,
                        });
                    }
                    self.els.push(El::Text(TextEl {
                        base: base(&spec.slot, ebox(x, y, w, h), spec.build),
                        font: if spec.head() {
                            dw_model::FontRole::Head
                        } else {
                            dw_model::FontRole::Body
                        },
                        role: spec.role.name().to_string(),
                        size_px: r3(spec.size),
                        effect: None,
                        font_face: None,
                        line_height_px: r3(spec.line_height_px()),
                        tracking_px: r3(spec.tracking_px()),
                        align: tn.align(),
                        upper: false,
                        runs: tn.runs(),
                        list: None,
                        lines: tn.lines(),
                        bg: hex(bg),
                    }));
                }
            }
            (
                Leaf::Icon,
                Kind::Icon {
                    slot,
                    build,
                    name,
                    color: c,
                },
            ) if visible => {
                let d = icon_path(name);
                let svg = d.map(|d| format!(
                    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"{}\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"{d}\"></path></svg>",
                    hex(*c)
                ));
                if let Some(path) = d.and_then(|d| BezPath::from_svg(d).ok()) {
                    let k = (w / 24.) as f64;
                    let path = kurbo::Affine::translate((x as f64, y as f64))
                        * kurbo::Affine::scale(k)
                        * path;
                    self.nodes.push(Node::Path {
                        meta: NodeMeta {
                            slot: Some(slot.clone()),
                            export: true,
                        },
                        path,
                        fill: None,
                        stroke: Some(Stroke {
                            width: (2. * k) as f32,
                            color: color(*c),
                            dash: None,
                        }),
                    });
                }
                self.els.push(El::Icon(IconEl {
                    base: base(slot, ebox(x, y, w, h), *build),
                    svg: svg.unwrap_or_default(),
                    png: None,
                    name: Some(name.clone()),
                    qr: None,
                    color: Some(hex(*c)),
                }));
            }
            _ => {}
        }
        let fit = ctx.fit.clone();
        let clip = ctx.clip;

        // Inhalt: Kinder samt Außenabstand unten (scrollHeight)
        let mut content = y + l.border.top + l.padding.top;
        for k in kids {
            let mb = t.layout(k).expect("taffy").margin.bottom;
            let kb = self.walk(t, k, x, y, bg);
            content = content.max(kb + mb);
        }
        if let Some(slot) = fit {
            let scroll = content + l.padding.bottom - (y + l.border.top);
            let client = h - l.border.top - l.border.bottom;
            let dh = scroll - client;
            if dh > 1. {
                self.height.push((
                    order,
                    Overflow {
                        slot,
                        over_px: dh as f64,
                        kind: OverflowKind::Height,
                    },
                ));
            }
        }
        if !clip {
            bottom = bottom.max(content);
        }
        bottom
    }
}

/// Setzt den Baum auf einer Folie w×h.
pub(crate) fn lay(root: Div, fonts: &mut FontStore, w: f32, h: f32, bg: Rgb) -> Laid {
    let mut t: TaffyTree<Ctx> = TaffyTree::new();
    t.disable_rounding(); // Chromium rechnet in 1/64 px, nicht in ganzen Pixeln
    let id = insert(&mut t, root, fonts);
    t.compute_layout_with_measure(
        id,
        Size {
            width: AvailableSpace::Definite(w),
            height: AvailableSpace::Definite(h),
        },
        |inputs, _, ctx, style| {
            taffy::compute_leaf_layout(
                inputs,
                style,
                |_, _| 0.0,
                |known, avail| match ctx {
                    Some(Ctx {
                        leaf: Leaf::Text(tn),
                        ..
                    }) => tn.measure(known, avail),
                    Some(Ctx {
                        leaf: Leaf::Icon, ..
                    }) => Size {
                        width: known.width.unwrap_or(0.),
                        height: known.height.unwrap_or(0.),
                    },
                    _ => Size::ZERO,
                },
            )
        },
    )
    .expect("taffy");
    let mut walk = Walk {
        fonts,
        nodes: Vec::new(),
        els: Vec::new(),
        height: Vec::new(),
        text: Vec::new(),
        order: 0,
    };
    walk.walk(&mut t, id, 0., 0., bg);
    // findOverflow: erst alle [data-fit] in Dokumentreihenfolge, dann die Texte
    walk.height.sort_by_key(|(o, _)| *o);
    let mut overflow: Vec<Overflow> = walk.height.into_iter().map(|(_, o)| o).collect();
    overflow.extend(walk.text);
    Laid {
        nodes: walk.nodes,
        els: walk.els,
        overflow,
    }
}
