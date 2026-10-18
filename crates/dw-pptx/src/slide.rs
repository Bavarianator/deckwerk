//! Eine Folie: Hintergrundbild, dann die gemessenen Elemente an ihren Positionen (export-pptx.ts addEl),
//! danach Übergang und Zeitleiste (animations.ts). Bildmasken, Bildanpassung, Texteffekte wie patch-xml.ts.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Cursor;

use base64::Engine;
use dw_model::{
    Align, BoxEl, ChartEl, El, ElBox, FontRole, IconEl, ImgEl, ImgFit, ListType, MediaEl, MediaKind, Run,
    TableEl, TextEl,
};

use crate::anim::{self, AnimStep, Effect, Kind, ShapeInfo, Trigger};
use crate::parts::{NS_A, NS_P, NS_R};
use crate::xml::{X, a};
use crate::{Error, Palette, Pkg, PptxInput, PptxOpts, PptxSlide, Rels, SlideOpts, chart};

// Box ±1,5 % breiter, damit PowerPoint nie früher umbricht als Chromium (export-pptx.ts:22-25)
const WRAP_SLACK: f64 = 0.015;
// px links/rechts je Tabellenzelle, muss zum Renderer passen
const TABLE_PAD: f64 = 8.0;

pub fn emu(px: f64) -> i64 {
    (px * 9525.0).round() as i64
}
// Hundertstel Punkt (sz, spc, spcPts)
fn pt100(px: f64) -> i64 {
    (px * 75.0).round() as i64
}
// ST_TextFontSize: mindestens 1 pt
fn sz(px: f64) -> i64 {
    pt100(px).max(100)
}
fn pct(v: f64) -> i64 {
    (v * 100_000.0).round() as i64
}

/// #rgb, #rrggbb, #rrggbbaa → genau 6 Hex-Ziffern (Alpha fällt weg). Alles andere ist ein Fehler, nie Rohtext im XML.
pub fn hex(c: &str) -> Result<String, Error> {
    let h = c.trim().strip_prefix('#').unwrap_or(c.trim());
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Color(c.into()));
    }
    let h = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        6 | 8 => h[..6].to_string(),
        _ => return Err(Error::Color(c.into())),
    };
    Ok(h.to_ascii_uppercase())
}

/// `data:…;base64,…` → Bytes
pub fn data_url(src: &str) -> Option<Vec<u8>> {
    let (meta, data) = src.strip_prefix("data:")?.split_once(',')?;
    meta.ends_with(";base64")
        .then(|| base64::engine::general_purpose::STANDARD.decode(data.trim()).ok())
        .flatten()
}

struct Ctx<'a> {
    x: X,
    rels: Rels,
    pkg: &'a mut Pkg,
    input: &'a PptxInput,
    next_id: u32,
    used: HashSet<String>,
    /// tote Folienlinks, je Ziel nur eine Warnung
    dead_links: HashSet<String>,
    prefix: &'static str,
    palette: &'a Palette,
    warns: &'a mut Vec<String>,
    /// geschriebene Formen nach Name, für die Zeitleiste
    shapes: HashMap<String, ShapeInfo>,
}

fn transition_at(opts: &PptxOpts, j: usize) -> &str {
    if j == 0 {
        return "none";
    }
    opts.slides
        .get(j)
        .and_then(|s| s.transition.as_deref())
        .unwrap_or("none")
}

/// `prev`: Morph-Namen und -Schlüssel der vorigen Folie, wird auf diese Folie weitergesetzt.
pub fn slide_xml(
    input: &PptxInput,
    opts: &PptxOpts,
    i: usize,
    s: &PptxSlide,
    pkg: &mut Pkg,
    prev: &mut Vec<(String, Option<String>)>,
    warns: &mut Vec<String>,
) -> Result<(Vec<u8>, Rels), Error> {
    let none = SlideOpts::default();
    let so = opts.slides.get(i).unwrap_or(&none);
    let morph_here = transition_at(opts, i) == "morph";
    let mut c = Ctx {
        x: X::new(),
        rels: Rels::default(),
        pkg,
        input,
        next_id: 2,
        used: HashSet::new(),
        dead_links: HashSet::new(),
        prefix: if s.morph || morph_here || transition_at(opts, i + 1) == "morph" {
            "!!dw:"
        } else {
            "dw:"
        },
        palette: so.palette.as_ref().unwrap_or(&opts.palette),
        warns,
        shapes: HashMap::new(),
    };
    c.rels
        .add("slideLayout", "../slideLayouts/slideLayout1.xml", false);
    if s.hidden {
        c.x.open(
            "p:sld",
            a!["xmlns:a" => NS_A, "xmlns:r" => NS_R, "xmlns:p" => NS_P, "show" => 0],
        );
    } else {
        c.x.open(
            "p:sld",
            a!["xmlns:a" => NS_A, "xmlns:r" => NS_R, "xmlns:p" => NS_P],
        );
    }
    c.x.open("p:cSld", a![]);
    // Hintergrund wie pptxgenjs `slide.background`: nicht verschiebbar, unter allem
    if let Some(png) = &s.background_png {
        match c.pkg.media(None, png) {
            Some(target) => {
                let rid = c.rels.add("image", target, false);
                c.x.raw(r#"<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1">"#);
                c.x.empty("a:blip", a!["r:embed" => rid]);
                c.x.raw("<a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>");
            }
            None => c.warn("Hintergrund ist kein lesbares Bild, übersprungen".into()),
        }
    }
    c.x.raw(r#"<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>"#);

    // Morph: PowerPoint ordnet Formen mit gleichem „!!“-Namen einander zu, dieselbe Zuordnung wie in der App
    let els = &s.measured.els;
    let own: Vec<(String, Option<String>)> = els
        .iter()
        .map(|e| (e.base().slot.clone(), dw_lint::lint::morph_key(e)))
        .collect();
    let morphed: Vec<String> = if morph_here {
        dw_lint::lint::morph_names(prev, &own)
    } else {
        own.iter().map(|(s, _)| s.clone()).collect()
    };
    let prev_names: HashSet<String> = if morph_here {
        prev.iter().map(|(s, _)| s.clone()).collect()
    } else {
        HashSet::new()
    };
    *prev = own
        .iter()
        .zip(&morphed)
        .map(|((_, k), m)| (m.clone(), k.clone()))
        .collect();

    let agenda: HashMap<String, String> = so
        .agenda
        .iter()
        .map(|(k, to)| (format!("items.{k}.title"), format!("#{}", to + 1)))
        .collect();
    let mut groups: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    let (mut pulses, mut photos, mut item_steps) = (vec![], vec![], vec![]);
    let slide_h = input.size.h;
    for (k, el) in els.iter().enumerate() {
        let name = c.name(&morphed[k]);
        let base = el.base();
        match el {
            El::Text(t) => c.text(t, &name, agenda.get(&base.slot).map(String::as_str))?,
            El::Box(b) => c.shape(b, &name)?,
            El::Img(i) => c.img(i, &name)?,
            El::Table(t) => c.table(t, &name)?,
            El::Chart(ch) => c.chart(ch, &name)?,
            El::Icon(ic) => c.icon(ic, &name)?,
            El::Media(m) => c.media(m, &name)?,
        }
        // herübergewandert: tritt nicht noch einmal auf (sonst morpht PowerPoint ins Unsichtbare)
        if prev_names.contains(&morphed[k]) || !c.shapes.contains_key(&name) {
            continue;
        }
        if let Some(b) = base.build {
            groups.entry(b).or_default().push(name.clone());
        }
        // Canva-Foto-Zoom: randlose und halbseitige Fotos (volle Höhe) vergrößern sich langsam
        if let El::Img(img) = el {
            let b = img.base.bbox;
            if img.under == Some(true) || (b.y <= 1.0 && b.y + b.h >= slide_h - 1.0) {
                photos.push(name.clone());
            }
        }
        if let Some(a) = base.anim.as_deref().filter(|a| *a != "none") {
            let (start, delay) = so
                .items
                .get(&base.slot)
                .map(|(s, d)| (s.as_deref(), *d))
                .unwrap_or((None, 0.0));
            let step = anim::item_step(
                &name,
                a,
                base.anim_dir.as_deref(),
                base.anim_speed.as_deref(),
                anim::start_of(start, opts.auto),
                delay,
            );
            match step {
                // Atmen läuft ab Folienbeginn, ohne Klick
                Some(st) if a == "breathe" => pulses.push(AnimStep {
                    trigger: Trigger::With,
                    delay_ms: Some(0),
                    ..st
                }),
                Some(st) => item_steps.push(st),
                None => c.warn(format!("{name}: unbekannte Animation {a:?}, übersprungen")),
            }
        }
    }
    let preset = so.build.as_deref().unwrap_or("none");
    if preset == "photo" {
        pulses.extend(
            photos
                .iter()
                .map(|n| AnimStep::new(n, Effect::Grow, Trigger::With, 12000)),
        );
    }
    let steps: Vec<AnimStep> = pulses
        .into_iter()
        .chain(anim::steps_for(preset, &groups, opts.auto))
        .chain(item_steps)
        .collect();

    c.x.raw("</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>");
    // Schema-Reihenfolge in p:sld: cSld, clrMapOvr, transition, timing
    c.x.trusted(&anim::transition_xml(
        transition_at(opts, i),
        so.transition_speed.as_deref(),
    ));
    let warns = &mut *c.warns;
    let timing = anim::timing_xml(&c.shapes, &steps, &mut |w| warns.push(w));
    c.x.trusted(&timing);
    c.x.close("p:sld");
    Ok((c.x.done(), c.rels))
}

impl Ctx<'_> {
    fn warn(&mut self, msg: String) {
        self.warns.push(msg);
    }

    fn id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id - 1
    }

    // dw:<slot>, Doppelte mit #2, #3 …; &<>"' fallen weg (export-pptx.ts:298-303)
    fn name(&mut self, slot: &str) -> String {
        let base: String = format!("{}{slot}", self.prefix)
            .chars()
            .filter(|c| !"&<>\"'".contains(*c))
            .collect();
        let mut name = base.clone();
        let mut k = 2;
        while self.used.contains(&name) {
            name = format!("{base}#{k}");
            k += 1;
        }
        self.used.insert(name.clone());
        name
    }

    fn font(&self, role: FontRole, face: &Option<String>) -> String {
        face.clone().unwrap_or_else(|| match role {
            FontRole::Head => self.input.head_font.clone(),
            FontRole::Body => self.input.body_font.clone(),
        })
    }

    /// Link → Rel; `#N` nur als Folienlink und nur, wenn Folie N existiert (linkOf, export-pptx.ts:120-124).
    fn hlink(&mut self, link: Option<&str>) {
        let Some(link) = link else { return };
        if let Some(n) = link.strip_prefix('#') {
            // nur reine Ziffern wie TS ^#(\d+)$; parse nähme auch „+2“
            let digits = !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit());
            match n.parse::<usize>() {
                Ok(n) if digits && n >= 1 && n <= self.input.slides.len() => {
                    let rid = self.rels.add("slide", format!("slide{n}.xml"), false);
                    self.x.empty(
                        "a:hlinkClick",
                        a!["r:id" => rid, "action" => "ppaction://hlinksldjump"],
                    );
                }
                _ => {
                    if self.dead_links.insert(link.to_string()) {
                        self.warn(format!("Folienlink {link} zeigt ins Leere, entfernt"));
                    }
                }
            }
        } else if link.starts_with("http://")
            || link.starts_with("https://")
            || link.starts_with("mailto:")
        {
            let rid = self.rels.add("hyperlink", link, true);
            self.x.empty("a:hlinkClick", a!["r:id" => rid]);
        }
    }

    fn cnvpr(&mut self, id: u32, name: &str, descr: Option<&str>, link: Option<&str>) {
        match descr {
            Some(d) => self
                .x
                .open("p:cNvPr", a!["id" => id, "name" => name, "descr" => d]),
            None => self.x.open("p:cNvPr", a!["id" => id, "name" => name]),
        }
        self.hlink(link);
        self.x.close("p:cNvPr");
    }

    fn xfrm(&mut self, b: ElBox, rot: Option<f64>, flip: bool) {
        let rot = rot
            .map(|r| ((r % 360.0 + 360.0) % 360.0 * 60000.0).round() as i64)
            .filter(|r| *r != 0);
        match (rot, flip) {
            (Some(r), true) => self.x.open("a:xfrm", a!["rot" => r, "flipH" => 1]),
            (Some(r), false) => self.x.open("a:xfrm", a!["rot" => r]),
            (None, true) => self.x.open("a:xfrm", a!["flipH" => 1]),
            (None, false) => self.x.open("a:xfrm", a![]),
        }
        self.x.empty("a:off", a!["x" => emu(b.x), "y" => emu(b.y)]);
        self.x
            .empty("a:ext", a!["cx" => emu(b.w), "cy" => emu(b.h)]);
        self.x.close("a:xfrm");
    }

    fn geom(&mut self, prst: &str, adj: Option<i64>) {
        self.x.open("a:prstGeom", a!["prst" => prst]);
        match adj {
            Some(v) => {
                self.x.open("a:avLst", a![]);
                self.x
                    .empty("a:gd", a!["name" => "adj", "fmla" => format!("val {v}")]);
                self.x.close("a:avLst");
            }
            None => self.x.empty("a:avLst", a![]),
        }
        self.x.close("a:prstGeom");
    }

    fn solid(&mut self, color: &str, alpha: Option<f64>) -> Result<(), Error> {
        let c = hex(color)?;
        self.x.open("a:solidFill", a![]);
        self.clr(&c, alpha);
        self.x.close("a:solidFill");
        Ok(())
    }

    fn clr(&mut self, c: &str, alpha: Option<f64>) {
        match alpha.filter(|a| *a < 1.0) {
            Some(al) => {
                self.x.open("a:srgbClr", a!["val" => c]);
                self.x.empty("a:alpha", a!["val" => pct(al.max(0.0))]);
                self.x.close("a:srgbClr");
            }
            None => self.x.empty("a:srgbClr", a!["val" => c]),
        }
    }

    fn text(&mut self, el: &TextEl, name: &str, link: Option<&str>) -> Result<(), Error> {
        let b = el.base.bbox;
        let extra = b.w * WRAP_SLACK;
        let x = match el.align {
            Align::Center => b.x - extra / 2.0,
            Align::Right => b.x - extra,
            Align::Left => b.x,
        };
        let id = self.id();
        let font = self.font(el.font, &el.font_face);
        self.x.open("p:sp", a![]);
        self.x.open("p:nvSpPr", a![]);
        self.cnvpr(id, name, None, link);
        self.x.empty("p:cNvSpPr", a!["txBox" => 1]);
        self.x.empty("p:nvPr", a![]);
        self.x.close("p:nvSpPr");
        self.x.open("p:spPr", a![]);
        self.xfrm(
            ElBox {
                x,
                w: b.w + extra,
                ..b
            },
            el.base.rot,
            false,
        );
        self.geom("rect", None);
        self.x.empty("a:noFill", a![]);
        self.x.close("p:spPr");
        self.x.open("p:txBody", a![]);
        self.x.empty("a:bodyPr", a!["wrap" => "square", "lIns" => 0, "tIns" => 0, "rIns" => 0, "bIns" => 0, "anchor" => "t", "rtlCol" => 0]);
        self.x.empty("a:lstStyle", a![]);
        // Absätze enden an breakAfter
        let mut paras: Vec<Vec<&Run>> = vec![vec![]];
        for (i, r) in el.runs.iter().enumerate() {
            paras.last_mut().expect("mind. ein Absatz").push(r);
            if r.break_after == Some(true) && i + 1 < el.runs.len() {
                paras.push(vec![]);
            }
        }
        let algn = match el.align {
            Align::Left => "l",
            Align::Center => "ctr",
            Align::Right => "r",
        };
        let mut prev_num = false;
        let texts: Vec<Vec<String>> = paras
            .iter()
            .map(|p| p.iter().map(|r| self.case(el, r)).collect())
            .collect();
        self.shapes
            .insert(name.into(), ShapeInfo::text(id, true, &texts));
        for p in paras {
            self.x.open("a:p", a![]);
            let marked = el
                .list
                .as_ref()
                .filter(|_| p.iter().any(|r| !r.text.trim().is_empty()));
            match marked {
                Some(l) => self.x.open(
                    "a:pPr",
                    a!["algn" => algn, "marL" => emu(l.indent_px), "indent" => -emu(l.indent_px)],
                ),
                None => self.x.open("a:pPr", a!["algn" => algn]),
            }
            self.x.open("a:lnSpc", a![]);
            self.x
                .empty("a:spcPts", a!["val" => pt100(el.line_height_px)]);
            self.x.close("a:lnSpc");
            self.x.raw(r#"<a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft>"#);
            let num = matches!(marked, Some(l) if l.kind == ListType::Number);
            match marked {
                // LibreOffice zählt bei jedem startAt neu: nur am ersten Absatz eines Blocks (export-pptx.ts:135-145)
                Some(_) if num && prev_num => self
                    .x
                    .raw(r#"<a:buFontTx/><a:buAutoNum type="arabicPeriod"/>"#),
                Some(_) if num => self
                    .x
                    .raw(r#"<a:buFontTx/><a:buAutoNum type="arabicPeriod" startAt="1"/>"#),
                Some(_) => self.x.raw(r#"<a:buFontTx/><a:buChar char="•"/>"#),
                None if el.list.is_some() => self.x.empty("a:buNone", a![]),
                None => {}
            }
            prev_num = num;
            self.x.close("a:pPr");
            for r in &p {
                self.run(el, r, &font)?;
            }
            self.x.empty(
                "a:endParaRPr",
                a!["lang" => "de-DE", "sz" => sz(el.size_px), "dirty" => 0],
            );
            self.x.close("a:p");
        }
        self.x.close("p:txBody");
        self.x.close("p:sp");
        Ok(())
    }

    fn run(&mut self, el: &TextEl, r: &Run, font: &str) -> Result<(), Error> {
        let sz = sz(r.size_px.unwrap_or(el.size_px));
        let spc = pt100(r.tracking_px.unwrap_or(el.tracking_px));
        let (b, i) = (r.bold as u8, r.italic as u8);
        self.x.open("a:r", a![]);
        match (r.underline == Some(true), spc != 0) {
            (true, true) => self.x.open("a:rPr", a!["lang" => "de-DE", "sz" => sz, "b" => b, "i" => i, "u" => "sng", "spc" => spc, "dirty" => 0]),
            (true, false) => self.x.open("a:rPr", a!["lang" => "de-DE", "sz" => sz, "b" => b, "i" => i, "u" => "sng", "dirty" => 0]),
            (false, true) => self.x.open("a:rPr", a!["lang" => "de-DE", "sz" => sz, "b" => b, "i" => i, "spc" => spc, "dirty" => 0]),
            (false, false) => self.x.open("a:rPr", a!["lang" => "de-DE", "sz" => sz, "b" => b, "i" => i, "dirty" => 0]),
        }
        self.run_fill(el, &r.color)?;
        self.x.empty("a:latin", a!["typeface" => font]);
        self.x.empty("a:cs", a!["typeface" => font]);
        // Element-Link gilt für Runs ohne eigenen
        let link = r.link.as_deref().or(el.base.link.as_deref());
        self.hlink(link);
        self.x.close("a:rPr");
        let t = self.case(el, r);
        self.x.leaf("a:t", a![], &t);
        self.x.close("a:r");
        Ok(())
    }

    fn case(&self, el: &TextEl, r: &Run) -> String {
        if el.upper {
            r.text.to_uppercase()
        } else {
            r.text.clone()
        }
    }

    /// Füllung eines Laufs samt Texteffekt (patch-xml.ts textEffect). Reihenfolge im rPr: ln, Füllung, effectLst.
    /// Maße relativ zur Schriftgröße wie in der Vorschau; Effektfarbe statt Laufarbe bei hollow/neon.
    fn run_fill(&mut self, el: &TextEl, color: &str) -> Result<(), Error> {
        let Some(e) = &el.effect else {
            return self.solid(color, None);
        };
        let em = |v: f64| (v * el.size_px * 9525.0).round() as i64;
        let ec = hex(&e.color)?;
        match e.kind.as_str() {
            "hollow" => {
                self.x.open("a:ln", a!["w" => em(0.03).max(9525)]);
                self.solid(&ec, None)?;
                self.x.close("a:ln");
                self.x.empty("a:noFill", a![]);
                return Ok(());
            }
            "shadow" | "lift" | "neon" => {}
            _ => return self.solid(color, None),
        }
        self.solid(color, None)?;
        self.x.open("a:effectLst", a![]);
        match e.kind.as_str() {
            "shadow" => {
                self.x.open("a:outerShdw", a!["blurRad" => em(0.04), "dist" => em(0.07), "dir" => 2700000, "algn" => "tl", "rotWithShape" => 0]);
                self.clr("000000", Some(0.45));
                self.x.close("a:outerShdw");
            }
            "lift" => {
                self.x.open("a:outerShdw", a!["blurRad" => em(0.4), "dist" => em(0.08), "dir" => 5400000, "algn" => "t", "rotWithShape" => 0]);
                self.clr("000000", Some(0.35));
                self.x.close("a:outerShdw");
            }
            _ => {
                self.x.open("a:glow", a!["rad" => em(0.25)]);
                self.clr(&ec, Some(0.6));
                self.x.close("a:glow");
            }
        }
        self.x.close("a:effectLst");
        Ok(())
    }

    fn shape(&mut self, el: &BoxEl, name: &str) -> Result<(), Error> {
        let mut b = el.base.bbox;
        let line = el.shape.as_deref() == Some("line");
        let (prst, adj) = if line {
            b = ElBox {
                y: b.y + b.h / 2.0,
                h: 0.0,
                ..b
            };
            ("line", None)
        } else if let Some(s) = el.shape.as_deref() {
            (shape_type(s), None)
        } else if el.ellipse {
            ("ellipse", None)
        } else if el.radius > 0.5 {
            ("roundRect", Some(round_adj(el.radius, b)))
        } else {
            ("rect", None)
        };
        let id = self.id();
        self.shapes
            .insert(name.into(), ShapeInfo::other(id, Kind::Sp, false));
        self.x.open("p:sp", a![]);
        self.x.open("p:nvSpPr", a![]);
        self.cnvpr(id, name, None, el.base.link.as_deref());
        self.x.empty("p:cNvSpPr", a![]);
        self.x.empty("p:nvPr", a![]);
        self.x.close("p:nvSpPr");
        self.x.open("p:spPr", a![]);
        self.xfrm(b, el.base.rot, false);
        self.geom(prst, adj);
        // genau eine Füllung, sonst repariert PowerPoint die Datei (patch-xml.ts:34)
        let grad = el.gradient.as_ref().filter(|_| !line);
        if let Some(g) = grad.filter(|g| g.stops.len() < 2) {
            // gradFill braucht ≥ 2 Stops: einer → Vollton, keiner → ohne Füllung
            self.warn(format!("{name}: Verlauf mit {} Stop(s)", g.stops.len()));
            match g.stops.first() {
                Some(st) => self.solid(&st.color, Some(st.alpha))?,
                None => self.x.empty("a:noFill", a![]),
            }
        } else if let Some(g) = grad {
            self.x.open("a:gradFill", a!["rotWithShape" => 1]);
            self.x.open("a:gsLst", a![]);
            for s in &g.stops {
                let c = hex(&s.color)?;
                self.x.open("a:gs", a!["pos" => pct(s.pos.clamp(0.0, 1.0))]);
                self.x.open("a:srgbClr", a!["val" => c]);
                self.x
                    .empty("a:alpha", a!["val" => pct(s.alpha.clamp(0.0, 1.0))]);
                self.x.close("a:srgbClr");
                self.x.close("a:gs");
            }
            self.x.close("a:gsLst");
            // CSS 0° = nach oben, OOXML 0° = nach rechts
            let ang = (((g.angle - 90.0) % 360.0 + 360.0) % 360.0 * 60000.0).round() as i64;
            self.x.empty("a:lin", a!["ang" => ang, "scaled" => 0]);
            self.x.close("a:gradFill");
        } else if let Some(f) = el.fill.as_ref().filter(|_| !line) {
            self.solid(&f.color, Some(f.alpha))?;
        } else {
            self.x.empty("a:noFill", a![]);
        }
        match &el.border {
            Some(bd) => {
                self.x.open("a:ln", a!["w" => emu(bd.width)]);
                self.solid(&bd.color, None)?;
                let dash = match el.dash.as_deref() {
                    Some("dash") => "dash",
                    Some("dot") => "sysDot",
                    _ => "solid",
                };
                self.x.empty("a:prstDash", a!["val" => dash]);
                for (tag, end) in [("a:headEnd", &el.line_start), ("a:tailEnd", &el.line_end)] {
                    let t = match end.as_deref() {
                        Some("arrow") => "arrow",
                        Some("triangle") => "triangle",
                        Some("dot") => "oval",
                        _ => continue,
                    };
                    self.x.empty(tag, a!["type" => t]);
                }
                self.x.close("a:ln");
            }
            None => self.x.raw("<a:ln><a:noFill/></a:ln>"),
        }
        if let Some(s) = &el.shadow {
            let c = hex(&s.color)?;
            self.x.open("a:effectLst", a![]);
            self.x.open("a:outerShdw", a!["blurRad" => emu(s.blur), "dist" => emu(s.offset_y), "dir" => 5400000, "algn" => "t", "rotWithShape" => 0]);
            self.clr(&c, Some(s.alpha));
            self.x.close("a:outerShdw");
            self.x.close("a:effectLst");
        }
        self.x.close("p:spPr");
        self.x.close("p:sp");
        Ok(())
    }

    fn img(&mut self, el: &ImgEl, name: &str) -> Result<(), Error> {
        let owned;
        let bytes = match self.input.media.get(&el.src) {
            Some(b) => b,
            None => match data_url(&el.src) {
                Some(b) => {
                    owned = b;
                    &owned
                }
                None => {
                    self.warn(format!("{name}: Bilddatei fehlt, übersprungen"));
                    return Ok(());
                }
            },
        };
        let Some(target) = self.pkg.media(Some(&el.src), bytes) else {
            self.warn(format!("{name}: unbekanntes Bildformat, übersprungen"));
            return Ok(());
        };
        let nat = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .ok()
            .and_then(|r| r.into_dimensions().ok())
            .map(|(w, h)| (w as f64, h as f64))
            .or(el.nat.map(|n| (n.w, n.h)))
            .filter(|(w, h)| *w > 0.0 && *h > 0.0);
        let mut b = el.base.bbox;
        // srcRect l, t, r, b als Anteile
        let mut src = None;
        match (el.fit, nat) {
            (ImgFit::Contain, Some((iw, ih))) => {
                let k = (b.w / iw).min(b.h / ih);
                let (w, h) = (iw * k, ih * k);
                b = ElBox {
                    x: b.x + (b.w - w) * el.focus.x,
                    y: b.y + (b.h - h) * el.focus.y,
                    w,
                    h,
                };
            }
            (ImgFit::Cover, _) if el.crop.is_some() => {
                let c = el.crop.expect("geprüft");
                src = Some([c.x, c.y, 1.0 - c.x - c.w, 1.0 - c.y - c.h]);
            }
            (ImgFit::Cover, Some((iw, ih))) => {
                let k = (b.w / iw).max(b.h / ih);
                let (w, h) = (iw * k, ih * k);
                let (ox, oy) = ((w - b.w) * el.focus.x, (h - b.h) * el.focus.y);
                src = Some([ox / w, oy / h, (w - b.w - ox) / w, (h - b.h - oy) / h]);
            }
            _ => {}
        }
        // Bildrahmen (patch-xml.ts MASK_GEOM) vor Kreis vor Radius; Bild bleibt austauschbar
        let geom = match el.mask.as_deref().and_then(mask_geom) {
            Some(g) => Geom::Raw(g),
            None if el.round == Some(true) => Geom::Prst("ellipse", None),
            None if el.fit == ImgFit::Cover && el.radius > 0.5 => {
                Geom::Prst("roundRect", Some(round_adj(el.radius, b)))
            }
            None => Geom::Prst("rect", None),
        };
        let rid = self.rels.add("image", target, false);
        let id = self.id();
        self.shapes
            .insert(name.into(), ShapeInfo::other(id, Kind::Pic, false));
        // Alt-Text nie leer und nie der Pfad (Vuln 3)
        let alt = el
            .alt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(" ");
        let fx = self.blip_fx(el)?;
        self.pic_open(id, name, alt, el.base.link.as_deref());
        self.blip(&rid, &fx, el.alpha, None);
        self.pic_close(b, el.base.rot, el.flip == Some(true), geom, src);
        Ok(())
    }

    /// Kinder von a:blip: Neu-Einfärben, dann Bildkorrekturen (patch-xml.ts recolor/adjustBlip, gleiche Reihenfolge).
    fn blip_fx(&self, el: &ImgEl) -> Result<String, Error> {
        let mut x = X::frag();
        match el.look.as_deref() {
            Some("mono") => x.empty("a:grayscl", a![]),
            Some("duotone") => {
                let (d, l) = &self.palette.duotone;
                x.open("a:duotone", a![]);
                x.empty("a:srgbClr", a!["val" => hex(d)?]);
                x.empty("a:srgbClr", a!["val" => hex(l)?]);
                x.close("a:duotone");
            }
            _ => {}
        }
        if let Some(ad) = &el.adjust {
            // Werte in 1/1000 Prozent, Weichzeichner in EMU
            let k = |v: Option<f64>| v.filter(|v| *v != 0.0 && v.is_finite());
            if let Some(bl) = k(ad.blur) {
                x.empty("a:blur", a!["rad" => (bl / 10.0 * 9525.0 * 2.0).round() as i64, "grow" => 0]);
            }
            if let Some(sat) = k(ad.sat) {
                x.empty("a:hsl", a!["hue" => 0, "sat" => (sat * 1000.0).round() as i64, "lum" => 0]);
            }
            if k(ad.bright).is_some() || k(ad.contrast).is_some() {
                let v = |v: Option<f64>| (v.unwrap_or(0.0) * 1000.0).round() as i64;
                x.empty("a:lum", a!["bright" => v(ad.bright), "contrast" => v(ad.contrast)]);
            }
        }
        Ok(String::from_utf8(x.done()).expect("UTF-8"))
    }

    fn pic_open(&mut self, id: u32, name: &str, alt: &str, link: Option<&str>) {
        self.x.open("p:pic", a![]);
        self.x.open("p:nvPicPr", a![]);
        self.cnvpr(id, name, Some(alt), link);
        self.x
            .raw(r#"<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>"#);
        self.x.raw("<p:nvPr/>");
        self.x.close("p:nvPicPr");
        self.x.open("p:blipFill", a![]);
    }

    /// `fx`: fertige Blip-Kinder; `svg`: rId der SVG-Fassung (asvg:svgBlip, PNG bleibt Fallback)
    fn blip(&mut self, rid: &str, fx: &str, alpha: Option<f64>, svg: Option<&str>) {
        let alpha = alpha.filter(|a| *a < 1.0);
        if fx.is_empty() && alpha.is_none() && svg.is_none() {
            self.x.empty("a:blip", a!["r:embed" => rid]);
            return;
        }
        self.x.open("a:blip", a!["r:embed" => rid]);
        self.x.trusted(fx);
        if let Some(al) = alpha {
            self.x.empty("a:alphaModFix", a!["amt" => pct(al.max(0.0))]);
        }
        if let Some(svg) = svg {
            self.x.raw(r#"<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">"#);
            self.x.empty(
                "asvg:svgBlip",
                a!["xmlns:asvg" => "http://schemas.microsoft.com/office/drawing/2016/SVG/main", "r:embed" => svg],
            );
            self.x.raw("</a:ext></a:extLst>");
        }
        self.x.close("a:blip");
    }

    fn pic_close(&mut self, b: ElBox, rot: Option<f64>, flip: bool, geom: Geom, src: Option<[f64; 4]>) {
        if let Some([l, t, r, bt]) = src {
            self.x.empty(
                "a:srcRect",
                a!["l" => pct(l), "t" => pct(t), "r" => pct(r), "b" => pct(bt)],
            );
        }
        self.x.raw("<a:stretch><a:fillRect/></a:stretch>");
        self.x.close("p:blipFill");
        self.x.open("p:spPr", a![]);
        self.xfrm(b, rot, flip);
        match geom {
            Geom::Prst(p, adj) => self.geom(p, adj),
            Geom::Raw(g) => self.x.raw(g),
        }
        self.x.close("p:spPr");
        self.x.close("p:pic");
    }

    /// Icon: PNG (4×) als Bild, die SVG-Fassung zusätzlich über asvg:svgBlip (PowerPoint 2016+ zeigt sie scharf).
    fn icon(&mut self, el: &IconEl, name: &str) -> Result<(), Error> {
        let Some(png) = el.png.as_deref().and_then(data_url) else {
            self.warn(format!("{name}: Icon ohne PNG-Fassung, übersprungen"));
            return Ok(());
        };
        let Some(target) = self.pkg.media(el.png.as_deref(), &png) else {
            self.warn(format!("{name}: Icon-PNG unlesbar, übersprungen"));
            return Ok(());
        };
        let rid = self.rels.add("image", target, false);
        let svg = (!el.svg.trim().is_empty()).then(|| {
            let t = self
                .pkg
                .blob(Some(&el.svg), el.svg.as_bytes(), "image", "svg", "image/svg+xml");
            self.rels.add("image", t, false)
        });
        let id = self.id();
        self.shapes
            .insert(name.into(), ShapeInfo::other(id, Kind::Pic, false));
        self.pic_open(id, name, " ", el.base.link.as_deref());
        self.blip(&rid, "", None, svg.as_deref());
        self.pic_close(el.base.bbox, el.base.rot, false, Geom::Prst("rect", None), None);
        Ok(())
    }

    /// Video/Audio eingebettet (p14:media), Vorschaubild = Poster. Fehlt die Datei, Warnung statt leerer Box.
    fn media(&mut self, el: &MediaEl, name: &str) -> Result<(), Error> {
        let Some(bytes) = self.input.media.get(&el.src) else {
            self.warn(format!("{name}: Mediendatei fehlt, übersprungen"));
            return Ok(());
        };
        let ext = el
            .src
            .split(['?', '#'])
            .next()
            .and_then(|p| p.rsplit_once('.'))
            .map(|(_, e)| e.to_ascii_lowercase())
            .unwrap_or_default();
        let Some((ext, ct)) = media_type(&ext) else {
            self.warn(format!("{name}: Medienformat {ext:?} unbekannt, übersprungen"));
            return Ok(());
        };
        let target = self.pkg.blob(Some(&el.src), bytes, "media", ext, ct);
        let poster = el
            .poster
            .as_deref()
            .and_then(|p| self.input.media.get(p).map(|b| (p, b.clone())));
        let poster_target = match poster.and_then(|(p, b)| self.pkg.media(Some(p), &b)) {
            Some(t) => t,
            // PowerPoint braucht ein Vorschaubild: dunkle Fläche statt des Play-Symbols von pptxgenjs
            None => {
                let img = image::RgbImage::from_pixel(16, 9, image::Rgb([32, 32, 32]));
                let mut buf = Cursor::new(Vec::new());
                img.write_to(&mut buf, image::ImageFormat::Png)
                    .expect("PNG in Vec");
                self.pkg
                    .media(Some("dw:poster"), buf.get_ref())
                    .expect("PNG")
            }
        };
        let (kind, tag) = match el.media {
            MediaKind::Video => ("video", "a:videoFile"),
            MediaKind::Audio => ("audio", "a:audioFile"),
        };
        let link = self.rels.add(kind, target.clone(), false);
        let embed = self.rels.add(
            "http://schemas.microsoft.com/office/2007/relationships/media",
            target,
            false,
        );
        let img = self.rels.add("image", poster_target, false);
        let id = self.id();
        self.shapes
            .insert(name.into(), ShapeInfo::other(id, Kind::Pic, false));
        let nv = format!(
            r#"<p:nvPr><{tag} r:link="{link}"/><p:extLst><p:ext uri="{{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="{embed}"/></p:ext></p:extLst></p:nvPr>"#
        );
        self.x.open("p:pic", a![]);
        self.x.open("p:nvPicPr", a![]);
        self.x.open("p:cNvPr", a!["id" => id, "name" => name, "descr" => " "]);
        self.x.raw(r#"<a:hlinkClick r:id="" action="ppaction://media"/>"#);
        self.x.close("p:cNvPr");
        self.x
            .raw(r#"<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>"#);
        self.x.trusted(&nv);
        self.x.close("p:nvPicPr");
        self.x.open("p:blipFill", a![]);
        self.blip(&img, "", None, None);
        self.pic_close(el.base.bbox, el.base.rot, false, Geom::Prst("rect", None), None);
        Ok(())
    }

    /// Natives Diagramm: chartN.xml + xlsx (Daten bearbeiten) + Rahmen auf der Folie.
    fn chart(&mut self, el: &ChartEl, name: &str) -> Result<(), Error> {
        // ohne Serie wäre c:barChart/c:lineChart ohne c:ser ungültig
        if el.spec.series.is_empty() {
            self.warn(format!("{name}: Diagramm ohne Datenreihe, übersprungen"));
            return Ok(());
        }
        let font = self.input.body_font.clone();
        let xml = chart::chart_xml(&el.spec, self.palette, &font)?;
        let xlsx = chart::xlsx(&el.spec, self.palette)?;
        self.pkg.chart_count += 1;
        let n = self.pkg.chart_count;
        let path = format!("ppt/charts/chart{n}.xml");
        let book = format!("ppt/embeddings/Microsoft_Excel_Worksheet{n}.xlsx");
        self.pkg.defaults.insert(
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        self.pkg.part(&book, None, xlsx);
        self.pkg.part(
            &path,
            Some("application/vnd.openxmlformats-officedocument.drawingml.chart+xml"),
            xml,
        );
        let mut r = Rels::default();
        r.add(
            "package",
            format!("../embeddings/Microsoft_Excel_Worksheet{n}.xlsx"),
            false,
        );
        self.pkg.rels(&path, &r);
        let rid = self.rels.add("chart", format!("../charts/chart{n}.xml"), false);
        let id = self.id();
        self.shapes
            .insert(name.into(), ShapeInfo::other(id, Kind::Frame, true));
        let b = el.base.bbox;
        self.x.open("p:graphicFrame", a![]);
        self.x.open("p:nvGraphicFramePr", a![]);
        self.cnvpr(id, name, None, None);
        self.x.raw("<p:cNvGraphicFramePr/><p:nvPr/>");
        self.x.close("p:nvGraphicFramePr");
        self.x.open("p:xfrm", a![]);
        self.x.empty("a:off", a!["x" => emu(b.x), "y" => emu(b.y)]);
        self.x.empty("a:ext", a!["cx" => emu(b.w), "cy" => emu(b.h)]);
        self.x.close("p:xfrm");
        self.x.raw(r#"<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">"#);
        self.x.empty(
            "c:chart",
            a!["xmlns:c" => "http://schemas.openxmlformats.org/drawingml/2006/chart", "r:id" => rid],
        );
        self.x.raw("</a:graphicData></a:graphic>");
        self.x.close("p:graphicFrame");
        Ok(())
    }

    fn table(&mut self, el: &TableEl, name: &str) -> Result<(), Error> {
        let b = el.base.bbox;
        let font = self.font(el.font, &el.font_face);
        let (head, body) = (hex(&el.color)?, hex(&el.line)?);
        let id = self.id();
        self.shapes
            .insert(name.into(), ShapeInfo::other(id, Kind::Frame, false));
        self.x.open("p:graphicFrame", a![]);
        self.x.open("p:nvGraphicFramePr", a![]);
        self.cnvpr(id, name, None, None);
        self.x.raw(r#"<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/>"#);
        self.x.close("p:nvGraphicFramePr");
        self.x.open("p:xfrm", a![]);
        self.x.empty("a:off", a!["x" => emu(b.x), "y" => emu(b.y)]);
        self.x.empty(
            "a:ext",
            a!["cx" => emu(el.col_w.iter().sum()), "cy" => emu(el.row_h.iter().sum())],
        );
        self.x.close("p:xfrm");
        self.x.open("a:graphic", a![]);
        self.x.open(
            "a:graphicData",
            a!["uri" => "http://schemas.openxmlformats.org/drawingml/2006/table"],
        );
        self.x.open("a:tbl", a![]);
        self.x.empty("a:tblPr", a!["firstRow" => 1]);
        self.x.open("a:tblGrid", a![]);
        for w in &el.col_w {
            self.x.empty("a:gridCol", a!["w" => emu(*w)]);
        }
        self.x.close("a:tblGrid");
        for (r, row) in el.cells.iter().enumerate() {
            self.x.open(
                "a:tr",
                a!["h" => emu(el.row_h.get(r).copied().unwrap_or(0.0))],
            );
            for c in 0..el.col_w.len() {
                let text = row.get(c).map(String::as_str).unwrap_or("");
                let algn = if el.align.get(c) == Some(&Align::Right) {
                    "r"
                } else {
                    "l"
                };
                self.x.open("a:tc", a![]);
                self.x.raw("<a:txBody><a:bodyPr/><a:lstStyle/><a:p>");
                self.x.empty("a:pPr", a!["algn" => algn]);
                let rpr = a!["lang" => "de-DE", "sz" => sz(el.size_px), "b" => (r == 0) as u8, "dirty" => 0];
                if !text.is_empty() {
                    self.x.open("a:r", a![]);
                    self.x.open("a:rPr", rpr);
                    self.solid(&el.color, None)?;
                    self.x.empty("a:latin", a!["typeface" => font]);
                    self.x.close("a:rPr");
                    self.x.leaf("a:t", a![], text);
                    self.x.close("a:r");
                }
                self.x.empty("a:endParaRPr", rpr);
                self.x.raw("</a:p></a:txBody>");
                self.x.open("a:tcPr", a!["marL" => emu(TABLE_PAD), "marR" => emu(TABLE_PAD), "marT" => 0, "marB" => 0, "anchor" => "ctr"]);
                self.x.raw("<a:lnL><a:noFill/></a:lnL><a:lnR><a:noFill/></a:lnR><a:lnT><a:noFill/></a:lnT>");
                // Kopf 2 px = 1,5 pt, Körper 1 px = 0,75 pt, nur unten
                self.x
                    .open("a:lnB", a!["w" => emu(if r == 0 { 2.0 } else { 1.0 })]);
                self.x.open("a:solidFill", a![]);
                self.x
                    .empty("a:srgbClr", a!["val" => if r == 0 { &head } else { &body }]);
                self.x.close("a:solidFill");
                self.x.close("a:lnB");
                self.x.empty("a:noFill", a![]);
                self.x.close("a:tcPr");
                self.x.close("a:tc");
            }
            self.x.close("a:tr");
        }
        self.x.close("a:tbl");
        self.x.close("a:graphicData");
        self.x.close("a:graphic");
        self.x.close("p:graphicFrame");
        Ok(())
    }
}

enum Geom {
    Prst(&'static str, Option<i64>),
    Raw(&'static str),
}

// Bildrahmen (patch-xml.ts MASK_GEOM); unbekannte Masken lassen die Geometrie unverändert
fn mask_geom(m: &str) -> Option<&'static str> {
    Some(match m {
        "circle" => r#"<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>"#,
        "arch" => r#"<a:prstGeom prst="round2SameRect"><a:avLst><a:gd name="adj1" fmla="val 50000"/><a:gd name="adj2" fmla="val 0"/></a:avLst></a:prstGeom>"#,
        "hexagon" => r#"<a:prstGeom prst="hexagon"><a:avLst/></a:prstGeom>"#,
        "diamond" => r#"<a:prstGeom prst="diamond"><a:avLst/></a:prstGeom>"#,
        "octagon" => r#"<a:prstGeom prst="octagon"><a:avLst/></a:prstGeom>"#,
        "star" => r#"<a:prstGeom prst="star5"><a:avLst/></a:prstGeom>"#,
        "heart" => r#"<a:prstGeom prst="heart"><a:avLst/></a:prstGeom>"#,
        _ => return None,
    })
}

fn media_type(ext: &str) -> Option<(&'static str, &'static str)> {
    Some(match ext {
        "mp4" => ("mp4", "video/mp4"),
        "m4v" => ("m4v", "video/mp4"),
        "mov" => ("mov", "video/quicktime"),
        "webm" => ("webm", "video/webm"),
        "mp3" => ("mp3", "audio/mpeg"),
        "m4a" => ("m4a", "audio/mp4"),
        "wav" => ("wav", "audio/wav"),
        "ogg" => ("ogg", "audio/ogg"),
        "aac" => ("aac", "audio/aac"),
        _ => return None,
    })
}

fn round_adj(radius: f64, b: ElBox) -> i64 {
    let m = b.w.min(b.h);
    if m <= 0.0 {
        0
    } else {
        pct(radius / m).min(50_000)
    }
}

// export-pptx.ts SHAPE_TYPE
fn shape_type(s: &str) -> &'static str {
    match s {
        "triangle" => "triangle",
        "diamond" => "diamond",
        "hexagon" => "hexagon",
        "star" => "star5",
        "arrow" => "rightArrow",
        "chevron" => "chevron",
        "pentagon" => "homePlate",
        "trapezoid" => "trapezoid",
        "parallelogram" => "parallelogram",
        "rtTriangle" => "rtTriangle",
        "octagon" => "octagon",
        "donut" => "donut",
        "plus" => "plus",
        "heart" => "heart",
        "star4" => "star4",
        "star6" => "star6",
        "star8" => "star8",
        "star12" => "star12",
        _ => "rect",
    }
}
