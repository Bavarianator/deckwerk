//! Übergänge und Animationen (animations.ts, Aufbau-Presets und Element-Animationen aus export-pptx.ts).
//! Die XML-Struktur folgt dem, was PowerPoint selbst schreibt: mainSeq → Klickgruppe → after-Kette → Effekt.
//! Alles hier enthält nur IDs, Zahlen und Konstanten, nie Nutzertext; deshalb `format!` statt Writer.

use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    Fade,
    Float,
    Pan,
    Drift,
    Pop,
    Zoom,
    Stomp,
    Baseline,
    Wipe,
    Appear,
    Pulse,
    Grow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Trigger {
    Click,
    After,
    With,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum By {
    Word,
    Letter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dir {
    Right,
    Left,
    Up,
    Down,
}

impl Dir {
    fn parse(s: &str) -> Option<Dir> {
        Some(match s {
            "right" => Dir::Right,
            "left" => Dir::Left,
            "up" => Dir::Up,
            "down" => Dir::Down,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimStep {
    /// cNvPr-Name, z. B. `dw:kpi-0`
    pub shape: String,
    pub effect: Effect,
    pub trigger: Trigger,
    /// nur diesen Absatz (0-basiert)
    #[serde(default)]
    pub paragraph: Option<usize>,
    #[serde(default)]
    pub by: Option<By>,
    #[serde(default)]
    pub gap_ms: Option<u32>,
    #[serde(default)]
    pub dir: Option<Dir>,
    #[serde(default)]
    pub dur_ms: Option<u32>,
    #[serde(default)]
    pub delay_ms: Option<u32>,
}

impl AnimStep {
    pub(crate) fn new(shape: &str, effect: Effect, trigger: Trigger, dur_ms: u32) -> Self {
        AnimStep {
            shape: shape.into(),
            effect,
            trigger,
            paragraph: None,
            by: None,
            gap_ms: None,
            dir: None,
            dur_ms: Some(dur_ms),
            delay_ms: None,
        }
    }
}

/// Was die Animation über eine geschriebene Form wissen muss (in TS per Regex aus dem Folien-XML gelesen).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Sp,
    Pic,
    Frame,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeInfo {
    pub id: u32,
    pub kind: Kind,
    pub tx_box: bool,
    pub paras: usize,
    /// sp mit sichtbarem Text (Tabellen: kein Wort-/Buchstaben-Aufbau)
    pub has_text: bool,
    pub chart: bool,
    pub words: usize,
    /// UTF-16-Länge aller Läufe, mit Leerzeichen verbunden
    pub letters: usize,
}

impl ShapeInfo {
    /// Form aus ihren Absätzen (je Absatz die Lauftexte), wie animations.ts sie aus dem XML liest.
    pub fn text(id: u32, tx_box: bool, paras: &[Vec<String>]) -> Self {
        let runs: Vec<&str> = paras.iter().flatten().map(String::as_str).collect();
        let text = runs.join(" ");
        ShapeInfo {
            id,
            kind: Kind::Sp,
            tx_box,
            paras: paras.len(),
            has_text: runs.iter().any(|t| t.chars().any(|c| !dw_lint::js::is_ws(c))),
            chart: false,
            words: text.split(dw_lint::js::is_ws).filter(|w| !w.is_empty()).count(),
            letters: text.encode_utf16().count(),
        }
    }
    pub fn other(id: u32, kind: Kind, chart: bool) -> Self {
        ShapeInfo {
            id,
            kind,
            tx_box: false,
            paras: 0,
            has_text: false,
            chart,
            words: 0,
            letters: 0,
        }
    }
}

const MC: &str = r#"xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006""#;
const P14: &str = r#"xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main""#;
const P159: &str = r#"xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main""#;

fn transition_fx(t: &str) -> Option<&'static str> {
    Some(match t {
        // Canva Slide und Stapel; Farbwischen gibt es in PowerPoint nicht, dort Wischen
        "slide" => r#"<p:push dir="l"/>"#,
        "stack" => r#"<p:cover dir="l"/>"#,
        "color" => r#"<p:wipe dir="r"/>"#,
        "fade" => "<p:fade/>",
        "push" => r#"<p:push dir="u"/>"#,
        "dissolve" => "<p:dissolve/>",
        "wipe" => r#"<p:wipe dir="r"/>"#,
        "cover" => r#"<p:cover dir="l"/>"#,
        "split" => r#"<p:split orient="vert" dir="out"/>"#,
        "circle" => "<p:circle/>",
        "zoom" => "<p:zoom/>",
        "morph" => r#"<p159:morph option="byObject"/>"#,
        _ => return None,
    })
}

fn speed_factor(speed: Option<&str>) -> Option<f64> {
    match speed {
        Some("slow") => Some(1.6),
        Some("fast") => Some(0.6),
        _ => None,
    }
}

/// `p:transition`: Normal 0,5 s, Morph 1 s; mit Tempo zusätzlich die genaue Dauer als p14:dur in mc:AlternateContent.
pub fn transition_xml(t: &str, speed: Option<&str>) -> String {
    let Some(fx) = transition_fx(t) else {
        return String::new();
    };
    let f = speed_factor(speed);
    let ms = ((if t == "morph" { 1000.0 } else { 500.0 }) * f.unwrap_or(1.0)).round() as i64;
    let spd = if ms < 625 {
        "fast"
    } else if ms < 875 {
        "med"
    } else {
        "slow"
    };
    let tr = |fx: &str, dur: bool| {
        let d = if dur {
            format!(r#" p14:dur="{ms}""#)
        } else {
            String::new()
        };
        format!(r#"<p:transition spd="{spd}"{d}>{fx}</p:transition>"#)
    };
    let mc = |choice: String, a: String, b: String| {
        format!("<mc:AlternateContent {MC}><mc:Choice {choice}>{a}</mc:Choice><mc:Fallback>{b}</mc:Fallback></mc:AlternateContent>")
    };
    if t == "morph" {
        // p14:dur in der Choice verlangt auch p14, sonst darf ein Leser ohne p14 die Choice nehmen
        let (p14, req) = if f.is_some() {
            (format!(" {P14}"), "p159 p14")
        } else {
            (String::new(), "p159")
        };
        return mc(
            format!(r#"{P159}{p14} Requires="{req}""#),
            tr(fx, f.is_some()),
            tr("<p:fade/>", false),
        );
    }
    if f.is_some() {
        mc(format!(r#"{P14} Requires="p14""#), tr(fx, true), tr(fx, false))
    } else {
        tr(fx, false)
    }
}

// [presetID, presetSubtype] wie in PowerPoints Effektkatalog
fn preset(e: Effect) -> (u32, u32) {
    match e {
        Effect::Fade => (10, 0),
        Effect::Float => (42, 0),
        Effect::Pan | Effect::Drift => (2, 8),
        Effect::Pop | Effect::Zoom | Effect::Stomp => (53, 16),
        Effect::Baseline => (22, 4),
        Effect::Wipe => (22, 8),
        Effect::Appear => (1, 0),
        Effect::Pulse => (26, 0),
        Effect::Grow => (6, 0),
    }
}

// Fly In/Wipe: Subtyp und Filter nach der Seite, von der es kommt
fn from(d: Dir) -> (u32, &'static str) {
    match d {
        Dir::Right => (8, "left"),
        Dir::Left => (2, "right"),
        Dir::Up => (4, "down"),
        Dir::Down => (1, "up"),
    }
}

struct Step<'a> {
    s: &'a AnimStep,
    sh: &'a ShapeInfo,
    dur: u32,
    delay: u32,
}

impl Step<'_> {
    fn gap(&self) -> u32 {
        match self.s.by {
            Some(b) => self.s.gap_ms.unwrap_or(match b {
                By::Word => 120,
                By::Letter => 45,
            }),
            None => 0,
        }
    }
    // Zeit in der after-Kette: iterierter Text läuft nach, Dauerpuls blockiert nichts
    fn span(&self) -> i64 {
        if matches!(self.s.effect, Effect::Pulse | Effect::Grow) {
            return self.delay as i64;
        }
        let n = match self.s.by {
            Some(_) if self.sh.has_text => {
                (if self.s.by == Some(By::Word) {
                    self.sh.words
                } else {
                    self.sh.letters
                }) as i64
                    - 1
            }
            _ => 0,
        };
        self.delay as i64 + self.dur as i64 + n * self.gap() as i64
    }
}

/// `p:timing` einer Folie; leer ohne Schritte. Unbekannte Formen/Absätze → Warnung, Schritt entfällt.
pub fn timing_xml(
    shapes: &HashMap<String, ShapeInfo>,
    steps: &[AnimStep],
    warn: &mut dyn FnMut(String),
) -> String {
    let mut st: Vec<Step> = vec![];
    for s in steps {
        let Some(sh) = shapes.get(&s.shape) else {
            warn(format!(
                "Animation: Form \"{}\" nicht gefunden, Schritt übersprungen",
                s.shape
            ));
            continue;
        };
        if let Some(p) = s.paragraph
            && !(sh.kind == Kind::Sp && p < sh.paras)
        {
            warn(format!(
                "Animation: \"{}\" hat keinen Absatz {p}, Schritt übersprungen",
                s.shape
            ));
            continue;
        }
        st.push(Step {
            s,
            sh,
            dur: s.dur_ms.unwrap_or(500),
            delay: s.delay_ms.unwrap_or(0),
        });
    }
    if st.is_empty() {
        return String::new();
    }

    // Klickgruppe → after-Kette → with-Effekte
    let mut groups: Vec<Vec<Vec<&Step>>> = vec![];
    for s in &st {
        match s.s.trigger {
            Trigger::Click => groups.push(vec![vec![s]]),
            _ if groups.is_empty() => groups.push(vec![vec![s]]),
            Trigger::After => groups.last_mut().expect("nicht leer").push(vec![s]),
            Trigger::With => groups
                .last_mut()
                .and_then(|g| g.last_mut())
                .expect("nicht leer")
                .push(s),
        }
    }

    let mut n = 2u32; // 1 = tmRoot, 2 = mainSeq
    let mut outer = String::new();
    for (gi, chains) in groups.iter().enumerate() {
        n += 1;
        let gid = n;
        let autostart = if gi == 0 && st[0].s.trigger != Trigger::Click {
            r#"<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>"#
        } else {
            ""
        };
        let mut t = 0i64;
        let mut inner = String::new();
        for chain in chains {
            n += 1;
            let cid = n;
            let start = t;
            t += chain.iter().map(|s| s.span()).max().unwrap_or(0);
            let mut fx = String::new();
            for s in chain {
                fx += &effect(s, &mut n);
            }
            inner += &format!(r#"<p:par><p:cTn id="{cid}" fill="hold"><p:stCondLst><p:cond delay="{start}"/></p:stCondLst><p:childTnLst>{fx}</p:childTnLst></p:cTn></p:par>"#);
        }
        outer += &format!(r#"<p:par><p:cTn id="{gid}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>{autostart}</p:stCondLst><p:childTnLst>{inner}</p:childTnLst></p:cTn></p:par>"#);
    }

    // je Form ein Build-Eintrag (Reihenfolge des ersten Auftretens); Bilder/Tabellen bekommen keinen
    let mut blds: Vec<(u32, String)> = vec![];
    for s in &st {
        let (sh, para) = (s.sh, s.s.paragraph);
        let pos = blds.iter().position(|(id, _)| *id == sh.id);
        let entry = if sh.kind == Kind::Sp && (para.is_some() || pos.is_none()) {
            let build = if para.is_some() {
                r#" build="p""#
            } else if !sh.has_text || !sh.tx_box {
                r#" animBg="1""#
            } else {
                ""
            };
            format!(r#"<p:bldP spid="{}" grpId="0"{build}/>"#, sh.id)
        } else if sh.chart {
            format!(
                r#"<p:bldGraphic spid="{}" grpId="0"><p:bldAsOne/></p:bldGraphic>"#,
                sh.id
            )
        } else {
            continue;
        };
        match pos {
            Some(i) => blds[i].1 = entry,
            None => blds.push((sh.id, entry)),
        }
    }
    let bld = if blds.is_empty() {
        String::new()
    } else {
        format!(
            "<p:bldLst>{}</p:bldLst>",
            blds.into_iter().map(|(_, b)| b).collect::<String>()
        )
    };
    format!(
        r#"<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>{outer}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>{bld}</p:timing>"#
    )
}

fn effect(s: &Step, n: &mut u32) -> String {
    let mut next = || {
        *n += 1;
        *n
    };
    let (sh, dur, e) = (s.sh, s.dur, s.s.effect);
    let id = next();
    let (pid, sub) = preset(e);
    let subtype = match (e, s.s.dir) {
        (Effect::Pan | Effect::Drift | Effect::Wipe, Some(d)) => from(d).0,
        _ => sub,
    };
    let grp = if sh.kind == Kind::Sp || sh.chart {
        r#" grpId="0""#
    } else {
        ""
    };
    let tgt = match s.s.paragraph {
        Some(p) => format!(
            r#"<p:tgtEl><p:spTgt spid="{}"><p:txEl><p:pRg st="{p}" end="{p}"/></p:txEl></p:spTgt></p:tgtEl>"#,
            sh.id
        ),
        None => format!(r#"<p:tgtEl><p:spTgt spid="{}"/></p:tgtEl>"#, sh.id),
    };
    let set = |next: &mut dyn FnMut() -> u32| {
        format!(r#"<p:set><p:cBhvr><p:cTn id="{}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>{tgt}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>"#, next())
    };
    let fx = |next: &mut dyn FnMut() -> u32, filter: &str| {
        format!(r#"<p:animEffect transition="in" filter="{filter}"><p:cBhvr><p:cTn id="{}" dur="{dur}"/>{tgt}</p:cBhvr></p:animEffect>"#, next())
    };
    let val = |v: &str| {
        if v.starts_with('#') {
            format!(r#"<p:strVal val="{v}"/>"#)
        } else {
            format!(r#"<p:fltVal val="{v}"/>"#)
        }
    };
    // Werte an Zeitpunkten (tm in Tausendstel Prozent)
    let anim = |next: &mut dyn FnMut() -> u32, attr: &str, tavs: &[(u32, String)]| {
        let id = next();
        let t: String = tavs
            .iter()
            .map(|(tm, v)| format!(r#"<p:tav tm="{tm}"><p:val>{}</p:val></p:tav>"#, val(v)))
            .collect();
        format!(r#"<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="{id}" dur="{dur}" fill="hold"/>{tgt}<p:attrNameLst><p:attrName>{attr}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst>{t}</p:tavLst></p:anim>"#)
    };
    let size = |next: &mut dyn FnMut() -> u32, tavs: &[(u32, &str)]| {
        let w: Vec<(u32, String)> = tavs.iter().map(|(t, v)| (*t, v.to_string())).collect();
        let h: Vec<(u32, String)> = tavs
            .iter()
            .map(|(t, v)| (*t, v.replace("ppt_w", "ppt_h")))
            .collect();
        anim(next, "ppt_w", &w) + &anim(next, "ppt_h", &h)
    };
    let mv = |next: &mut dyn FnMut() -> u32, dx: &str, dy: &str| {
        anim(
            next,
            "ppt_x",
            &[(0, format!("#ppt_x{dx}")), (100000, "#ppt_x".into())],
        ) + &anim(
            next,
            "ppt_y",
            &[(0, format!("#ppt_y{dy}")), (100000, "#ppt_y".into())],
        )
    };
    // Start versetzt gegen die Bewegungsrichtung, in Folienanteilen
    let toward = |next: &mut dyn FnMut() -> u32, d: Dir, by: &str| match d {
        Dir::Right => mv(next, &format!("-{by}"), ""),
        Dir::Left => mv(next, &format!("+{by}"), ""),
        Dir::Up => mv(next, "", &format!("+{by}")),
        Dir::Down => mv(next, "", &format!("-{by}")),
    };
    let dir = s.s.dir;
    let body = match e {
        Effect::Fade => set(&mut next) + &fx(&mut next, "fade"),
        Effect::Float => {
            set(&mut next) + &fx(&mut next, "fade") + &toward(&mut next, dir.unwrap_or(Dir::Up), ".1")
        }
        Effect::Pan => {
            set(&mut next)
                + &fx(&mut next, "fade")
                + &toward(&mut next, dir.unwrap_or(Dir::Right), ".05")
        }
        Effect::Drift => {
            set(&mut next)
                + &fx(&mut next, "fade")
                + &toward(&mut next, dir.unwrap_or(Dir::Right), ".1")
        }
        Effect::Pop => {
            set(&mut next)
                + &size(
                    &mut next,
                    &[(0, "0"), (70000, "#ppt_w*1.06"), (100000, "#ppt_w")],
                )
                + &fx(&mut next, "fade")
        }
        Effect::Zoom => {
            set(&mut next) + &size(&mut next, &[(0, "0"), (100000, "#ppt_w")]) + &fx(&mut next, "fade")
        }
        Effect::Stomp => {
            set(&mut next)
                + &size(&mut next, &[(0, "#ppt_w*1.6"), (100000, "#ppt_w")])
                + &fx(&mut next, "fade")
        }
        Effect::Baseline => set(&mut next) + &fx(&mut next, "wipe(down)") + &mv(&mut next, "", "+.05"),
        Effect::Wipe => {
            let f = format!("wipe({})", from(dir.unwrap_or(Dir::Right)).1);
            set(&mut next) + &fx(&mut next, &f)
        }
        Effect::Appear => set(&mut next),
        Effect::Grow => format!(r#"<p:animScale><p:cBhvr><p:cTn id="{}" dur="{dur}" fill="hold"/>{tgt}</p:cBhvr><p:by x="108000" y="108000"/></p:animScale>"#, next()),
        Effect::Pulse => format!(r#"<p:animScale><p:cBhvr><p:cTn id="{}" dur="{dur}" autoRev="1" repeatCount="indefinite" fill="hold"/>{tgt}</p:cBhvr><p:by x="104000" y="104000"/></p:animScale>"#, next()),
    };
    let iterate = match s.s.by {
        Some(b) if sh.has_text => format!(
            r#"<p:iterate type="{}"><p:tmAbs val="{}"/></p:iterate>"#,
            if b == By::Word { "wd" } else { "lt" },
            s.gap()
        ),
        _ => String::new(),
    };
    let class = if matches!(e, Effect::Pulse | Effect::Grow) {
        "emph"
    } else {
        "entr"
    };
    let node = match s.s.trigger {
        Trigger::Click => "clickEffect",
        Trigger::After => "afterEffect",
        Trigger::With => "withEffect",
    };
    format!(
        r#"<p:par><p:cTn id="{id}" presetID="{pid}" presetClass="{class}" presetSubtype="{subtype}" fill="hold"{grp} nodeType="{node}"><p:stCondLst><p:cond delay="{}"/></p:stCondLst>{iterate}<p:childTnLst>{body}</p:childTnLst></p:cTn></p:par>"#,
        s.delay
    )
}

/// Aufbau-Preset + Aufbaugruppen (data-build) → Schritte (export-pptx.ts stepsFor). `groups`: Gruppe → Formnamen.
pub fn steps_for(preset: &str, groups: &BTreeMap<u32, Vec<String>>, auto: bool) -> Vec<AnimStep> {
    let mut steps = vec![];
    let mut group = |names: &[String], first: AnimStep, rest: Option<AnimStep>| {
        for (j, shape) in names.iter().enumerate() {
            let tpl = if j == 0 {
                first.clone()
            } else {
                rest.clone().unwrap_or_else(|| AnimStep {
                    trigger: Trigger::With,
                    ..first.clone()
                })
            };
            steps.push(AnimStep {
                shape: shape.clone(),
                ..tpl
            });
        }
    };
    for (i, names) in groups.values().enumerate() {
        let mk = |effect, trigger, dur| AnimStep::new("", effect, trigger, dur);
        match preset {
            // Fotos zoomen zusätzlich (Foto-Zoom in build)
            "fade" | "photo" => group(
                names,
                mk(Effect::Fade, if i > 0 { Trigger::With } else { Trigger::After }, 600),
                None,
            ),
            "list" => group(
                names,
                mk(Effect::Float, if auto { Trigger::After } else { Trigger::Click }, 450),
                None,
            ),
            "stagger" | "zoom-kpi" | "pan" | "pop" => {
                let e = match preset {
                    "stagger" => Effect::Float,
                    "zoom-kpi" => Effect::Zoom,
                    "pan" => Effect::Pan,
                    _ => Effect::Pop,
                };
                let delay = Some(i as u32 * 150);
                let rest = AnimStep {
                    delay_ms: delay,
                    ..mk(e, Trigger::With, 450)
                };
                let first = AnimStep {
                    delay_ms: if i > 0 { delay } else { Some(0) },
                    ..mk(e, if i > 0 { Trigger::With } else { Trigger::After }, 450)
                };
                group(names, first, Some(rest))
            }
            "wipe" => group(names, mk(Effect::Wipe, Trigger::After, 500), None),
            // Canva „Aufstieg“: Text Wort für Wort
            "words" => group(
                names,
                AnimStep {
                    by: Some(By::Word),
                    ..mk(Effect::Float, Trigger::After, 400)
                },
                None,
            ),
            _ => {}
        }
    }
    steps
}

/// Element-Animation (Canva) → Schritt ohne Start (export-pptx.ts ITEM_FX). Purzeln wird zum Zoom:
/// eine relative Drehung kann PowerPoint nicht verlässlich. None für `none`/unbekannt.
pub fn item_fx(anim: &str) -> Option<(Effect, Option<u32>, Option<By>)> {
    Some(match anim {
        "fade" => (Effect::Fade, None, None),
        "float" => (Effect::Float, None, None),
        "pan" => (Effect::Pan, None, None),
        "drift" => (Effect::Drift, Some(1200), None),
        "pop" => (Effect::Pop, Some(450), None),
        "zoom" => (Effect::Zoom, None, None),
        "tumble" => (Effect::Zoom, Some(700), None),
        "stomp" => (Effect::Stomp, None, None),
        "baseline" => (Effect::Baseline, Some(600), None),
        "wipe" => (Effect::Wipe, None, None),
        "draw" => (Effect::Wipe, Some(800), None),
        "typewriter" => (Effect::Appear, Some(1), Some(By::Letter)),
        "ascend" => (Effect::Float, Some(400), Some(By::Word)),
        "breathe" => (Effect::Pulse, Some(1200), None),
        _ => return None,
    })
}

/// Schritt eines freien Elements mit Tempo, Richtung, Start und Verzögerung (buildPptx).
pub fn item_step(
    shape: &str,
    anim: &str,
    dir: Option<&str>,
    speed: Option<&str>,
    trigger: Trigger,
    delay_s: f64,
) -> Option<AnimStep> {
    let (effect, dur, by) = item_fx(anim)?;
    let f = speed_factor(speed).unwrap_or(1.0);
    let ms = |v: f64| (v * f).round() as u32;
    Some(AnimStep {
        shape: shape.into(),
        effect,
        trigger,
        paragraph: None,
        by,
        gap_ms: by.map(|b| ms(if b == By::Word { 120.0 } else { 45.0 })),
        dir: dir.and_then(Dir::parse),
        dur_ms: Some(ms(dur.unwrap_or(500) as f64)),
        delay_ms: Some((delay_s * 1000.0).round() as u32),
    })
}

/// deck.ts animStartOf: im Selbstlauf gibt es keine Klicks.
pub fn start_of(start: Option<&str>, auto: bool) -> Trigger {
    match (auto, start) {
        (true, Some("with")) => Trigger::With,
        (true, _) => Trigger::After,
        (false, Some("with")) => Trigger::With,
        (false, Some("after")) => Trigger::After,
        (false, _) => Trigger::Click,
    }
}
