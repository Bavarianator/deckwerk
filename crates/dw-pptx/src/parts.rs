//! Paketteile außer den Folien. Feste Teile als Konstanten (keine Nutzerdaten), der Rest über den Writer.

use crate::PptxInput;
use crate::xml::{X, a};

pub const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
pub const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
pub const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

pub fn core(input: &PptxInput) -> Vec<u8> {
    let mut x = X::new();
    x.open(
        "cp:coreProperties",
        a![
            "xmlns:cp" => "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
            "xmlns:dc" => "http://purl.org/dc/elements/1.1/",
            "xmlns:dcterms" => "http://purl.org/dc/terms/",
            "xmlns:xsi" => "http://www.w3.org/2001/XMLSchema-instance",
        ],
    );
    x.leaf("dc:title", a![], &input.title);
    x.leaf("dc:creator", a![], &input.author);
    x.leaf("cp:lastModifiedBy", a![], &input.author);
    x.close("cp:coreProperties");
    x.done()
}

pub fn app(slides: usize) -> Vec<u8> {
    let mut x = X::new();
    x.open(
        "Properties",
        a!["xmlns" => "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"],
    );
    x.leaf("Application", a![], "Deckwerk");
    x.leaf("Slides", a![], &slides.to_string());
    x.close("Properties");
    x.done()
}

pub fn presentation(
    master: &str,
    notes_master: &str,
    slides: &[String],
    cx: i64,
    cy: i64,
) -> Vec<u8> {
    let mut x = X::new();
    x.open(
        "p:presentation",
        a!["xmlns:a" => NS_A, "xmlns:r" => NS_R, "xmlns:p" => NS_P],
    );
    x.open("p:sldMasterIdLst", a![]);
    x.empty("p:sldMasterId", a!["id" => 2147483648u32, "r:id" => master]);
    x.close("p:sldMasterIdLst");
    x.open("p:notesMasterIdLst", a![]);
    x.empty("p:notesMasterId", a!["r:id" => notes_master]);
    x.close("p:notesMasterIdLst");
    if !slides.is_empty() {
        x.open("p:sldIdLst", a![]);
        for (i, rid) in slides.iter().enumerate() {
            x.empty("p:sldId", a!["id" => 256 + i, "r:id" => rid]);
        }
        x.close("p:sldIdLst");
    }
    x.empty("p:sldSz", a!["cx" => cx, "cy" => cy]);
    x.empty("p:notesSz", a!["cx" => 6858000, "cy" => 9144000]);
    x.close("p:presentation");
    x.done()
}

pub fn theme(input: &PptxInput) -> Vec<u8> {
    let mut x = X::new();
    x.open("a:theme", a!["xmlns:a" => NS_A, "name" => "Deckwerk"]);
    x.raw(THEME_COLORS);
    x.open("a:fontScheme", a!["name" => "Deckwerk"]);
    for (tag, font) in [
        ("a:majorFont", &input.head_font),
        ("a:minorFont", &input.body_font),
    ] {
        x.open(tag, a![]);
        x.empty("a:latin", a!["typeface" => font]);
        x.empty("a:ea", a!["typeface" => ""]);
        x.empty("a:cs", a!["typeface" => ""]);
        x.close(tag);
    }
    x.close("a:fontScheme");
    x.raw(THEME_FMT);
    x.close("a:theme");
    x.done()
}

pub fn notes(notes: &str) -> Vec<u8> {
    let mut x = X::new();
    x.open(
        "p:notes",
        a!["xmlns:a" => NS_A, "xmlns:r" => NS_R, "xmlns:p" => NS_P],
    );
    x.raw(r#"<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Folienbild"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notizen"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>"#);
    for line in notes.lines() {
        x.open("a:p", a![]);
        x.open("a:r", a![]);
        x.empty("a:rPr", a!["lang" => "de-DE", "dirty" => 0]);
        x.leaf("a:t", a![], line);
        x.close("a:r");
        x.close("a:p");
    }
    x.raw("</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>");
    x.close("p:notes");
    x.done()
}

pub const MASTER: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>"#;
pub const LAYOUT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Leer"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#;
pub const NOTES_MASTER: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>"#;
pub const PRES_PROPS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>"#;
pub const VIEW_PROPS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>"#;
pub const TABLE_STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>"#;
const THEME_COLORS: &str = r#"<a:themeElements><a:clrScheme name="Deckwerk"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="DC2626"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="CA8A04"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>"#;
const THEME_FMT: &str = r#"<a:fmtScheme name="Deckwerk"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements>"#;
