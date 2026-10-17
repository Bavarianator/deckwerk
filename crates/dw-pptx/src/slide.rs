//! Eine Folie: Hintergrundbild, dann die gemessenen Elemente an ihren Positionen (export-pptx.ts addEl).

use std::collections::HashSet;
use std::io::Cursor;

use dw_model::{Align, BoxEl, El, ElBox, FontRole, ImgEl, ImgFit, ListType, Run, TableEl, TextEl};

use crate::parts::{NS_A, NS_P, NS_R};
use crate::xml::{X, a};
use crate::{Error, Pkg, PptxInput, PptxSlide, Rels};

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

fn warn(msg: String) {
    eprintln!("[dw-pptx] {msg}");
}

struct Ctx<'a> {
    x: X,
    rels: Rels,
    pkg: &'a mut Pkg,
    input: &'a PptxInput,
    next_id: u32,
    used: HashSet<String>,
    prefix: &'static str,
}

pub fn slide_xml(
    input: &PptxInput,
    s: &PptxSlide,
    pkg: &mut Pkg,
) -> Result<(Vec<u8>, Rels), Error> {
    let mut c = Ctx {
        x: X::new(),
        rels: Rels::default(),
        pkg,
        input,
        next_id: 2,
        used: HashSet::new(),
        prefix: if s.morph { "!!dw:" } else { "dw:" },
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
            None => warn("Hintergrund ist kein lesbares Bild, übersprungen".into()),
        }
    }
    c.x.raw(r#"<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>"#);
    for el in &s.measured.els {
        let name = c.name(&el.base().slot);
        match el {
            El::Text(t) => c.text(t, &name)?,
            El::Box(b) => c.shape(b, &name)?,
            El::Img(i) => c.img(i, &name)?,
            El::Table(t) => c.table(t, &name)?,
            El::Chart(_) | El::Media(_) | El::Icon(_) => warn(format!(
                "{name}: Diagramm/Medium/Icon im Spike noch nicht exportiert"
            )),
        }
    }
    c.x.raw("</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>");
    c.x.close("p:sld");
    Ok((c.x.done(), c.rels))
}

impl Ctx<'_> {
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
                _ => warn(format!("Folienlink {link} zeigt ins Leere, entfernt")),
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

    fn text(&mut self, el: &TextEl, name: &str) -> Result<(), Error> {
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
        self.cnvpr(id, name, None, None);
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
        self.solid(&r.color, None)?;
        self.x.empty("a:latin", a!["typeface" => font]);
        self.x.empty("a:cs", a!["typeface" => font]);
        // Element-Link gilt für Runs ohne eigenen
        let link = r.link.as_deref().or(el.base.link.as_deref());
        self.hlink(link);
        self.x.close("a:rPr");
        let t = if el.upper {
            r.text.to_uppercase()
        } else {
            r.text.clone()
        };
        self.x.leaf("a:t", a![], &t);
        self.x.close("a:r");
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
            warn(format!("{name}: Verlauf mit {} Stop(s)", g.stops.len()));
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
        let Some(bytes) = self.input.media.get(&el.src) else {
            warn(format!("{name}: Bilddatei fehlt, übersprungen"));
            return Ok(());
        };
        let Some(target) = self.pkg.media(Some(&el.src), bytes) else {
            warn(format!("{name}: unbekanntes Bildformat, übersprungen"));
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
        let (prst, adj) = if el.round == Some(true) {
            ("ellipse", None)
        } else if el.fit == ImgFit::Cover && el.radius > 0.5 {
            ("roundRect", Some(round_adj(el.radius, b)))
        } else {
            ("rect", None)
        };
        let rid = self.rels.add("image", target, false);
        let id = self.id();
        // Alt-Text nie leer und nie der Pfad (Vuln 3)
        let alt = el
            .alt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(" ");
        self.pic_open(id, name, alt, el.base.link.as_deref(), &rid, el.alpha);
        self.pic_close(b, el.base.rot, el.flip == Some(true), prst, adj, src);
        Ok(())
    }

    fn pic_open(
        &mut self,
        id: u32,
        name: &str,
        alt: &str,
        link: Option<&str>,
        rid: &str,
        alpha: Option<f64>,
    ) {
        self.x.open("p:pic", a![]);
        self.x.open("p:nvPicPr", a![]);
        self.cnvpr(id, name, Some(alt), link);
        self.x
            .raw(r#"<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/>"#);
        self.x.close("p:nvPicPr");
        self.x.open("p:blipFill", a![]);
        match alpha.filter(|a| *a < 1.0) {
            Some(al) => {
                self.x.open("a:blip", a!["r:embed" => rid]);
                self.x.empty("a:alphaModFix", a!["amt" => pct(al.max(0.0))]);
                self.x.close("a:blip");
            }
            None => self.x.empty("a:blip", a!["r:embed" => rid]),
        }
    }

    fn pic_close(
        &mut self,
        b: ElBox,
        rot: Option<f64>,
        flip: bool,
        prst: &str,
        adj: Option<i64>,
        src: Option<[f64; 4]>,
    ) {
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
        self.geom(prst, adj);
        self.x.close("p:spPr");
        self.x.close("p:pic");
    }

    fn table(&mut self, el: &TableEl, name: &str) -> Result<(), Error> {
        let b = el.base.bbox;
        let font = self.font(el.font, &el.font_face);
        let (head, body) = (hex(&el.color)?, hex(&el.line)?);
        let id = self.id();
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
