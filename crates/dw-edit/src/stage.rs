//! Stage-Logik ohne GUI (Stage.tsx:202-266, :622-643): Hit-Test mit Rotation, Rahmenauswahl, Einrasten,
//! Griffe für Größe und Drehung (auch per Tastatur), Zoom und Pan. Folienkoordinaten in px.

use dw_model::{El, Item};
use kurbo::{Affine, Point, Rect, Vec2};

/// Einrasten in Bildschirm-px (Stage.tsx `SNAP`)
pub const SNAP: f64 = 6.;
/// Abstand des Drehgriffs über der Oberkante, Bildschirm-px
pub const ROT_HANDLE: f64 = 24.;
/// Trefferradius eines Griffs, Bildschirm-px
pub const HANDLE_R: f64 = 6.;
const MIN_SIZE: f64 = 8.;

/// Position, Größe, Drehung (Grad im Uhrzeigersinn um die Mitte, wie CSS `rotate`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Geo {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rot: f64,
}

impl Geo {
    pub fn of_item(it: &Item) -> Geo {
        Geo {
            x: it.x,
            y: it.y,
            w: it.w,
            h: it.h,
            rot: it.rot.unwrap_or(0.),
        }
    }

    pub fn of_el(e: &El) -> Geo {
        let b = e.base();
        Geo {
            x: b.bbox.x,
            y: b.bbox.y,
            w: b.bbox.w,
            h: b.bbox.h,
            rot: b.rot.unwrap_or(0.),
        }
    }

    pub fn center(&self) -> Point {
        Point::new(self.x + self.w / 2., self.y + self.h / 2.)
    }

    /// Box-lokal (0..w, 0..h) → Folie
    pub fn to_slide(&self) -> Affine {
        Affine::translate(self.center().to_vec2())
            * Affine::rotate(self.rot.to_radians())
            * Affine::translate((-self.w / 2., -self.h / 2.))
    }

    pub fn contains(&self, p: Point) -> bool {
        let l = self.to_slide().inverse() * p;
        l.x >= 0. && l.x <= self.w && l.y >= 0. && l.y <= self.h
    }

    /// Achsenparalleles Hüllrechteck (gedreht)
    pub fn bounds(&self) -> Rect {
        self.to_slide()
            .transform_rect_bbox(Rect::new(0., 0., self.w, self.h))
    }

    pub fn rect(&self) -> Rect {
        Rect::new(self.x, self.y, self.x + self.w, self.y + self.h)
    }
}

fn rot_v(v: Vec2, deg: f64) -> Vec2 {
    let (s, c) = deg.to_radians().sin_cos();
    Vec2::new(v.x * c - v.y * s, v.x * s + v.y * c)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hit {
    /// Index in `items` (freie Elemente liegen oben)
    Item(usize),
    /// Index in `Measured.els`
    El(usize),
}

/// Treffer unter dem Punkt: oberstes freies Element (zuletzt gezeichnet), sonst das kleinste Layout-Element
/// mit Slot (das spezifischste). Gesperrte Items treffen, sind aber nicht verschiebbar (Aufrufer).
pub fn hit(els: &[El], items: &[Item], p: Point) -> Option<Hit> {
    if let Some(i) = items.iter().rposition(|it| Geo::of_item(it).contains(p)) {
        return Some(Hit::Item(i));
    }
    els.iter()
        .enumerate()
        .filter(|(_, e)| !e.base().slot.is_empty() && Geo::of_el(e).contains(p))
        .min_by(|(_, a), (_, b)| {
            let area = |e: &El| e.base().bbox.w * e.base().bbox.h;
            area(a).total_cmp(&area(b))
        })
        .map(|(i, _)| Hit::El(i))
}

/// Rahmenauswahl: alle nicht gesperrten Items, deren (gedrehte) Hülle das Rechteck schneidet.
pub fn marquee(items: &[Item], r: Rect) -> Vec<usize> {
    let locked = |it: &Item| {
        it.extra
            .get("locked")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    };
    items
        .iter()
        .enumerate()
        .filter(|(_, it)| !locked(it) && Geo::of_item(it).bounds().overlaps(r))
        .map(|(i, _)| i)
        .collect()
}

/// Ergebnis des Einrastens: Verschiebung und die Hilfslinien, an denen eingerastet wurde.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapped {
    pub dx: f64,
    pub dy: f64,
    pub guide_x: Option<f64>,
    pub guide_y: Option<f64>,
}

/// Einrasten der Box `b` an Folienrand/-mitte, eigenen Hilfslinien und Kanten/Mitten der anderen Boxen.
/// `zoom` = Bildschirm-px je Folien-px (die Schwelle gilt am Bildschirm).
pub fn snap(
    b: Rect,
    others: &[Rect],
    guides: (&[f64], &[f64]),
    slide: (f64, f64),
    zoom: f64,
) -> Snapped {
    let mut xs = vec![0., slide.0 / 2., slide.0];
    let mut ys = vec![0., slide.1 / 2., slide.1];
    xs.extend_from_slice(guides.0);
    ys.extend_from_slice(guides.1);
    for o in others {
        xs.extend([o.x0, o.center().x, o.x1]);
        ys.extend([o.y0, o.center().y, o.y1]);
    }
    let best = |edges: [f64; 3], cands: &[f64]| {
        let mut out: Option<(f64, f64)> = None;
        for e in edges {
            for &c in cands {
                let d = c - e;
                if d.abs() <= SNAP / zoom && out.is_none_or(|(od, _)| d.abs() < od.abs()) {
                    out = Some((d, c));
                }
            }
        }
        out
    };
    let sx = best([b.x0, b.center().x, b.x1], &xs);
    let sy = best([b.y0, b.center().y, b.y1], &ys);
    Snapped {
        dx: sx.map_or(0., |s| s.0),
        dy: sy.map_or(0., |s| s.0),
        guide_x: sx.map(|s| s.1),
        guide_y: sy.map(|s| s.1),
    }
}

/// Griff: Größe (hx, hy ∈ {-1, 0, 1}) oder Drehen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handle {
    Resize(i8, i8),
    Rotate,
}

/// Reihenfolge wie Stage.tsx `HANDLES`
pub const RESIZE_HANDLES: [(i8, i8); 8] = [
    (-1, -1),
    (0, -1),
    (1, -1),
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
];

/// Griffe mit Position auf der Folie (gedreht); der Drehgriff sitzt über der Mitte der Oberkante.
pub fn handles(g: &Geo, zoom: f64) -> Vec<(Handle, Point)> {
    let t = g.to_slide();
    let mut out: Vec<(Handle, Point)> = RESIZE_HANDLES
        .iter()
        .map(|&(hx, hy)| {
            let p = Point::new(
                (f64::from(hx) + 1.) / 2. * g.w,
                (f64::from(hy) + 1.) / 2. * g.h,
            );
            (Handle::Resize(hx, hy), t * p)
        })
        .collect();
    out.push((Handle::Rotate, t * Point::new(g.w / 2., -ROT_HANDLE / zoom)));
    out
}

pub fn hit_handle(g: &Geo, p: Point, zoom: f64) -> Option<Handle> {
    handles(g, zoom)
        .into_iter()
        .filter(|(_, q)| q.distance(p) * zoom <= HANDLE_R)
        .min_by(|a, b| a.1.distance(p).total_cmp(&b.1.distance(p)))
        .map(|(h, _)| h)
}

/// Größe ändern um (dx, dy) Folien-px am Griff (hx, hy); der gegenüberliegende Griff bleibt stehen, auch gedreht.
/// `proportional`: Ecken behalten das Seitenverhältnis (Stage.tsx: Bilder/Icons/Text, Umschalt kehrt um).
pub fn resize(g: &Geo, hx: i8, hy: i8, d: Vec2, proportional: bool) -> Geo {
    let (hx, hy) = (f64::from(hx), f64::from(hy));
    let l = rot_v(d, -g.rot);
    let mut nw = (g.w + hx * l.x).max(MIN_SIZE);
    let mut nh = (g.h + hy * l.y).max(MIN_SIZE);
    if proportional && hx != 0. && hy != 0. {
        // Box ohne Fläche: Seitenverhältnis von der Mindestgröße
        let (w0, h0) = (g.w.max(MIN_SIZE), g.h.max(MIN_SIZE));
        let f = (nw / w0).max(nh / h0);
        nw = w0 * f;
        nh = h0 * f;
    }
    let c = rot_v(Vec2::new(hx * (nw - g.w) / 2., hy * (nh - g.h) / 2.), g.rot);
    Geo {
        x: (g.x + g.w / 2. + c.x - nw / 2.).round(),
        y: (g.y + g.h / 2. + c.y - nh / 2.).round(),
        w: nw.round(),
        h: nh.round(),
        rot: g.rot,
    }
}

/// Drehen zum Zeigerpunkt; `step15` (Umschalt) rastet in 15°-Schritten, sonst ±4° an 90°-Vielfachen.
pub fn rotate_to(g: &Geo, p: Point, step15: bool) -> Geo {
    let c = g.center();
    let mut a = (p.y - c.y).atan2(p.x - c.x).to_degrees() + 90.;
    a = if step15 {
        (a / 15.).round() * 15.
    } else if (a - (a / 90.).round() * 90.).abs() < 4. {
        (a / 90.).round() * 90.
    } else {
        a.round()
    };
    Geo {
        rot: norm_deg(a),
        ..*g
    }
}

/// Winkel auf -180..180
pub fn norm_deg(a: f64) -> f64 {
    (a + 540.).rem_euclid(360.) - 180.
}

/// Tastatur (neu): Pfeiltaste am gewählten Griff. Größe: `step` px nach außen (positiv) bzw. innen;
/// Drehgriff: `step` Grad. Ein Tastendruck = eine Änderung, damit Undo pro Taste greift.
pub fn key_handle(g: &Geo, h: Handle, step: f64) -> Geo {
    match h {
        Handle::Rotate => Geo {
            rot: norm_deg(g.rot + step),
            ..*g
        },
        Handle::Resize(hx, hy) => {
            // Schritt in Griffrichtung (lokal), dann in Folienkoordinaten wie ein Zug mit der Maus
            let local = Vec2::new(f64::from(hx) * step, f64::from(hy) * step);
            resize(g, hx, hy, rot_v(local, g.rot), false)
        }
    }
}

/// Pfeiltasten wählen den Griff reihum (Tab-Ersatz im Griff-Modus).
pub fn next_handle(h: Option<Handle>) -> Handle {
    let all: Vec<Handle> = RESIZE_HANDLES
        .iter()
        .map(|&(x, y)| Handle::Resize(x, y))
        .chain([Handle::Rotate])
        .collect();
    match h.and_then(|h| all.iter().position(|&a| a == h)) {
        Some(i) => all[(i + 1) % all.len()],
        None => all[0],
    }
}

/// Zoom und Pan: Bildschirm = zoom · Folie + pan.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    pub zoom: f64,
    pub pan: Vec2,
}

impl View {
    pub const MIN: f64 = 0.25;
    pub const MAX: f64 = 3.;

    /// Folie mittig eingepasst in die Stage
    pub fn fit(stage: (f64, f64), slide: (f64, f64)) -> View {
        // leere Stage/Folie (Fenster noch nicht gelayoutet): kein NaN/∞
        let slide = (slide.0.max(1.), slide.1.max(1.));
        let z = (stage.0.max(1.) / slide.0)
            .min(stage.1.max(1.) / slide.1)
            .clamp(1e-3, Self::MAX);
        View {
            zoom: z,
            pan: Vec2::new((stage.0 - slide.0 * z) / 2., (stage.1 - slide.1 * z) / 2.),
        }
    }

    pub fn transform(&self) -> Affine {
        Affine::translate(self.pan) * Affine::scale(self.zoom)
    }

    pub fn to_slide(&self, screen: Point) -> Point {
        Point::new(
            (screen.x - self.pan.x) / self.zoom,
            (screen.y - self.pan.y) / self.zoom,
        )
    }

    pub fn to_screen(&self, slide: Point) -> Point {
        self.transform() * slide
    }

    /// Zoomen um `factor`, der Punkt unter `screen` bleibt stehen (Mausrad).
    pub fn zoom_at(&mut self, factor: f64, screen: Point) {
        let p = self.to_slide(screen);
        self.zoom = (self.zoom * factor).clamp(Self::MIN, Self::MAX);
        self.pan = screen.to_vec2() - p.to_vec2() * self.zoom;
    }

    pub fn pan_by(&mut self, d: Vec2) {
        self.pan += d;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: &str, x: f64, y: f64, w: f64, h: f64, rot: f64) -> Item {
        serde_json::from_value(
            json!({"id": id, "kind": "shape", "x": x, "y": y, "w": w, "h": h, "rot": rot}),
        )
        .unwrap()
    }

    fn el(slot: &str, x: f64, y: f64, w: f64, h: f64) -> El {
        serde_json::from_value(json!({
            "kind": "text", "slot": slot, "box": {"x": x, "y": y, "w": w, "h": h},
            "font": "body", "role": "body", "sizePx": 20, "lineHeightPx": 24, "trackingPx": 0,
            "align": "left", "upper": false, "runs": [], "lines": 1, "bg": "#fff"
        }))
        .unwrap()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn hit_with_rotation_and_order() {
        // 200×20 um 90° gedreht: steht senkrecht um die Mitte (200, 110)
        let items = vec![
            item("a", 100., 100., 200., 20., 90.),
            item("b", 0., 0., 50., 50., 0.),
        ];
        assert_eq!(hit(&[], &items, Point::new(200., 30.)), Some(Hit::Item(0)));
        assert_eq!(
            hit(&[], &items, Point::new(120., 110.)),
            None,
            "ungedreht wäre das ein Treffer"
        );
        assert_eq!(hit(&[], &items, Point::new(10., 10.)), Some(Hit::Item(1)));
        // oberstes zuerst
        let items = vec![
            item("a", 0., 0., 100., 100., 0.),
            item("b", 50., 50., 100., 100., 0.),
        ];
        assert_eq!(hit(&[], &items, Point::new(60., 60.)), Some(Hit::Item(1)));
        // Layout-Elemente: das kleinste, ohne leeren Slot; Items gehen vor
        let els = vec![
            el("title", 0., 0., 500., 300.),
            el("items.0.text", 100., 100., 50., 20.),
            el("", 0., 0., 10., 10.),
        ];
        assert_eq!(hit(&els, &[], Point::new(110., 110.)), Some(Hit::El(1)));
        assert_eq!(hit(&els, &[], Point::new(5., 5.)), Some(Hit::El(0)));
        assert_eq!(
            hit(&els, &[item("x", 0., 0., 20., 20., 0.)], Point::new(5., 5.)),
            Some(Hit::Item(0))
        );
    }

    #[test]
    fn marquee_selects_overlap_skips_locked() {
        let mut items = vec![
            item("a", 0., 0., 50., 50., 0.),
            item("b", 200., 200., 50., 50., 0.),
            item("c", 10., 10., 10., 10., 0.),
            item("d", 300., 0., 100., 10., 90.),
        ];
        items[2].extra.insert("locked".into(), json!(true));
        assert_eq!(marquee(&items, Rect::new(40., 40., 210., 210.)), vec![0, 1]);
        // d gedreht reicht bis y = 50
        assert_eq!(marquee(&items, Rect::new(340., 40., 360., 60.)), vec![3]);
    }

    #[test]
    fn snapping() {
        // Kante 3 px neben der Folienmitte, Zoom 1 → rastet
        let s = snap(
            Rect::new(643., 10., 700., 50.),
            &[],
            (&[], &[]),
            (1280., 720.),
            1.,
        );
        assert_eq!((s.dx, s.guide_x), (-3., Some(640.)));
        assert_eq!((s.dy, s.guide_y), (0., None));
        // bei Zoom 0,25 ist die Schwelle 24 Folien-px
        let s = snap(
            Rect::new(660., 10., 700., 50.),
            &[],
            (&[], &[]),
            (1280., 720.),
            0.25,
        );
        assert_eq!(s.dx, -20.);
        // an der Mitte einer anderen Box, nächster Kandidat gewinnt
        let o = Rect::new(100., 400., 300., 500.);
        let s = snap(
            Rect::new(150., 300., 301., 349.),
            &[o],
            (&[], &[]),
            (1280., 720.),
            1.,
        );
        assert_eq!((s.dx, s.guide_x), (-1., Some(300.)));
        assert_eq!((s.dy, s.guide_y), (0., None));
        let s = snap(
            Rect::new(20., 20., 60., 60.),
            &[],
            (&[57.], &[]),
            (1280., 720.),
            1.,
        );
        assert_eq!((s.dx, s.guide_x), (-3., Some(57.)));
        // weiter als 6 px: nichts
        assert_eq!(
            snap(
                Rect::new(500., 300., 540., 330.),
                &[],
                (&[], &[]),
                (1280., 720.),
                1.
            ),
            Snapped::default()
        );
    }

    #[test]
    fn resize_keeps_opposite_corner() {
        let g = Geo {
            x: 100.,
            y: 100.,
            w: 100.,
            h: 50.,
            rot: 0.,
        };
        let r = resize(&g, 1, 1, Vec2::new(20., 10.), false);
        assert_eq!((r.x, r.y, r.w, r.h), (100., 100., 120., 60.));
        let r = resize(&g, -1, 0, Vec2::new(20., 99.), false);
        assert_eq!((r.x, r.y, r.w, r.h), (120., 100., 80., 50.));
        let r = resize(&g, 1, 1, Vec2::new(100., 0.), true);
        assert_eq!((r.w, r.h), (200., 100.));
        let r = resize(&g, 1, 0, Vec2::new(-500., 0.), false);
        assert_eq!(r.w, MIN_SIZE);
        // gedreht: die linke obere Ecke (gedreht) bleibt, wenn rechts unten gezogen wird
        let g = Geo {
            x: 100.,
            y: 100.,
            w: 100.,
            h: 50.,
            rot: 30.,
        };
        let anchor = g.to_slide() * Point::new(0., 0.);
        let r = resize(&g, 1, 1, rot_v(Vec2::new(40., 20.), 30.), false);
        let a2 = r.to_slide() * Point::new(0., 0.);
        assert!(anchor.distance(a2) < 1.5, "{anchor:?} {a2:?}");
        assert_eq!((r.w, r.h), (140., 70.));
    }

    #[test]
    fn rotation_handle_and_snap() {
        let g = Geo {
            x: 0.,
            y: 0.,
            w: 100.,
            h: 100.,
            rot: 0.,
        };
        assert_eq!(rotate_to(&g, Point::new(50., -100.), false).rot, 0.);
        assert_eq!(
            rotate_to(&g, Point::new(200., 52.), false).rot,
            90.,
            "rastet an 90°"
        );
        assert_eq!(
            rotate_to(&g, Point::new(200., 80.), true)
                .rot
                .rem_euclid(15.),
            0.
        );
        assert_eq!(rotate_to(&g, Point::new(50., 200.), false).rot.abs(), 180.);
        let hs = handles(&g, 1.);
        assert_eq!(hs.len(), 9);
        assert_eq!(
            hit_handle(&g, Point::new(101., 99.), 1.),
            Some(Handle::Resize(1, 1))
        );
        assert_eq!(
            hit_handle(&g, Point::new(50., -24.), 1.),
            Some(Handle::Rotate)
        );
        assert_eq!(hit_handle(&g, Point::new(50., 50.), 1.), None);
        // gedrehte Griffe liegen auf dem gedrehten Rahmen
        let g = Geo { rot: 90., ..g };
        let (_, p) = handles(&g, 1.)[0];
        assert!(close(p.x, 100.) && close(p.y, 0.), "{p:?}");
    }

    #[test]
    fn keyboard_handles() {
        let g = Geo {
            x: 100.,
            y: 100.,
            w: 100.,
            h: 50.,
            rot: 0.,
        };
        let r = key_handle(&g, Handle::Resize(1, 0), 10.);
        assert_eq!((r.x, r.w), (100., 110.));
        let r = key_handle(&g, Handle::Resize(-1, -1), 10.);
        assert_eq!((r.x, r.y, r.w, r.h), (90., 90., 110., 60.));
        let r = key_handle(&g, Handle::Resize(0, 1), -10.);
        assert_eq!(r.h, 40.);
        assert_eq!(key_handle(&g, Handle::Rotate, 15.).rot, 15.);
        assert_eq!(
            key_handle(&Geo { rot: 175., ..g }, Handle::Rotate, 15.).rot,
            -170.
        );
        // gedreht wächst die Box entlang ihrer eigenen Achse
        let g = Geo { rot: 90., ..g };
        let r = key_handle(&g, Handle::Resize(1, 0), 10.);
        assert_eq!((r.w, r.h), (110., 50.));
        let mut h = None;
        for _ in 0..9 {
            h = Some(next_handle(h));
        }
        assert_eq!(h, Some(Handle::Rotate));
        assert_eq!(next_handle(h), Handle::Resize(-1, -1));
    }

    #[test]
    fn zoom_and_pan() {
        let v = View::fit((800., 600.), (1280., 720.));
        assert_eq!(v.zoom, 0.625);
        assert_eq!(v.pan, Vec2::new(0., 75.));
        assert_eq!(v.to_slide(Point::new(400., 300.)), Point::new(640., 360.));
        let mut v = v;
        let anchor = Point::new(123., 456.);
        let before = v.to_slide(anchor);
        v.zoom_at(2., anchor);
        assert_eq!(v.zoom, 1.25);
        let after = v.to_slide(anchor);
        assert!(close(before.x, after.x) && close(before.y, after.y));
        v.zoom_at(100., anchor);
        assert_eq!(v.zoom, View::MAX);
        v.pan_by(Vec2::new(10., -5.));
        let p = Point::new(10., 20.);
        let q = v.to_slide(v.to_screen(p));
        assert!(close(p.x, q.x) && close(p.y, q.y));
    }

    #[test]
    fn degenerate_sizes() {
        let v = View::fit((0., 0.), (0., 720.));
        assert!(v.zoom.is_finite() && v.zoom > 0. && v.pan.x.is_finite());
        let g = Geo {
            x: 0.,
            y: 0.,
            w: 0.,
            h: 0.,
            rot: 0.,
        };
        let r = resize(&g, 1, 1, Vec2::new(10., 10.), true);
        assert!(
            r.w.is_finite() && r.h.is_finite() && r.w >= MIN_SIZE && r.h >= MIN_SIZE,
            "{r:?}"
        );
    }
}
