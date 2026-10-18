//! Word-Export (export-docx.ts): jede Folie = eine Seite in Foliengröße. Hintergrund-PNG (ohne Text) hinter dem Text,
//! jedes gemessene Textelement ein bearbeitbares Textfeld an seiner Position. WordprocessingML von Hand, Schriften eingebettet.

use std::io::{Cursor, Write};

use dw_model::{Align, El, FontRole, Measured, Run, Size, TextEl};
pub use dw_pptx::EmbedFont;
use sha2::{Digest, Sha256};

pub struct DocxPage {
    pub measured: Measured,
    pub background: Vec<u8>, // PNG der ganzen Seite
}

pub struct DocxInput {
    pub title: String,
    pub author: String, // APP.name
    pub size: Size,
    /// Theme-Schriften (Word-Namen) für `font: head/body` ohne eigene `fontFace`
    pub head_font: String,
    pub body_font: String,
    pub pages: Vec<DocxPage>,
    pub fonts: Vec<EmbedFont>,
}

// JS Math.round (halbe Werte nach oben)
fn round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}
fn emu(px: f64) -> i64 {
    round(px * 9525.0)
}
// Twips; auch Zwanzigstel-Punkt (px * 0.75 * 20)
fn tw(px: f64) -> i64 {
    round(px * 15.0)
}
fn hex(c: &str) -> String {
    c.replace('#', "").to_uppercase()
}
// Steuerzeichen sind in XML 1.0 verboten (Word meldet sonst ein beschädigtes Dokument)
fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\t' | '\n' | '\r' => o.push(c),
            '\0'..='\x1f' => {}
            '&' | '<' | '>' | '"' => o += &format!("&#{};", c as u32),
            _ => o.push(c),
        }
    }
    o
}
// wie WRAP_SLACK in export-pptx.ts: etwas breiter, damit Word nicht früher umbricht als Chromium
const WRAP_SLACK: f64 = 0.015;

const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
fn ns() -> String {
    format!(r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="{R}""#)
}
fn rels(list: &[String]) -> String {
    format!(r#"{XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}</Relationships>"#, list.concat())
}

// ECMA-376 Teil 1 §17.8.1: Schlüssel = GUID-Bytes in umgekehrter Reihenfolge, nur die ersten 32 Bytes XOR (symmetrisch)
fn obfuscate(ttf: &[u8], font_key: &str) -> Vec<u8> {
    let h: String = font_key.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let mut key: Vec<u8> = (0..16).map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap()).collect();
    key.reverse();
    let mut out = ttf.to_vec();
    for i in 0..32.min(out.len()) {
        out[i] ^= key[i % 16];
    }
    out
}

// ponytail: Schlüssel aus SHA-256 von Familie+Schnitt statt randomUUID (keine uuid-Abhängigkeit); Word prüft nur das Format
fn font_key(family: &str, face: &str) -> String {
    let d = Sha256::digest(format!("{family}/{face}"));
    let x: String = d[..16].iter().map(|b| format!("{b:02X}")).collect();
    format!("{{{}-{}-{}-{}-{}}}", &x[..8], &x[8..12], &x[12..16], &x[16..20], &x[20..32])
}

// Anker an der Seite (nicht am Absatz), ohne Textumfluss
#[allow(clippy::too_many_arguments)]
fn anchor(id: u32, behind: bool, x: f64, y: f64, w: f64, h: f64, name: &str, graphic: &str) -> String {
    format!(
        r#"<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{id}" behindDoc="{}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>{}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>{}</wp:posOffset></wp:positionV><wp:extent cx="{}" cy="{}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="{id}" name="{}"/>{graphic}</wp:anchor></w:drawing></w:r>"#,
        behind as u8, emu(x), emu(y), emu(w), emu(h), esc(name)
    )
}

struct Doc<'a> {
    inp: &'a DocxInput,
    rels: Vec<String>,
    used: Vec<String>, // wie das TS-Set: Einfügereihenfolge, ohne Doppelte
    n: u32,                 // docPr-ID und Ebene (relativeHeight), dokumentweit aufsteigend
}

impl Doc<'_> {
    fn rel(&mut self, kind: &str, target: &str, external: bool) -> String {
        let id = format!("rId{}", self.rels.len() + 1);
        let ext = if external { r#" TargetMode="External""# } else { "" };
        self.rels.push(format!(r#"<Relationship Id="{id}" Type="{R}/{kind}" Target="{}"{ext}/>"#, esc(target)));
        id
    }

    fn run(&mut self, r: &Run, el: &TextEl, f: &str) -> String {
        let sz = round(r.size_px.unwrap_or(el.size_px) * 1.5);
        let track = tw(r.tracking_px.unwrap_or(el.tracking_px));
        // Kontur: gemessene Farbe ist transparent → Words Umriss-Effekt in der Konturfarbe
        let hollow = el.effect.as_ref().filter(|e| e.kind == "hollow");
        let on = |b: bool, s: &'static str| if b { s } else { "" };
        let rpr = format!(
            r#"<w:rPr><w:rFonts w:ascii="{f}" w:hAnsi="{f}" w:cs="{f}"/>{}{}{}{}<w:color w:val="{}"/>{}<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>{}<w:lang w:val="de-DE"/></w:rPr>"#,
            on(r.bold, "<w:b/><w:bCs/>"),
            on(r.italic, "<w:i/><w:iCs/>"),
            on(el.upper, "<w:caps/>"),
            on(hollow.is_some(), "<w:outline/>"),
            hex(hollow.map_or(&r.color, |e| &e.color)),
            if track != 0 { format!(r#"<w:spacing w:val="{track}"/>"#) } else { String::new() },
            on(r.underline == Some(true), r#"<w:u w:val="single"/>"#),
        );
        let xml = format!(
            r#"<w:r>{rpr}<w:t xml:space="preserve">{}</w:t>{}</w:r>"#,
            esc(&r.text),
            on(r.break_after == Some(true), "<w:br/>")
        );
        match r.link.as_deref().filter(|l| !l.is_empty()) {
            Some(l) => format!(r#"<w:hyperlink r:id="{}">{xml}</w:hyperlink>"#, self.rel("hyperlink", l, true)),
            None => xml,
        }
    }

    fn text_box(&mut self, el: &TextEl) -> String {
        let rot = round((el.base.rot.unwrap_or(0.0) % 360.0 + 360.0) % 360.0 * 60000.0); // 0…360° wie Word selbst
        let family = el.font_face.clone().unwrap_or_else(|| match el.font {
            FontRole::Head => self.inp.head_font.clone(),
            FontRole::Body => self.inp.body_font.clone(),
        });
        let f = esc(&family);
        if !self.used.contains(&family) {
            self.used.push(family);
        }
        let b = &el.base.bbox;
        let extra = b.w * WRAP_SLACK;
        let (x, al) = match el.align {
            Align::Center => (b.x - extra / 2.0, "center"),
            Align::Right => (b.x - extra, "right"),
            Align::Left => (b.x, "left"),
        };
        let w = b.w + extra;
        let runs: String = el.runs.iter().map(|r| self.run(r, el, &f)).collect();
        let p = format!(
            r#"<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="{}" w:lineRule="exact"/><w:jc w:val="{al}"/><w:rPr><w:lang w:val="de-DE"/></w:rPr></w:pPr>{runs}</w:p>"#,
            tw(el.line_height_px)
        );
        // einzeilig (Fußzeile, Aktionszeile): nie umbrechen, Word misst minimal anders als Chromium; mehrzeilig wächst das Feld mit dem Text (spAutoFit)
        let one = el.lines <= 1;
        let g = format!(
            r#"<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm rot="{rot}"><a:off x="0" y="0"/><a:ext cx="{}" cy="{}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent>{p}</w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="{}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0">{}</wps:bodyPr></wps:wsp></a:graphicData></a:graphic>"#,
            emu(w),
            emu(b.h),
            if one { "none" } else { "square" },
            if one { "<a:noAutofit/>" } else { "<a:spAutoFit/>" }
        );
        self.n += 1;
        anchor(self.n, false, x, b.y, w, b.h, &el.base.slot, &g)
    }
}

pub fn build_docx(inp: &DocxInput) -> zip::result::ZipResult<Vec<u8>> {
    let (w, h) = (inp.size.w, inp.size.h);
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut d = Doc {
        inp,
        rels: ["styles", "settings", "fontTable"]
            .iter()
            .enumerate()
            .map(|(i, k)| format!(r#"<Relationship Id="rId{}" Type="{R}/{k}" Target="{k}.xml"/>"#, i + 1))
            .collect(),
        used: vec![inp.body_font.clone()],
        n: 0,
    };

    // Pro Folie ein winziger Absatz (1 pt) mit allen Ankern, so entstehen keine leeren Zusatzseiten
    let mut body = String::new();
    for (i, pg) in inp.pages.iter().enumerate() {
        let file = format!("bg{}.png", i + 1);
        files.push((format!("word/media/{file}"), pg.background.clone()));
        d.n += 1;
        let n = d.n;
        let rid = d.rel("image", &format!("media/{file}"), false);
        let g = format!(
            r#"<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{n}" name="{file}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{}" cy="{}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>"#,
            emu(w),
            emu(h)
        );
        let bg = anchor(n, true, 0.0, 0.0, w, h, &file, &g);
        // Formen, Bilder, Icons, Diagramme stecken im Hintergrundbild
        let mut texts = String::new();
        for el in &pg.measured.els {
            if let El::Text(t) = el
                && t.runs.iter().any(|r| !r.text.is_empty())
            {
                texts += &d.text_box(t);
            }
        }
        let brk = if i > 0 { "<w:pageBreakBefore/>" } else { "" };
        body += &format!(
            r#"<w:p><w:pPr>{brk}<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr>{bg}{texts}</w:p>"#
        );
    }
    let orient = if w > h { r#" w:orient="landscape""# } else { "" };
    let sect = format!(
        r#"<w:sectPr><w:pgSz w:w="{}" w:h="{}"{orient}/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>"#,
        tw(w),
        tw(h)
    );

    // Schriften: verwendete Familien in die Schrifttabelle, mitgelieferte TTF verschleiert einbetten
    let mut font_rels: Vec<String> = Vec::new();
    let mut font_xml = String::new();
    for family in &d.used {
        let mut embeds = String::new();
        if let Some(ef) = inp.fonts.iter().find(|f| &f.family == family) {
            let faces = [("Regular", Some(&ef.regular)), ("Bold", ef.bold.as_ref()), ("Italic", ef.italic.as_ref()), ("BoldItalic", ef.bold_italic.as_ref())];
            for (face, ttf) in faces {
                let Some(ttf) = ttf.filter(|t| !t.is_empty()) else { continue };
                let k = font_rels.len() + 1;
                let key = font_key(family, face);
                files.push((format!("word/fonts/font{k}.odttf"), obfuscate(ttf, &key)));
                font_rels.push(format!(r#"<Relationship Id="rId{k}" Type="{R}/font" Target="fonts/font{k}.odttf"/>"#));
                embeds += &format!(r#"<w:embed{face} r:id="rId{k}" w:fontKey="{key}"/>"#);
            }
        }
        font_xml += &format!(r#"<w:font w:name="{}">{embeds}</w:font>"#, esc(family));
    }

    let ns = ns();
    let ct = "application/vnd.openxmlformats-officedocument.wordprocessingml";
    let part = |name: &str, kind: &str| format!(r#"<Override PartName="/word/{name}.xml" ContentType="{ct}.{kind}+xml"/>"#);
    let doc_ns = format!(
        r#"{ns} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape""#
    );
    let bf = esc(&inp.body_font);
    let mut xml = |name: &str, s: String| files.push((name.to_string(), s.into_bytes()));
    xml("[Content_Types].xml", format!(
        r#"{XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>{}{}{}{}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>"#,
        part("document", "document.main"), part("styles", "styles"), part("settings", "settings"), part("fontTable", "fontTable")
    ));
    xml("_rels/.rels", rels(&[
        format!(r#"<Relationship Id="rId1" Type="{R}/officeDocument" Target="word/document.xml"/>"#),
        r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>"#.into(),
    ]));
    xml("docProps/core.xml", format!(
        r#"{XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{}</dc:title><dc:creator>{}</dc:creator></cp:coreProperties>"#,
        esc(&inp.title), inp.author
    ));
    xml("word/document.xml", format!(r#"{XML}<w:document {doc_ns}><w:body>{body}{sect}</w:body></w:document>"#));
    xml("word/_rels/document.xml.rels", rels(&d.rels));
    xml("word/styles.xml", format!(
        r#"{XML}<w:styles {ns}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="{bf}" w:hAnsi="{bf}" w:cs="{bf}" w:eastAsia="{bf}"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>"#
    ));
    xml("word/settings.xml", format!(
        r#"{XML}<w:settings {ns}>{}<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>"#,
        if font_rels.is_empty() { "" } else { "<w:embedTrueTypeFonts/>" }
    ));
    xml("word/fontTable.xml", format!(r#"{XML}<w:fonts {ns}>{font_xml}</w:fonts>"#));
    if !font_rels.is_empty() {
        xml("word/_rels/fontTable.xml.rels", rels(&font_rels));
    }

    let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (p, b) in files {
        z.start_file(p, opt)?;
        z.write_all(&b)?;
    }
    Ok(z.finish()?.into_inner())
}

#[cfg(test)]
mod tests {
    #[test]
    fn obfuscate_is_symmetric() {
        let key = super::font_key("Arimo", "Regular");
        let ttf: Vec<u8> = (0..64).collect();
        let o = super::obfuscate(&ttf, &key);
        assert_ne!(o[..32], ttf[..32]);
        assert_eq!(o[32..], ttf[32..]);
        assert_eq!(super::obfuscate(&o, &key), ttf);
    }
}
