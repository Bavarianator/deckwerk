//! Layouts als Rust-Funktionen (layouts.tsx + slide.css, Theme-Hebel elements: line, rule: under).

use dw_color::Rgb;
use serde_json::Value;
use taffy::prelude::*;

use crate::Error;
use crate::text::TextSpec;
use crate::theme::{Role, Theme, fs};
use crate::tree::{BoxSpec, Div, Kind};

/// Layouts mit Varianten (layouts.ts); footer = LayoutDef.footer.
pub const LAYOUTS: &[(&str, &[&str], bool)] = &[
    ("cover", &["left", "center", "bottom", "side"], false),
    ("bullets", &["list", "cards"], true),
    ("two-column", &["rule", "equal", "highlight-right"], true),
];

pub(crate) struct Cx<'a> {
    pub theme: &'a Theme,
    pub head: u32,
    pub body: u32,
    pub k: f32,
    pub w: f32,
    pub h: f32,
}

impl Cx<'_> {
    pub fn fs(&self, role: Role) -> f32 {
        fs(role, self.head, self.body, self.k)
    }

    /// `<T role slot>` mit den Rollen-Stilen aus slide.css.
    pub fn t(&self, role: Role, slot: impl Into<String>, text: &str) -> TextSpec {
        let th = self.theme;
        let head = role.head_font();
        TextSpec {
            role,
            slot: slot.into(),
            build: None,
            max_lines: None,
            text: text.to_string(),
            family: if head { th.head_family } else { th.body_family },
            size: self.fs(role),
            lh: role.line_height(),
            tracking_em: th.tracking_em(role),
            weight: if head {
                th.head_weight
            } else if role == Role::Eyebrow {
                700.
            } else {
                400.
            },
            color: if matches!(role, Role::Small | Role::Eyebrow | Role::Footer) {
                th.muted
            } else {
                th.text
            },
            link_color: th.accent,
            center: false,
            nowrap: matches!(role, Role::Hero | Role::Kpi),
        }
    }
}

// ---------- Stil-Bausteine ----------

fn px(v: f32) -> LengthPercentage {
    LengthPercentage::length(v)
}
fn pxa(v: f32) -> LengthPercentageAuto {
    LengthPercentageAuto::length(v)
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
fn col(gap: f32) -> Style {
    flex(FlexDirection::Column, gap)
}
fn row(gap: f32) -> Style {
    flex(FlexDirection::Row, gap)
}

trait StyleExt {
    fn grow(self) -> Self; // flex: 1
    fn none(self) -> Self; // flex: none
    fn min_h0(self) -> Self;
    fn min_w0(self) -> Self;
    fn max_w(self, w: f32) -> Self;
    fn wh(self, w: f32, h: f32) -> Self;
    fn h(self, h: f32) -> Self;
    fn pad(self, t: f32, r: f32, b: f32, l: f32) -> Self;
    fn mt(self, v: f32) -> Self;
    fn mb(self, v: f32) -> Self;
    fn rel_top(self, v: f32) -> Self;
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
    fn mt(mut self, v: f32) -> Self {
        self.margin.top = pxa(v);
        self
    }
    fn mb(mut self, v: f32) -> Self {
        self.margin.bottom = pxa(v);
        self
    }
    fn rel_top(mut self, v: f32) -> Self {
        self.position = Position::Relative;
        self.inset.top = pxa(v);
        self
    }
}

fn abs(l: Option<f32>, r: Option<f32>, t: Option<f32>, b: Option<f32>) -> Style {
    let a = |v: Option<f32>| v.map_or(LengthPercentageAuto::auto(), pxa);
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

/// `.t`: min-width 0
fn t(spec: TextSpec) -> Div {
    Div::text(spec, Style::DEFAULT.min_w0())
}
fn t_styled(spec: TextSpec, style: Style) -> Div {
    Div::text(spec, style.min_w0())
}

/// Linie statt ::before (left 0, right 0, top 0): landet im Hintergrundbild.
fn top_line(height: f32, c: Rgb) -> Div {
    let mut d = Div::new(abs(Some(0.), Some(0.), Some(0.), None).h(height));
    d.paint = Some(c);
    d
}

fn bx(slot: impl Into<String>, build: Option<u32>, fill: Option<Rgb>) -> BoxSpec {
    BoxSpec {
        slot: slot.into(),
        build,
        fill,
        radius: 0., // el-line: keine Rundung
        ellipse: false,
    }
}

// ---------- Inhalt lesen ----------

/// Text eines Felds; leer zählt wie fehlend (JS: `c.subtitle && …`).
fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}
fn req<'a>(v: &'a Value, k: &str) -> Result<&'a str, Error> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Content(format!("Feld {k} fehlt")))
}
fn strs(v: &Value, k: &str) -> Vec<String> {
    v.get(k)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

// ---------- Rahmen, Kopf, Fußzeile ----------

pub(crate) struct FooterInfo {
    pub left: Option<String>,
    pub page: Option<String>,
}

/// Frame: Folie, Satzspiegel (.safe, data-fit) und Fußzeile.
fn frame(cx: &Cx, content: Vec<Div>, footer: Option<&FooterInfo>) -> Div {
    let th = cx.theme;
    let mut safe = col(0.);
    safe.position = Position::Absolute;
    safe.inset = Rect {
        left: pxa(th.m_l),
        right: pxa(th.m_r),
        top: pxa(th.m_t),
        bottom: pxa(th.m_b),
    };
    let safe = Div::new(safe).kids(content).fit("_slide").clip();
    let root = Style {
        display: Display::Block,
        position: Position::Relative,
        ..Style::DEFAULT
    }
    .wh(cx.w, cx.h);
    let mut kids = vec![safe];
    if let Some(f) = footer {
        let mut st = Style {
            justify_content: JustifyContent::SPACE_BETWEEN,
            align_items: AlignItems::CENTER,
            ..row(24.)
        }
        .h(22.);
        st.position = Position::Absolute;
        st.inset = Rect {
            left: pxa(th.m_l),
            right: pxa(th.m_r),
            top: LengthPercentageAuto::auto(),
            bottom: pxa(th.m_foot),
        };
        let mut fk = Vec::new();
        if let Some(left) = &f.left {
            let mut spec = cx.t(Role::Footer, "_footer.title", left);
            spec.nowrap = true;
            let mut s = Style::DEFAULT;
            s.max_size.width = LengthPercentageAuto::percent(0.7);
            fk.push(t_styled(spec, s).clip());
        }
        let mut right = Style {
            align_items: AlignItems::CENTER,
            ..row(16.)
        };
        right.margin.left = LengthPercentageAuto::auto();
        let page = f
            .page
            .as_ref()
            .map(|p| t(cx.t(Role::Footer, "_footer.page", p)));
        fk.push(Div::new(right).kids(page));
        kids.push(Div::new(st).kids(fk));
    }
    Div::new(root).kids(kids)
}

fn eyebrow(cx: &Cx, text: Option<&str>, center: bool) -> Option<Div> {
    let text = text?;
    let mut st = Style {
        align_items: AlignItems::CENTER,
        ..row(12.)
    };
    if center {
        st.justify_content = JustifyContent::CENTER;
    }
    let mut spec = cx.t(Role::Eyebrow, "eyebrow", text);
    spec.center = center;
    Some(Div::new(st).kids([t(spec)]))
}

/// Header: Überzeile + Titel (h1); rule: under zieht die Trennlinie darunter.
fn header(cx: &Cx, c: &Value, max_lines: u32) -> Result<Div, Error> {
    let th = cx.theme;
    let m = th.measure;
    let mut st = col(14.).none();
    if th.rule_under {
        st = st.pad(0., 0., 20., 0.).mb(20.);
        st.border.bottom = px(1.);
    } else {
        st = st.mb(40.).max_w(m);
    }
    let mut title = cx.t(Role::H1, "title", req(c, "title")?);
    title.max_lines = Some(max_lines);
    let mut kids = Vec::new();
    if let Some(mut e) = eyebrow(cx, s(c, "eyebrow"), false) {
        e.style = e.style.max_w(m);
        kids.push(e);
    }
    kids.push(t_styled(title, Style::DEFAULT.max_w(m)));
    let mut d = Div::new(st).kids(kids);
    if th.rule_under {
        d.border = Some(th.border);
    }
    Ok(d)
}

// ---------- Layouts ----------

pub(crate) fn build(
    cx: &Cx,
    layout: &str,
    v: Option<&str>,
    c: &Value,
    footer: Option<&FooterInfo>,
) -> Result<Div, Error> {
    let content = match layout {
        "cover" => cover(cx, c, v)?,
        "bullets" => bullets(cx, c, v)?,
        "two-column" => two_column(cx, c, v)?,
        _ => return Err(Error::UnknownLayout(layout.to_string())),
    };
    let def_footer = LAYOUTS.iter().any(|(id, _, f)| *id == layout && *f);
    Ok(frame(cx, content, footer.filter(|_| def_footer)))
}

fn cover(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Vec<Div>, Error> {
    let th = cx.theme;
    // ohne Foto ist side wie left (layouts.tsx: side = photo && v === 'side')
    let (center, bottom) = (v == Some("center"), v == Some("bottom"));
    let mut main = Style {
        justify_content: if bottom {
            JustifyContent::FLEX_END
        } else {
            JustifyContent::CENTER
        },
        ..col(24.)
    }
    .grow()
    .min_h0()
    .max_w(if bottom { 1100. } else { th.measure });
    if bottom {
        main = main.pad(0., 0., 28., 0.);
    }
    if center {
        main.align_items = AlignItems::CENTER;
        main.margin.left = LengthPercentageAuto::auto();
        main.margin.right = LengthPercentageAuto::auto();
    }
    let mut title = cx.t(Role::Display, "title", req(c, "title")?);
    title.max_lines = Some(3);
    title.center = center;
    if bottom {
        title.size *= 1.15;
        title.lh = 1.02;
    }
    let mut kids: Vec<Div> = eyebrow(cx, s(c, "eyebrow"), center).into_iter().collect();
    kids.push(t(title));
    if let Some(sub) = s(c, "subtitle") {
        let mut spec = cx.t(Role::Body, "subtitle", sub);
        spec.max_lines = Some(2);
        spec.color = th.muted;
        spec.center = center;
        kids.push(t_styled(spec, Style::DEFAULT.max_w(860.)));
    }
    let mut foot = Style {
        align_items: AlignItems::FLEX_END,
        ..row(0.)
    }
    .none()
    .h(28.);
    if center {
        foot.justify_content = JustifyContent::CENTER;
    }
    let meta = s(c, "meta").map(|m| {
        let mut spec = cx.t(Role::Label, "meta", m);
        spec.color = th.muted;
        t(spec)
    });
    Ok(vec![Div::new(col(0.).grow()).kids([
        Div::new(col(0.).none().h(40.)), // cover-top (Logo)
        Div::new(main).kids(kids),
        Div::new(foot).kids(meta),
    ])])
}

fn bullets(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Vec<Div>, Error> {
    let th = cx.theme;
    let items: Vec<&Value> = c
        .get("items")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let n = items.len();
    let sub = items.iter().any(|it| s(it, "sub").is_some());
    let cards = n <= 4 && v == Some("cards");
    let few = !cards && n <= 3;
    let body = cx.fs(Role::Body);
    let mut list = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let b = Some(i as u32);
        let icon = s(it, "icon");
        let icon_box = |mb: f32| {
            icon.map(|name| {
                Div::new(
                    Style {
                        align_items: AlignItems::CENTER,
                        justify_content: JustifyContent::CENTER,
                        ..row(0.)
                    }
                    .none()
                    .wh(40., 40.)
                    .mb(mb),
                )
                .boxel(bx(format!("_ib.{i}"), b, None))
                .kids([Div {
                    kind: Kind::Icon {
                        slot: format!("_icon.{i}"),
                        build: b,
                        name: name.to_string(),
                        color: th.text,
                    },
                    ..Div::new(Style::DEFAULT.none().wh(26., 26.))
                }])
            })
        };
        let mut main = cx.t(
            if cards { Role::H3 } else { Role::Body },
            format!("items.{i}.text"),
            s(it, "text").unwrap_or_default(),
        );
        main.build = b;
        if few {
            main.size *= 1.25;
        }
        if sub {
            main.weight = 700.;
        }
        let mut texts = vec![t(main)];
        if let Some(st) = s(it, "sub") {
            let role = if few {
                Role::Body
            } else if n <= 4 {
                Role::Label
            } else {
                Role::Small
            };
            let mut spec = cx.t(role, format!("items.{i}.sub"), st);
            spec.build = b;
            spec.color = th.muted;
            texts.push(t(spec));
        }
        let mut tst = col(if cards { 8. } else { 4. }).grow().min_w0();
        if sub && (icon.is_some() || cards) {
            tst = tst.pad(1., 0., 0., 0.);
        }
        let text = Div::new(tst).kids(texts);
        if cards {
            let mark = icon_box(18.).unwrap_or_else(|| {
                // el-line: Nummer ohne Kachel, linksbündig
                let mut num = cx.t(Role::Label, format!("_n.{i}"), &(i + 1).to_string());
                num.build = b;
                num.weight = 700.;
                num.family = th.head_family;
                num.color = th.accent;
                num.center = true;
                Div::new(
                    Style {
                        align_items: AlignItems::CENTER,
                        ..row(0.)
                    }
                    .none()
                    .mb(18.),
                )
                .boxel(bx(format!("_ib.{i}"), b, None))
                .kids([t(num)])
            });
            let mut st = col(12.).pad(28., 0., 4., 0.).min_w0().min_h0();
            st.position = Position::Relative;
            list.push(
                Div::new(st)
                    .kids([top_line(1., th.text), mark, text])
                    .boxel(bx(format!("_card.{i}"), b, None))
                    .fit(&format!("_card.{i}"))
                    .clip(),
            );
        } else {
            let mark = icon_box(0.).unwrap_or_else(|| {
                // el-line: Strich 14×2 statt Punkt, mittig zur ersten Zeile
                let k = if few { 1.25 } else { 1. };
                Div::new(
                    Style::DEFAULT
                        .none()
                        .wh(14., 2.)
                        .mt(body * k * 0.69 - 5.)
                        .rel_top(4.),
                )
                .boxel(bx(format!("_dot.{i}"), b, Some(th.accent)))
            });
            let align = if !sub && icon.is_some() {
                AlignItems::CENTER
            } else {
                AlignItems::FLEX_START
            };
            list.push(
                Div::new(Style {
                    align_items: align,
                    ..row(22.)
                })
                .kids([mark, text]),
            );
        }
    }
    let st = if cards {
        Style {
            display: Display::Grid,
            gap: Size {
                width: px(24.),
                height: px(24.),
            },
            grid_template_columns: vec![repeat(n as u16, vec![fr(1.)])],
            grid_auto_rows: vec![minmax(length(260.), auto())],
            align_content: AlignContent::START,
            ..Style::DEFAULT
        }
        .grow()
        .min_h0()
    } else {
        col(if few { 40. } else { 26. })
            .grow()
            .min_h0()
            .max_w(th.measure)
    };
    Ok(vec![
        header(cx, c, 2)?,
        Div::new(st).kids(list).fit("items").clip(),
    ])
}

fn longest_word(texts: &[&str]) -> usize {
    texts
        .iter()
        .flat_map(|t| t.split(|ch: char| ch.is_whitespace() || ch == '-'))
        .map(|w| w.encode_utf16().count())
        .max()
        .unwrap_or(0)
}

fn two_column(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Vec<Div>, Error> {
    let th = cx.theme;
    let empty = Value::Null;
    let side = |k: &str| c.get(k).unwrap_or(&empty);
    let (l, r) = (side("left"), side("right"));
    let len = |s: &str| s.encode_utf16().count();
    // wenig Inhalt je Spalte: größer und luftiger (layouts.tsx TwoColumn)
    let few = cx.w / cx.h >= 1.6
        && longest_word(&[req(l, "heading")?, req(r, "heading")?]) <= 20
        && [l, r].iter().all(|col| {
            let p = strs(col, "points");
            p.len() <= 3 && len(s(col, "text").unwrap_or_default()) + len(&p.concat()) <= 160
        });
    let card_class = matches!(v, Some("equal") | Some("highlight-right"));
    let body = cx.fs(Role::Body);
    let kb = if few { 1.15 } else { 1. };
    let mut cards = Vec::new();
    for (i, (k, colv)) in [("left", l), ("right", r)].into_iter().enumerate() {
        let b = Some(i as u32);
        let hl = v == Some("highlight-right") && k == "right";
        let mut head = cx.t(Role::H2, format!("{k}.heading"), req(colv, "heading")?);
        head.build = b;
        if few {
            head.size *= 1.3;
        }
        if hl {
            head.color = th.accent;
        }
        let mut kids = vec![
            top_line(
                if hl { 2. } else { 1. },
                if hl { th.accent } else { th.text },
            ),
            t(head),
        ];
        if let Some(text) = s(colv, "text") {
            let mut spec = cx.t(Role::Body, format!("{k}.text"), text);
            spec.build = b;
            spec.size *= kb;
            kids.push(t(spec));
        }
        let points = strs(colv, "points");
        if !points.is_empty() {
            let rows = points.iter().enumerate().map(|(j, p)| {
                let base = format!("{k}.points");
                let dot = Div::new(
                    Style::DEFAULT
                        .none()
                        .wh(14., 2.)
                        .mt(body * kb * 0.69 - 4.)
                        .rel_top(3.),
                )
                .boxel(bx(format!("_pd.{base}.{j}"), b, Some(th.accent)));
                let mut spec = cx.t(Role::Body, format!("{base}.{j}"), p);
                spec.build = b;
                spec.size *= kb;
                Div::new(Style {
                    align_items: AlignItems::FLEX_START,
                    ..row(14.)
                })
                .kids([dot, t_styled(spec, Style::DEFAULT.grow())])
            });
            kids.push(Div::new(col(if few { 20. } else { 10. })).kids(rows));
        }
        let mut st = col(if few { 22. } else { 14. }).pad(if few { 36. } else { 28. }, 0., 4., 0.);
        st.position = Position::Relative;
        if card_class {
            st = st.min_w0().min_h0();
        }
        let mut card = Div::new(st)
            .kids(kids)
            .boxel(bx(format!("_card.{k}"), b, None))
            .fit(&format!("_card.{k}"));
        if card_class {
            card = card.clip();
        }
        cards.push(card);
    }
    let st = Style {
        display: Display::Grid,
        gap: Size {
            width: px(28.),
            height: px(28.),
        },
        grid_template_columns: vec![fr(1.), fr(1.)],
        grid_auto_rows: vec![minmax(length(0.), auto())],
        align_content: AlignContent::START,
        ..Style::DEFAULT
    }
    .grow()
    .min_h0();
    Ok(vec![header(cx, c, 2)?, Div::new(st).kids(cards)])
}
