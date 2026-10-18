//! Box-Baum der Layouts → taffy + parley → Szene, gemessene Elemente und Überlauf.

use dw_color::Rgb;
use dw_model::{
    Base, Border, BoxEl, BoxFill, BoxShadow, ChartEl, ChartSpec, El, ElBox, Focus, Gradient,
    IconEl, ImageSrc, ImgEl, ImgFit, Node, NodeMeta, Overflow, OverflowKind, Paint, Shadow, Stop,
    Stroke, TextEl,
};
use kurbo::{BezPath, Point, Rect};
use taffy::prelude::*;

use crate::fonts::FontStore;
use crate::table::{TableNode, TableSpec};
use crate::text::{TextNode, TextSpec, hex, unpack};

pub(crate) fn color(c: Rgb) -> dw_model::Color {
    unpack(u32::from_be_bytes([c.r, c.g, c.b, c.a]))
}

/// Fläche: Farbe, linear-gradient(angle, …) oder radial-gradient(circle at x y, …) (farthest-corner).
#[derive(Debug, Clone)]
pub enum Fill {
    Solid(Rgb),
    /// CSS-Winkel in Grad, Stopps (0..1, Farbe mit Alpha)
    Linear(f64, Vec<(f32, dw_model::Color)>),
    /// Mittelpunkt relativ zur Box (0..1)
    #[allow(dead_code)] // für radiale Flächen der Layout-Gruppen
    Radial((f64, f64), Vec<(f32, dw_model::Color)>),
}

impl From<Rgb> for Fill {
    fn from(c: Rgb) -> Fill {
        Fill::Solid(c)
    }
}

impl Fill {
    /// Farbe für den Kontrast-Lint: Fläche bzw. erster Stopp
    fn base(&self) -> Option<Rgb> {
        match self {
            Fill::Solid(c) => Some(*c),
            Fill::Linear(_, s) | Fill::Radial(_, s) => s.first().map(|(_, c)| Rgb {
                r: c.r,
                g: c.g,
                b: c.b,
                a: 255,
            }),
        }
    }
    /// Malfarbe in Folienkoordinaten für die Box `r`
    pub fn paint(&self, r: Rect) -> Paint {
        let stops = |s: &[(f32, dw_model::Color)]| {
            s.iter()
                .map(|&(offset, color)| Stop { offset, color })
                .collect()
        };
        match self {
            Fill::Solid(c) => Paint::Solid(color(*c)),
            Fill::Linear(angle, s) => {
                let (start, end) = linear_points(*angle, r);
                Paint::Linear {
                    start,
                    end,
                    stops: stops(s),
                }
            }
            Fill::Radial((fx, fy), s) => {
                let center = Point::new(r.x0 + r.width() * fx, r.y0 + r.height() * fy);
                let radius = [r.x0, r.x1]
                    .iter()
                    .flat_map(|&x| [r.y0, r.y1].map(|y| center.distance(Point::new(x, y))))
                    .fold(0., f64::max);
                Paint::Radial {
                    center,
                    radius,
                    stops: stops(s),
                }
            }
        }
    }
}

/// CSS linear-gradient: Linie durch die Mitte, so lang, dass die Ecken die Endfarben treffen.
pub fn linear_points(angle_deg: f64, r: Rect) -> (Point, Point) {
    let a = angle_deg.to_radians();
    let (dx, dy) = (a.sin(), -a.cos());
    let len = (r.width() * dx).abs() + (r.height() * dy).abs();
    let c = r.center();
    let d = kurbo::Vec2::new(dx, dy) * (len / 2.);
    (c - d, c + d)
}

/// data-pptx="box": Fläche oder Verlauf, Rand, Schatten, Radius
#[derive(Debug, Clone)]
pub(crate) struct BoxSpec {
    pub slot: String,
    pub build: Option<u32>,
    pub fill: Option<Rgb>,
    pub radius: f32,
    pub ellipse: bool,
    /// background-image: linear-gradient (Scrim, Verlauf)
    pub gradient: Option<Gradient>,
    /// border: (Farbe, Breite) – in der PPTX Rahmen ringsum
    pub border: Option<(Rgb, f32)>,
    pub shadow: Option<BoxShadow>,
}

/// Bild als CSS-Hintergrund (Img in slide.tsx)
#[derive(Debug, Clone)]
pub struct ImgSpec {
    pub slot: String,
    pub src: String,
    pub build: Option<u32>,
    pub fit: ImgFit,
    /// background-position 0..1 (Fokus bei cover, Ausrichtung bei contain: Logo links = (0, 0.5))
    pub focus: (f64, f64),
    pub radius: f32,
    /// .round: Kreismaske
    pub round: bool,
    /// liegt unter Text (Vollbild)
    pub under: bool,
    /// Duotone/Mono (theme.images bzw. Foto-look)
    pub look: Option<String>,
    pub alpha: Option<f64>,
}

/// Diagramm (ChartBox): Platz im Layout, Zeichnen über chart::draw
#[derive(Debug, Clone)]
pub struct ChartBox {
    pub slot: String,
    pub build: Option<u32>,
    pub spec: ChartSpec,
    pub theme: dw_theme::Theme,
}

pub(crate) enum Kind {
    Block,
    Text(Box<TextSpec>),
    Icon {
        slot: String,
        build: Option<u32>,
        name: String,
        color: Rgb,
        /// strokeWidth im 24er-Raster (Icon: 1,75)
        stroke: f32,
    },
    Img(Box<ImgSpec>),
    Table(Box<TableSpec>),
    Chart(Box<ChartBox>),
}

/// Ein Element wie im DOM: taffy-Stil plus das, was CSS-Klassen und data-* beitragen.
pub(crate) struct Div {
    pub style: Style,
    pub kind: Kind,
    pub children: Vec<Div>,
    pub boxel: Option<BoxSpec>,
    pub paint: Option<Fill>, // Fläche im Hintergrundbild (Linien statt ::before, Farbflächen, Verläufe)
    pub border: Option<Rgb>, // Farbe von style.border
    pub fit: Option<String>, // [data-fit] mit Slot
    pub clip: bool,          // overflow: hidden
    pub pre: Vec<Node>, // Hintergrundebene (Dekor) in Folienkoordinaten, vor allem anderen gemalt
    pub hdr: bool,      // .hdr (Folienkopf): Frame setzt rule-over nur darüber
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
            pre: Vec::new(),
            hdr: false,
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
    /// Fläche im Hintergrundbild (CSS background ohne data-pptx); gilt als Grund für den Kontrast-Lint.
    pub fn paint(mut self, c: impl Into<Fill>) -> Div {
        self.paint = Some(c.into());
        self
    }
}

enum Leaf {
    None,
    Text(Box<TextNode>),
    Icon,
    Table(Box<TableNode>),
}

/// Zeilentexte eines Text-Slots nach dem Umbruch (Debug, Umbruchvergleich mit Chromium).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SlotLines {
    pub slot: String,
    pub lines: Vec<String>,
}

struct Ctx {
    leaf: Leaf,
    kind: Kind,
    boxel: Option<BoxSpec>,
    paint: Option<Fill>,
    border: Option<Rgb>,
    fit: Option<String>,
    clip: bool,
    pre: Vec<Node>,
}

pub(crate) struct Laid {
    pub nodes: Vec<Node>,
    pub els: Vec<El>,
    pub overflow: Vec<Overflow>,
    pub lines: Vec<SlotLines>,
}

fn insert(t: &mut TaffyTree<Ctx>, d: Div, fonts: &mut FontStore) -> NodeId {
    let kids: Vec<NodeId> = d
        .children
        .into_iter()
        .map(|c| insert(t, c, fonts))
        .collect();
    let leaf = match &d.kind {
        Kind::Text(spec) => Leaf::Text(Box::new(TextNode::new((**spec).clone(), fonts))),
        Kind::Icon { .. } | Kind::Img(_) | Kind::Chart(_) => Leaf::Icon,
        Kind::Table(spec) => Leaf::Table(Box::new(TableNode::new((**spec).clone(), fonts))),
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
        pre: d.pre,
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
    lines: Vec<SlotLines>,
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

        self.nodes.append(&mut ctx.pre);
        if let Some(f) = &ctx.paint {
            bg = f.base().unwrap_or(bg);
            self.nodes.push(Node::Rect {
                meta: NodeMeta::default(),
                rect: r,
                radius: 0.,
                fill: Some(f.paint(r)),
                stroke: None,
                shadow: None,
            });
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
            let radius = if b.ellipse { w.min(h) / 2. } else { b.radius } as f64;
            let grad = b.gradient.as_ref().map(|g| {
                Fill::Linear(
                    g.angle,
                    g.stops
                        .iter()
                        .map(|s| {
                            let mut c =
                                dw_model::Color::from_hex(&s.color).unwrap_or(dw_model::Color {
                                    r: 0,
                                    g: 0,
                                    b: 0,
                                    a: 255,
                                });
                            c.a = (s.alpha * 255.).round() as u8;
                            (s.pos as f32, c)
                        })
                        .collect(),
                )
            });
            let fill = b.fill.map(Fill::Solid).or(grad);
            if let Some(f) = b.fill {
                bg = f;
            }
            if fill.is_some() || b.border.is_some() || b.shadow.is_some() {
                let bw = b.border.map_or(0., |(_, w)| w as f64);
                self.nodes.push(Node::Rect {
                    meta: NodeMeta {
                        slot: Some(b.slot.clone()),
                        export: true,
                    },
                    // Rand liegt innen (box-sizing: border-box): Strichmitte um die halbe Breite eingerückt
                    rect: r.inset(-bw / 2.),
                    radius,
                    fill: fill.map(|f| f.paint(r)),
                    stroke: b.border.map(|(c, w)| Stroke {
                        width: w,
                        color: color(c),
                        dash: None,
                    }),
                    shadow: b.shadow.as_ref().map(|s| Shadow {
                        color: {
                            let mut c =
                                dw_model::Color::from_hex(&s.color).unwrap_or(dw_model::Color {
                                    r: 0,
                                    g: 0,
                                    b: 0,
                                    a: 255,
                                });
                            c.a = (s.alpha * 255.).round() as u8;
                            c
                        },
                        blur: s.blur as f32,
                        offset_y: s.offset_y as f32,
                    }),
                });
            }
            self.els.push(El::Box(BoxEl {
                base: base(&b.slot, ebox(x, y, w, h), b.build),
                fill: b.fill.map(|f| BoxFill {
                    color: hex(f),
                    alpha: 1.,
                }),
                border: b.border.map(|(c, w)| Border {
                    color: hex(c),
                    width: w as f64,
                }),
                radius: b.radius as f64,
                shadow: b.shadow.clone(),
                ellipse: b.ellipse,
                gradient: b.gradient.clone(),
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
                self.lines.push(SlotLines {
                    slot: spec.slot.clone(),
                    lines: tn.lines_text(),
                });
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
                        font_face: spec.face.clone(),
                        line_height_px: r3(spec.line_height_px()),
                        tracking_px: r3(spec.tracking_px()),
                        align: tn.align(),
                        upper: spec.upper,
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
                    stroke,
                },
            ) if visible => {
                let d = crate::icons::path_or_default(name);
                let svg = format!(
                    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"{}\" stroke-width=\"{stroke}\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"{d}\"></path></svg>",
                    hex(*c)
                );
                if let Ok(path) = BezPath::from_svg(d) {
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
                            width: (*stroke as f64 * k) as f32,
                            color: color(*c),
                            dash: None,
                        }),
                    });
                }
                self.els.push(El::Icon(IconEl {
                    base: base(slot, ebox(x, y, w, h), *build),
                    svg,
                    png: None,
                    name: Some(name.clone()),
                    qr: None,
                    color: Some(hex(*c)),
                }));
            }
            (Leaf::Icon, Kind::Img(im)) if visible => {
                let radius = if im.round { w.min(h) / 2. } else { im.radius } as f64;
                self.nodes.push(Node::Image {
                    meta: NodeMeta {
                        slot: Some(im.slot.clone()),
                        export: true,
                    },
                    rect: r,
                    src: ImageSrc::Path(im.src.strip_prefix("asset://").unwrap_or(&im.src).into()),
                    fit: im.fit,
                    focus: (im.focus.0 as f32, im.focus.1 as f32),
                    radius,
                });
                self.els.push(El::Img(ImgEl {
                    base: base(&im.slot, ebox(x, y, w, h), im.build),
                    src: im.src.clone(),
                    radius,
                    fit: im.fit,
                    focus: Focus {
                        x: im.focus.0,
                        y: im.focus.1,
                    },
                    under: im.under.then_some(true),
                    nat: None,
                    look: im.look.clone(),
                    alt: None,
                    mask: None,
                    adjust: None,
                    alpha: im.alpha,
                    round: im.round.then_some(true),
                    flip: None,
                    crop: None,
                }));
            }
            (Leaf::Icon, Kind::Chart(ch)) if visible => {
                self.nodes
                    .extend(crate::chart::draw(&ch.spec, r, &ch.theme, &ch.slot));
                self.els.push(El::Chart(ChartEl {
                    base: base(&ch.slot, ebox(x, y, w, h), ch.build),
                    spec: ch.spec.clone(),
                }));
            }
            (Leaf::Table(tn), Kind::Table(spec)) if visible => {
                let (nodes, el) = tn.emit(
                    self.fonts,
                    x,
                    y,
                    w,
                    base(&spec.slot, ebox(x, y, w, h), spec.build),
                );
                self.nodes.extend(nodes);
                self.els.push(El::Table(el));
            }
            _ => {}
        }
        let fit = ctx.fit.clone();
        let clip = ctx.clip;

        // Inhalt: Kinder samt Außenabstand unten (scrollHeight)
        // absolut positionierte Kinder zählen ohne Innenabstand unten (Chromium: padding-end nur für den Fluss)
        let mut content = y + l.border.top + l.padding.top;
        let mut abs_bottom = content;
        for k in kids {
            let mb = t.layout(k).expect("taffy").margin.bottom;
            let absolute = t.style(k).expect("taffy").position == Position::Absolute;
            let kb = self.walk(t, k, x, y, bg);
            if absolute {
                abs_bottom = abs_bottom.max(kb + mb);
            } else {
                content = content.max(kb + mb);
            }
        }
        let content_all = content.max(abs_bottom);
        if let Some(slot) = fit {
            let scroll = (content + l.padding.bottom).max(abs_bottom) - (y + l.border.top);
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
            bottom = bottom.max(content_all);
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
                        leaf: Leaf::Table(tn),
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
        lines: Vec::new(),
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
        lines: walk.lines,
    }
}
