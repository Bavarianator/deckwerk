//! Theme-Werte, die slide.css/layouts-extra.css als CSS-Variablen beziehen (themeVars in slide.tsx), plus Typo-Skala und Autofit-Größen.

use dw_model::Profile;

use crate::{
    Elements, FontRef, Leading, Measure, Rgb, Rule, SigColor, SigKind, SigLength, Theme, Tone,
    ensure_contrast, margins_of, mix,
};

/// Textrollen wie `SCALE` in themes.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Hero,
    Display,
    Statement,
    H1,
    Kpi,
    H2,
    H3,
    Body,
    Label,
    Small,
    Eyebrow,
    Footer,
}

/// Autofit-Stufen je Rolle in px auf der 1280er-Folie; Stufe 0 = Wunschgröße.
pub const SCALE: [(Role, [f64; 4]); 12] = [
    (Role::Hero, [200., 170., 144., 120.]),
    (Role::Display, [76., 66., 58., 50.]),
    (Role::Statement, [50., 44., 38., 33.]),
    (Role::H1, [42., 38., 34., 30.]),
    (Role::Kpi, [72., 62., 54., 46.]),
    (Role::H2, [26., 24., 22., 20.]),
    (Role::H3, [22., 20., 18., 17.]),
    (Role::Body, [24., 22., 20., 19.]),
    (Role::Label, [19., 18., 17., 16.]),
    (Role::Small, [17., 16., 15., 14.]),
    (Role::Eyebrow, [14., 14., 13., 13.]),
    (Role::Footer, [13., 13., 13., 13.]),
];

/// Rollen, die der Titelstufe des Autofits folgen.
pub const HEAD_ROLES: [Role; 5] = [
    Role::Hero,
    Role::Display,
    Role::Statement,
    Role::H1,
    Role::Kpi,
];

impl Role {
    pub const ALL: [Role; 12] = [
        Role::Hero,
        Role::Display,
        Role::Statement,
        Role::H1,
        Role::Kpi,
        Role::H2,
        Role::H3,
        Role::Body,
        Role::Label,
        Role::Small,
        Role::Eyebrow,
        Role::Footer,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Role::Hero => "hero",
            Role::Display => "display",
            Role::Statement => "statement",
            Role::H1 => "h1",
            Role::Kpi => "kpi",
            Role::H2 => "h2",
            Role::H3 => "h3",
            Role::Body => "body",
            Role::Label => "label",
            Role::Small => "small",
            Role::Eyebrow => "eyebrow",
            Role::Footer => "footer",
        }
    }

    pub fn from_name(s: &str) -> Option<Role> {
        Role::ALL.into_iter().find(|r| r.name() == s)
    }

    pub fn scale(self) -> [f64; 4] {
        SCALE[self as usize].1
    }

    /// HEAD_ROLES
    pub fn head_step(self) -> bool {
        HEAD_ROLES.contains(&self)
    }

    /// Titelschrift: zusätzlich h2/h3.
    pub fn head_font(self) -> bool {
        self.head_step() || matches!(self, Role::H2 | Role::H3)
    }

    /// line-height-Grundwert (slide.css .r-*), vor dem Leading-Faktor.
    pub fn line_height(self) -> f64 {
        match self {
            Role::Hero => 0.95,
            Role::Display => 1.06,
            Role::Statement => 1.16,
            Role::H1 => 1.14,
            Role::Kpi => 1.05,
            Role::H2 => 1.22,
            Role::H3 => 1.24,
            Role::Body => 1.38,
            Role::Label => 1.32,
            Role::Small => 1.42,
            Role::Eyebrow | Role::Footer => 1.2,
        }
    }
}

/// Schriftfaktor je Format (applySteps, measure.ts): Social nach Handybreite, Druck höchstens 0,65.
pub fn font_factor(profile: Profile, width: f64) -> f64 {
    match profile {
        Profile::Social => width / 750.,
        Profile::Doc => (width / 1221.).min(0.65),
        Profile::Slides => 1.,
    }
}

/// --fs-<role> für eine Autofit-Stufe: gerundet, verkleinert nie unter 12 px.
pub fn fs(role: Role, head: usize, body: usize, k: f64) -> f64 {
    let step = if role.head_step() { head } else { body };
    (role.scale()[step.min(3)] * k)
        .round()
        .max(if k < 1. { 12. } else { 0. })
}

/// --head-fit: Plakat-Titel und offener Zeilenabstand geben pro Titelstufe nach (1 → 0).
pub fn head_fit(head: usize) -> f64 {
    1. - head.min(3) as f64 / 3.
}

/// CSS-Variablen eines (getönten) Themes für eine Foliengröße.
#[derive(Debug, Clone, PartialEq)]
pub struct Tokens {
    pub bg: Rgb,
    pub surface: Rgb,
    pub surface2: Rgb,
    pub text: Rgb,
    pub muted: Rgb,
    pub accent: Rgb,
    pub accent2: Rgb,
    pub on_accent: Rgb,
    pub border: Rgb,
    pub good: Rgb,
    pub bad: Rgb,
    pub accent_tint: Rgb,
    pub fill: Rgb,
    pub on_accent_soft: Rgb,
    pub font_head: FontRef,
    pub font_body: FontRef,
    /// --font-label; None = Textschrift
    pub font_label: Option<FontRef>,
    pub head_weight: u16,
    /// em
    pub head_tracking: f64,
    pub radius: f64,
    pub head_scale: f64,
    /// --lh / --lh-head
    pub lh: f64,
    pub lh_head: f64,
    /// --measure: None = Fallback des Selektors (1000/1100/980 px), INFINITY = unbegrenzt
    pub measure: Option<f64>,
    /// --m-l/-r/-t/-b/-foot
    pub m_l: f64,
    pub m_r: f64,
    pub m_t: f64,
    pub m_b: f64,
    pub m_foot: f64,
    /// Signatur rule färbt die Kopflinie: --rule-c, --rule-s, --rule-w (None = volle Breite)
    pub rule_c: Option<Rgb>,
    pub rule_s: Option<f64>,
    pub rule_w: Option<f64>,
    /// edge/passepartout: --sig-c, --sig-s
    pub sig_c: Option<Rgb>,
    pub sig_s: Option<f64>,
    // Klassen am .slide
    pub dark: bool,
    pub elements: Elements,
    pub rule: Option<Rule>,
    pub sub_body: bool,
    pub lab_caps: bool,
}

impl Tokens {
    /// themeVars(t, size)
    pub fn new(t: &Theme, w: f64, h: f64) -> Tokens {
        let c = &t.c;
        let fill = c.fill.unwrap_or(c.accent);
        let (lh, lh_head) = match t.leading {
            Some(Leading::Tight) => (0.92, 0.96),
            Some(Leading::Open) => (1.1, 1.04),
            _ => (1., 1.),
        };
        let measure = match t.measure {
            Some(m) if m != Measure::Standard && w / h > 1.2 => Some(if m == Measure::Narrow {
                760.
            } else {
                f64::INFINITY
            }),
            _ => None,
        };
        let sig = t.signature.as_ref().filter(|s| s.kind != SigKind::None);
        let pp = sig.is_some_and(|s| s.kind == SigKind::Passepartout);
        // ohne Token gelten die CSS-Fallbacks = Standardränder
        let m = margins_of(t.margin, w, h);
        let mut k = Tokens {
            bg: c.bg,
            surface: c.surface,
            surface2: c.surface2,
            text: c.text,
            muted: c.muted,
            accent: c.accent,
            accent2: c.accent2,
            on_accent: c.on_accent,
            border: c.border,
            good: c.good,
            bad: c.bad,
            accent_tint: if t.tone == Some(Tone::Accent) {
                c.surface2
            } else {
                mix(c.bg, c.accent, if t.dark { 0.22 } else { 0.1 })
            },
            fill,
            on_accent_soft: ensure_contrast(mix(fill, c.on_accent, 0.85), fill, 4.6),
            font_head: t.head.font.clone(),
            font_body: t.body.clone(),
            font_label: t.mono.clone(),
            head_weight: t.head.weight,
            head_tracking: t.head.tracking,
            radius: t.radius,
            head_scale: t.head_scale.unwrap_or(1.),
            lh,
            lh_head,
            measure,
            m_l: m.l,
            m_r: m.r,
            m_t: m.t,
            m_b: m.b,
            m_foot: m.foot + if pp { 12. } else { 0. }, // Fußzeile innerhalb des Rahmens
            rule_c: None,
            rule_s: None,
            rule_w: None,
            sig_c: None,
            sig_s: None,
            dark: t.dark,
            elements: t.elements.unwrap_or(Elements::Line),
            // Signatur rule ist die Kopflinie über dem Titel, nie zusätzlich (Frame in slide.tsx)
            rule: if sig.is_some_and(|s| s.kind == SigKind::Rule) {
                Some(Rule::Over)
            } else {
                t.rule
            },
            sub_body: t.sub_body,
            lab_caps: t.labels == Some(crate::Labels::Caps),
        };
        if let Some(s) = sig {
            let edge = s.kind == SigKind::Edge;
            // Kante bis 24 px; Linie und Rahmen bis 8 px
            let def = if edge {
                12.
            } else if s.kind == SigKind::Rule {
                2.
            } else {
                1.
            };
            let size = s
                .size
                .unwrap_or(def)
                .max(1.)
                .min(if edge { 24. } else { 8. });
            let color = match s.color.unwrap_or(if edge {
                SigColor::Accent
            } else {
                SigColor::Text
            }) {
                SigColor::Field => fill,
                SigColor::Accent => c.accent,
                SigColor::Text => c.text,
            };
            if s.kind == SigKind::Rule {
                k.rule_c = Some(color);
                k.rule_s = Some(size);
                k.rule_w = (s.length != Some(SigLength::Full)).then_some(64.);
            } else {
                k.sig_c = Some(color);
                k.sig_s = Some(size);
            }
        }
        k
    }

    /// --hs: Plakat-Titel-Faktor bei Titelstufe `head`.
    pub fn hs(&self, head: usize) -> f64 {
        1. + (self.head_scale - 1.) * head_fit(head)
    }

    /// Endgültige Schriftgröße in px wie .r-*: --fs-* × --hs (display/statement) bzw. × min(--hs, 1,25) (h1).
    pub fn font_size(&self, role: Role, head: usize, body: usize, k: f64) -> f64 {
        let f = fs(role, head, body, k);
        match role {
            Role::Display | Role::Statement => f * self.hs(head),
            Role::H1 => f * self.hs(head).min(1.25),
            _ => f,
        }
    }

    /// line-height als Faktor der Schriftgröße inkl. Leading (--lhf/--lhf-head).
    pub fn line_height(&self, role: Role, head: usize) -> f64 {
        let lhf = |lh: f64| lh.min(1.) + (lh - 1.).max(0.) * head_fit(head);
        role.line_height()
            * match role {
                Role::Display | Role::Statement | Role::H1 | Role::H2 | Role::H3 => {
                    lhf(self.lh_head)
                }
                Role::Body | Role::Label | Role::Small => lhf(self.lh),
                _ => 1.,
            }
    }

    /// letter-spacing in em je Rolle (slide.css; sub-body und lab-caps eingerechnet).
    pub fn tracking_em(&self, role: Role, head: usize) -> f64 {
        let t = self.head_tracking;
        match role {
            Role::Hero => -0.04,
            Role::Kpi => -0.03,
            Role::Display | Role::Statement => t - 0.005 - (self.hs(head) - 1.) * 0.04,
            Role::H1 => t,
            Role::H2 | Role::H3 if self.sub_body => -0.01,
            Role::H2 | Role::H3 => t / 2.,
            Role::Eyebrow | Role::Footer if self.lab_caps => 0.08,
            Role::Eyebrow => 0.01,
            Role::Footer => 0.02,
            _ => 0.,
        }
    }

    /// Schrift einer Rolle (Titel, Text, Label).
    pub fn font(&self, role: Role) -> &FontRef {
        match role {
            Role::H2 | Role::H3 if self.sub_body => &self.font_body,
            r if r.head_font() => &self.font_head,
            Role::Eyebrow | Role::Footer => self.font_label.as_ref().unwrap_or(&self.font_body),
            _ => &self.font_body,
        }
    }

    /// font-weight einer Rolle.
    pub fn weight(&self, role: Role) -> u16 {
        match role {
            Role::H2 | Role::H3 if self.sub_body => 700,
            r if r.head_font() => self.head_weight,
            Role::Eyebrow => 700,
            _ => 400,
        }
    }
}
