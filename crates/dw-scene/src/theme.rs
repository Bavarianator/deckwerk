//! Theme-Tokens statt CSS-Variablen (themes.ts, themeVars in slide.tsx). Im Spike nur „beratung“.

use dw_color::{Rgb, ensure_contrast};
use dw_model::Profile;

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

impl Role {
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

    /// px auf der 1280er-Folie je Autofit-Stufe (themes.ts:70).
    fn scale(self) -> [f32; 4] {
        match self {
            Role::Hero => [200., 170., 144., 120.],
            Role::Display => [76., 66., 58., 50.],
            Role::Statement => [50., 44., 38., 33.],
            Role::H1 => [42., 38., 34., 30.],
            Role::Kpi => [72., 62., 54., 46.],
            Role::H2 => [26., 24., 22., 20.],
            Role::H3 => [22., 20., 18., 17.],
            Role::Body => [24., 22., 20., 19.],
            Role::Label => [19., 18., 17., 16.],
            Role::Small => [17., 16., 15., 14.],
            Role::Eyebrow => [14., 14., 13., 13.],
            Role::Footer => [13., 13., 13., 13.],
        }
    }

    /// HEAD_ROLES: folgen der Titelstufe des Autofits.
    pub fn head_step(self) -> bool {
        matches!(
            self,
            Role::Hero | Role::Display | Role::Statement | Role::H1 | Role::Kpi
        )
    }

    /// Titelschrift (data-font="head", data-hardwrap): zusätzlich h2/h3.
    pub fn head_font(self) -> bool {
        self.head_step() || matches!(self, Role::H2 | Role::H3)
    }

    /// line-height als Faktor der Schriftgröße (slide.css .r-*).
    pub fn line_height(self) -> f32 {
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

#[derive(Debug, Clone)]
pub struct Theme {
    pub id: &'static str,
    pub bg: Rgb,
    pub surface: Rgb,
    pub surface2: Rgb,
    pub text: Rgb,
    pub muted: Rgb,
    pub accent: Rgb,
    pub on_accent: Rgb,
    pub border: Rgb,
    pub fill: Rgb,
    pub head_family: &'static str,
    pub head_weight: f32,
    pub head_tracking: f32, // em
    pub body_family: &'static str,
    pub radius: f32,
    /// rule: 'under' – Trennlinie unter dem Folienkopf
    pub rule_under: bool,
    // --m-l/--m-r/--m-t/--m-b/--m-foot (Fallbacks in slide.css)
    pub m_l: f32,
    pub m_r: f32,
    pub m_t: f32,
    pub m_b: f32,
    pub m_foot: f32,
    pub measure: f32, // --measure
}

fn hex(s: &str) -> Rgb {
    Rgb::parse(s).expect("Theme-Farbe")
}

impl Theme {
    /// Katalog-Theme „beratung“, aufgelöst wie resolveTheme (Kontrast-Leitplanken).
    pub fn beratung() -> Theme {
        let (surface, surface2, accent) = (hex("#F4F5F6"), hex("#E9EBED"), hex("#0B5563"));
        let on_accent = hex("#FFFFFF");
        Theme {
            id: "beratung",
            bg: hex("#FFFFFF"),
            surface,
            surface2,
            text: hex("#16202B"),
            muted: ensure_contrast(hex("#5A6470"), surface2, 4.6),
            accent: ensure_contrast(accent, surface, 4.6),
            on_accent,
            border: hex("#DDE1E5"),
            fill: ensure_contrast(accent, on_accent, 4.6),
            head_family: "IBM Plex Sans",
            head_weight: 700.,
            head_tracking: -0.015,
            body_family: "IBM Plex Sans",
            radius: 2.,
            rule_under: true,
            m_l: 72.,
            m_r: 72.,
            m_t: 60.,
            m_b: 72.,
            m_foot: 24.,
            measure: 1000.,
        }
    }

    pub fn by_id(id: &str) -> Option<Theme> {
        (id == "beratung").then(Theme::beratung)
    }

    /// letter-spacing in em je Rolle (slide.css; --hs = 1 ohne Plakat-Titel).
    pub fn tracking_em(&self, role: Role) -> f32 {
        let t = self.head_tracking;
        match role {
            Role::Hero => -0.04,
            Role::Kpi => -0.03,
            Role::Display | Role::Statement => t - 0.005,
            Role::H1 => t,
            Role::H2 | Role::H3 => t / 2.,
            Role::Eyebrow => 0.01,
            Role::Footer => 0.02,
            _ => 0.,
        }
    }
}

/// Schriftfaktor je Format (applySteps, measure.ts:13).
pub fn font_factor(profile: Profile, width: f32) -> f32 {
    match profile {
        Profile::Social => width / 750.,
        Profile::Doc => (width / 1221.).min(0.65),
        Profile::Slides => 1.,
    }
}

/// --fs-<role> für eine Autofit-Stufe: gerundet, im Druck nie unter 12 px.
pub fn fs(role: Role, head: u32, body: u32, k: f32) -> f32 {
    let step = if role.head_step() { head } else { body } as usize;
    (role.scale()[step.min(3)] * k)
        .round()
        .max(if k < 1. { 12. } else { 0. })
}
