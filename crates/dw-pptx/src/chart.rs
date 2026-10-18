//! Natives, editierbares Diagramm: c:chartSpace + eingebettete xlsx für „Daten bearbeiten“.
//! Logik wie Vorschau und TS-Export (charts.ts, export-pptx.ts addChart, pptx-post.ts patchChart), in einem Durchgang.

use std::io::{Cursor, Write};

use dw_color::{Rgb, mix};
use dw_model::{ChartSpec, ChartType};

use crate::slide::hex;
use crate::xml::{X, a};
use crate::{Error, Palette};

const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";

// Seriennamen des Wasserfalls (charts.ts WF)
pub const WF: [&str; 4] = ["Basis (unsichtbar)", "Anstieg", "Rückgang", "Summe"];

/// Werte direkt an Balken statt Wertachse + Gitter; bei sehr vielen Balken zurück zur Achse.
pub fn value_labels(s: &ChartSpec) -> bool {
    !matches!(s.kind, ChartType::Line | ChartType::Donut)
        && s.categories.len() * s.series.len() <= 20
}

pub fn decimals(s: &ChartSpec) -> bool {
    s.series
        .iter()
        .any(|x| x.values.iter().any(|v| v.fract() != 0.0))
}

fn grey(p: &Palette, k: usize) -> String {
    let (bg, muted) = (rgb(&p.bg), rgb(&p.muted));
    mix(bg, muted, 0.55 - 0.12 * (k % 3) as f64).to_hex()
}

fn rgb(c: &str) -> Rgb {
    Rgb::parse(c).unwrap_or(Rgb::BLACK)
}

/// charts.ts chartColors: `highlight` bekommt die Akzentfarbe, alles andere Grau. perPoint nur bei einer Serie bzw. Donut.
pub fn chart_colors(s: &ChartSpec, p: &Palette) -> (Vec<String>, Option<Vec<String>>) {
    let accent = p.chart.first().cloned().unwrap_or_else(|| "#000000".into());
    let h = s.highlight.clone().or_else(|| {
        (matches!(s.kind, ChartType::Bar | ChartType::Hbar)
            && s.series.len() == 1
            && s.categories.len() > 2)
            .then(|| s.categories.last().cloned())
            .flatten()
    });
    let si = h
        .as_ref()
        .and_then(|h| s.series.iter().position(|x| &x.name == h));
    let ci = h
        .as_ref()
        .and_then(|h| s.categories.iter().position(|c| c == h));
    if let Some(si) = si {
        let mut k = 0;
        let per = (0..s.series.len())
            .map(|i| {
                if i == si {
                    accent.clone()
                } else {
                    k += 1;
                    grey(p, k - 1)
                }
            })
            .collect();
        return (per, None);
    }
    if let Some(ci) = ci
        && (s.series.len() == 1 || s.kind == ChartType::Donut)
    {
        let donut = s.kind == ChartType::Donut;
        let pts = (0..s.categories.len())
            .map(|i| {
                if i == ci {
                    accent.clone()
                } else {
                    grey(p, if donut { i } else { 0 })
                }
            })
            .collect();
        return (vec![accent], Some(pts));
    }
    let n = p.chart.len().max(1);
    (
        (0..s.series.len())
            .map(|i| p.chart.get(i % n).cloned().unwrap_or_else(|| accent.clone()))
            .collect(),
        None,
    )
}

/// Wasserfall: erster und letzter Wert sind Summen, dazwischen Veränderungen (charts.ts waterfall).
pub fn waterfall(values: &[f64]) -> [Vec<f64>; 4] {
    let mut w: [Vec<f64>; 4] = Default::default();
    let mut run = 0.0;
    let last = values.len().saturating_sub(1);
    for (i, &v) in values.iter().enumerate() {
        let row = if i == 0 || i == last {
            run = v;
            [0.0, 0.0, 0.0, v]
        } else if v >= 0.0 {
            let r = [run, v, 0.0, 0.0];
            run += v;
            r
        } else {
            run += v;
            [run, 0.0, -v, 0.0]
        };
        for (k, x) in row.into_iter().enumerate() {
            w[k].push(x);
        }
    }
    w
}

/// Lesbare Beschriftung auf einer Füllfarbe (charts.ts readableOn), 6 Hex-Ziffern.
pub fn readable_on(fill: &str) -> &'static str {
    let c = rgb(fill);
    let lin = |v: u8| {
        let c = v as f64 / 255.0;
        if c <= 0.03928 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let l = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    if l > 0.36 { "161616" } else { "FFFFFF" }
}

struct Ser {
    name: String,
    values: Vec<f64>,
    color: String,
}

// Excel-Spalte 0 → A, 25 → Z, 26 → AA
fn col(i: usize) -> String {
    let mut n = i + 1;
    let mut s = vec![];
    while n > 0 {
        n -= 1;
        s.push(b'A' + (n % 26) as u8);
        n /= 26;
    }
    s.reverse();
    String::from_utf8(s).expect("ASCII")
}

fn num(v: f64) -> String {
    if v.is_finite() { format!("{v}") } else { String::new() }
}

/// Daten wie im Diagramm: Wasserfall als vier Serien, sonst die Serien der Vorgabe.
fn series(s: &ChartSpec, p: &Palette) -> Result<Vec<Ser>, Error> {
    let (per, pts) = chart_colors(s, p);
    if s.kind == ChartType::Waterfall {
        let w = waterfall(s.series.first().map(|x| x.values.as_slice()).unwrap_or(&[]));
        let accent = p.chart.first().map(String::as_str).unwrap_or("#000000");
        let colors = [p.bg.as_str(), p.good.as_str(), p.bad.as_str(), accent];
        return w
            .into_iter()
            .enumerate()
            .map(|(k, values)| {
                Ok(Ser {
                    name: WF[k].into(),
                    values,
                    color: hex(colors[k])?,
                })
            })
            .collect();
    }
    // perPoint ?? perSeries; bei einer Serie mit perPoint färbt dPt die Balken
    let colors = pts.clone().unwrap_or(per);
    s.series
        .iter()
        .enumerate()
        .map(|(i, x)| {
            Ok(Ser {
                name: x.name.clone(),
                values: x.values.clone(),
                color: hex(colors.get(i % colors.len().max(1)).map(String::as_str).unwrap_or("#000000"))?,
            })
        })
        .collect()
}

fn solid(x: &mut X, c: &str) {
    x.open("a:solidFill", a![]);
    x.empty("a:srgbClr", a!["val" => c]);
    x.close("a:solidFill");
}

fn no_line(x: &mut X) {
    x.raw("<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>");
}

fn txpr(x: &mut X, sz: u32, bold: bool, color: &str, font: &str) {
    x.raw("<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>");
    x.open("a:defRPr", a!["sz" => sz, "b" => bold as u8]);
    solid(x, color);
    x.empty("a:latin", a!["typeface" => font]);
    x.close("a:defRPr");
    x.raw(r#"</a:pPr><a:endParaRPr lang="de-DE"/></a:p></c:txPr>"#);
}

fn flags(x: &mut X, val: bool, ser: bool) {
    x.empty("c:showLegendKey", a!["val" => 0]);
    x.empty("c:showVal", a!["val" => val as u8]);
    x.empty("c:showCatName", a!["val" => 0]);
    x.empty("c:showSerName", a!["val" => ser as u8]);
    x.empty("c:showPercent", a!["val" => 0]);
    x.empty("c:showBubbleSize", a!["val" => 0]);
}

fn str_ref(x: &mut X, f: &str, vals: &[String]) {
    x.open("c:strRef", a![]);
    x.leaf("c:f", a![], f);
    x.open("c:strCache", a![]);
    x.empty("c:ptCount", a!["val" => vals.len()]);
    for (i, v) in vals.iter().enumerate() {
        x.open("c:pt", a!["idx" => i]);
        x.leaf("c:v", a![], v);
        x.close("c:pt");
    }
    x.close("c:strCache");
    x.close("c:strRef");
}

fn num_ref(x: &mut X, f: &str, vals: &[f64]) {
    x.open("c:numRef", a![]);
    x.leaf("c:f", a![], f);
    x.open("c:numCache", a![]);
    x.leaf("c:formatCode", a![], "General");
    x.empty("c:ptCount", a!["val" => vals.len()]);
    for (i, v) in vals.iter().enumerate() {
        x.open("c:pt", a!["idx" => i]);
        x.leaf("c:v", a![], &num(*v));
        x.close("c:pt");
    }
    x.close("c:numCache");
    x.close("c:numRef");
}

fn tx(x: &mut X, i: usize, ser: &Ser) {
    x.open("c:tx", a![]);
    str_ref(x, &format!("Sheet1!${}$1", col(i + 1)), std::slice::from_ref(&ser.name));
    x.close("c:tx");
}

fn cat_val(x: &mut X, i: usize, ser: &Ser, cats: &[String]) {
    let n = cats.len() + 1;
    x.open("c:cat", a![]);
    str_ref(x, &format!("Sheet1!$A$2:$A${n}"), cats);
    x.close("c:cat");
    x.open("c:val", a![]);
    let c = col(i + 1);
    num_ref(x, &format!("Sheet1!${c}$2:${c}${n}"), &ser.values);
    x.close("c:val");
}

/// chartN.xml. `font` = Textschrift des Themes.
pub fn chart_xml(s: &ChartSpec, p: &Palette, font: &str) -> Result<Vec<u8>, Error> {
    let sers = series(s, p)?;
    let (text, muted, border, bg) = (hex(&p.text)?, hex(&p.muted)?, hex(&p.border)?, hex(&p.bg)?);
    let mut x = X::new();
    x.open(
        "c:chartSpace",
        a!["xmlns:c" => NS_C, "xmlns:a" => crate::parts::NS_A, "xmlns:r" => crate::parts::NS_R],
    );
    x.raw(r#"<c:date1904 val="0"/><c:roundedCorners val="0"/><c:chart><c:autoTitleDeleted val="1"/><c:plotArea>"#);
    let line = s.kind == ChartType::Line;
    let wf = s.kind == ChartType::Waterfall;
    let stacked = s.kind == ChartType::Stacked || wf;
    let labels = value_labels(s);
    let cats = &s.categories;
    let numfmt = if decimals(s) { "#,##0.0" } else { "#,##0" };

    if line && s.series.len() > 1 {
        // Platz rechts für die Seriennamen am Linienende
        x.raw(r#"<c:layout><c:manualLayout><c:layoutTarget val="inner"/><c:xMode val="edge"/><c:yMode val="edge"/><c:x val="0.07"/><c:y val="0.05"/><c:w val="0.74"/><c:h val="0.82"/></c:manualLayout></c:layout>"#);
    } else {
        x.raw("<c:layout/>");
    }

    if s.kind == ChartType::Donut {
        let (_, pts) = chart_colors(s, p);
        let colors = match pts {
            Some(c) => c,
            None => p.chart.clone(),
        };
        let ser = s.series.first();
        x.raw(r#"<c:doughnutChart><c:varyColors val="1"/>"#);
        x.open("c:ser", a![]);
        x.raw(r#"<c:idx val="0"/><c:order val="0"/>"#);
        let one = Ser {
            name: ser.map(|x| x.name.clone()).unwrap_or_default(),
            values: ser.map(|x| x.values.clone()).unwrap_or_default(),
            color: String::new(),
        };
        tx(&mut x, 0, &one);
        for i in 0..cats.len() {
            let c = hex(colors.get(i % colors.len().max(1)).map(String::as_str).unwrap_or("#000000"))?;
            x.open("c:dPt", a![]);
            x.empty("c:idx", a!["val" => i]);
            x.raw(r#"<c:bubble3D val="0"/><c:spPr>"#);
            solid(&mut x, &c);
            // Fugen in Hintergrundfarbe, 2 pt
            x.open("a:ln", a!["w" => 25400]);
            solid(&mut x, &bg);
            x.close("a:ln");
            x.raw("</c:spPr>");
            x.close("c:dPt");
        }
        x.open("c:dLbls", a![]);
        flags(&mut x, false, false);
        x.close("c:dLbls");
        cat_val(&mut x, 0, &one, cats);
        x.close("c:ser");
        x.raw(r#"<c:firstSliceAng val="0"/><c:holeSize val="62"/></c:doughnutChart>"#);
        no_line(&mut x);
        x.raw("</c:plotArea>");
        legend(&mut x, "r", &text, font);
        x.raw(r#"<c:plotVisOnly val="1"/><c:dispBlanksAs val="span"/></c:chart>"#);
        finish(&mut x);
        return Ok(x.done());
    }

    let hbar = s.kind == ChartType::Hbar;
    let col_dir = !hbar;
    if line {
        x.raw(r#"<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>"#);
    } else {
        x.open("c:barChart", a![]);
        x.empty("c:barDir", a!["val" => if hbar { "bar" } else { "col" }]);
        x.empty(
            "c:grouping",
            a!["val" => if stacked { "stacked" } else { "clustered" }],
        );
        x.empty("c:varyColors", a!["val" => 0]);
    }
    let (_, pts) = chart_colors(s, p);
    let lines = if line { sers.len() } else { 0 };
    for (i, ser) in sers.iter().enumerate() {
        x.open("c:ser", a![]);
        x.empty("c:idx", a!["val" => i]);
        x.empty("c:order", a!["val" => i]);
        tx(&mut x, i, ser);
        let base = wf && i == 0;
        x.open("c:spPr", a![]);
        if base {
            // unsichtbarer Sockel
            x.raw("<a:noFill/><a:ln><a:noFill/></a:ln>");
        } else {
            solid(&mut x, &ser.color);
            if line {
                x.open("a:ln", a!["w" => 28575, "cap" => "rnd"]);
                solid(&mut x, &ser.color);
                x.raw(r#"<a:prstDash val="solid"/><a:round/>"#);
                x.close("a:ln");
            }
        }
        x.close("c:spPr");
        if line {
            x.raw(r#"<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>"#);
            solid(&mut x, &ser.color);
            x.open("a:ln", a!["w" => 9525]);
            solid(&mut x, &ser.color);
            x.close("a:ln");
            x.raw("</c:spPr></c:marker>");
        } else {
            x.empty("c:invertIfNegative", a!["val" => 0]);
            // eine Serie mit Fokuskategorie: Farbe je Balken
            if let (Some(pts), 1, false) = (pts.as_ref().filter(|p| p.len() > 1), sers.len(), wf) {
                for (k, c) in pts.iter().enumerate() {
                    x.open("c:dPt", a![]);
                    x.empty("c:idx", a!["val" => k]);
                    x.raw(r#"<c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:spPr>"#);
                    solid(&mut x, &hex(c)?);
                    x.raw("</c:spPr>");
                    x.close("c:dPt");
                }
            }
        }
        if base {
            x.raw(r#"<c:dLbls><c:delete val="1"/></c:dLbls>"#);
        } else if lines > 1 && !ser.values.is_empty() {
            // Linien mit mehreren Serien: Name am letzten Punkt statt Legende
            x.open("c:dLbls", a![]);
            x.open("c:dLbl", a![]);
            x.empty("c:idx", a!["val" => ser.values.len() - 1]);
            no_line(&mut x);
            txpr(&mut x, 1100, true, &ser.color, font);
            x.empty("c:dLblPos", a!["val" => "r"]);
            flags(&mut x, false, true);
            x.close("c:dLbl");
            flags(&mut x, false, false);
            x.close("c:dLbls");
        } else {
            // Waterfall: Vorzeichen im Format, Nullen unsichtbar
            let own = if ser.values.iter().any(|v| v.fract() != 0.0) {
                "#,##0.0"
            } else {
                "#,##0"
            };
            let code = match (wf, i) {
                (true, 1) => format!("+{own};;;"),
                (true, 2) => format!("\"−\"{own};;;"),
                (true, _) => format!("{own};;;"),
                _ => numfmt.to_string(),
            };
            let color = if stacked { readable_on(&ser.color) } else { &text };
            x.open("c:dLbls", a![]);
            x.empty("c:numFmt", a!["formatCode" => code, "sourceLinked" => 0]);
            txpr(&mut x, 1400, true, color, font);
            // gruppierte Balken: ohne dLblPos (PowerPoint-Standard = außen), wie die TS-Ausgabe
            if stacked {
                x.empty("c:dLblPos", a!["val" => "ctr"]);
            }
            flags(&mut x, labels, false);
            x.close("c:dLbls");
        }
        cat_val(&mut x, i, ser, cats);
        if line {
            x.empty("c:smooth", a!["val" => 0]);
        }
        x.close("c:ser");
    }
    if line {
        x.raw(r#"<c:marker val="1"/>"#);
    } else {
        x.empty("c:gapWidth", a!["val" => 40]);
        x.empty("c:overlap", a!["val" => if stacked { 100 } else { 0 }]);
    }
    x.raw(r#"<c:axId val="2094734554"/><c:axId val="2094734552"/>"#);
    x.raw(if line { "</c:lineChart>" } else { "</c:barChart>" });

    // negative Werte: Nulllinie bleibt, Beschriftung unten statt mitten in den Balken
    let neg = !wf && !line && s.series.iter().any(|x| x.values.iter().any(|v| *v < 0.0));
    x.raw(r#"<c:catAx><c:axId val="2094734554"/><c:scaling>"#);
    x.empty("c:orientation", a!["val" => if hbar { "maxMin" } else { "minMax" }]);
    x.raw(r#"</c:scaling><c:delete val="0"/>"#);
    x.empty("c:axPos", a!["val" => if col_dir { "b" } else { "l" }]);
    x.raw(r#"<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>"#);
    x.empty(
        "c:tickLblPos",
        a!["val" => if neg || col_dir { "low" } else { "nextTo" }],
    );
    x.raw("<c:spPr>");
    x.open("a:ln", a!["w" => 12700]);
    solid(&mut x, &border);
    x.close("a:ln");
    x.raw("</c:spPr>");
    txpr(&mut x, 1400, false, &muted, font);
    x.raw(r#"<c:crossAx val="2094734552"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="1"/></c:catAx>"#);

    x.raw(r#"<c:valAx><c:axId val="2094734552"/><c:scaling><c:orientation val="minMax"/></c:scaling>"#);
    x.empty("c:delete", a!["val" => labels as u8]);
    x.empty("c:axPos", a!["val" => if col_dir { "l" } else { "b" }]);
    if !labels {
        x.raw("<c:majorGridlines><c:spPr>");
        x.open("a:ln", a!["w" => 9525]);
        solid(&mut x, &border);
        x.close("a:ln");
        x.raw("</c:spPr></c:majorGridlines>");
    }
    x.raw(r#"<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>"#);
    x.empty(
        "c:tickLblPos",
        a!["val" => if col_dir { "nextTo" } else { "low" }],
    );
    x.raw(r#"<c:spPr><a:ln w="12700"><a:noFill/></a:ln></c:spPr>"#);
    txpr(&mut x, 1400, false, &muted, font);
    x.raw(r#"<c:crossAx val="2094734554"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>"#);
    no_line(&mut x);
    x.raw("</c:plotArea>");
    if !line && !wf && s.series.len() > 1 {
        legend(&mut x, "t", &text, font);
    }
    x.raw(r#"<c:plotVisOnly val="1"/><c:dispBlanksAs val="span"/></c:chart>"#);
    finish(&mut x);
    Ok(x.done())
}

fn legend(x: &mut X, pos: &str, color: &str, font: &str) {
    x.open("c:legend", a![]);
    x.empty("c:legendPos", a!["val" => pos]);
    x.empty("c:overlay", a!["val" => 0]);
    txpr(x, 1400, false, color, font);
    x.close("c:legend");
}

fn finish(x: &mut X) {
    x.raw(r#"<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>"#);
}

/// Minimale xlsx mit den Diagrammdaten (A = Kategorien, ab B je Serie), damit „Daten bearbeiten“ in PowerPoint geht.
pub fn xlsx(s: &ChartSpec, p: &Palette) -> Result<Vec<u8>, Error> {
    let sers = series(s, p)?;
    let mut x = X::new();
    x.open(
        "worksheet",
        a!["xmlns" => "http://schemas.openxmlformats.org/spreadsheetml/2006/main"],
    );
    x.open("sheetData", a![]);
    let cell_s = |x: &mut X, r: &str, v: &str| {
        x.open("c", a!["r" => r, "t" => "inlineStr"]);
        x.open("is", a![]);
        x.leaf("t", a![], v);
        x.close("is");
        x.close("c");
    };
    x.open("row", a!["r" => 1]);
    for (i, ser) in sers.iter().enumerate() {
        cell_s(&mut x, &format!("{}1", col(i + 1)), &ser.name);
    }
    x.close("row");
    for (k, cat) in s.categories.iter().enumerate() {
        let r = k + 2;
        x.open("row", a!["r" => r]);
        cell_s(&mut x, &format!("A{r}"), cat);
        for (i, ser) in sers.iter().enumerate() {
            if let Some(v) = ser.values.get(k).filter(|v| v.is_finite()) {
                x.open("c", a!["r" => format!("{}{r}", col(i + 1))]);
                x.leaf("v", a![], &num(*v));
                x.close("c");
            }
        }
        x.close("row");
    }
    x.close("sheetData");
    x.close("worksheet");
    let sheet = x.done();

    let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opt = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (path, body) in [
        ("[Content_Types].xml", XLSX_TYPES.as_bytes()),
        ("_rels/.rels", XLSX_ROOT_RELS.as_bytes()),
        ("xl/workbook.xml", XLSX_WORKBOOK.as_bytes()),
        ("xl/_rels/workbook.xml.rels", XLSX_WB_RELS.as_bytes()),
        ("xl/worksheets/sheet1.xml", &sheet),
    ] {
        z.start_file(path, opt)?;
        z.write_all(body)?;
    }
    Ok(z.finish()?.into_inner())
}

const XLSX_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#;
const XLSX_ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;
const XLSX_WORKBOOK: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
const XLSX_WB_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excel_columns() {
        assert_eq!(col(0), "A");
        assert_eq!(col(25), "Z");
        assert_eq!(col(26), "AA");
    }

    #[test]
    fn waterfall_splits() {
        let w = waterfall(&[100.0, 20.0, -30.0, 90.0]);
        assert_eq!(w[0], [0.0, 100.0, 90.0, 0.0]);
        assert_eq!(w[1], [0.0, 20.0, 0.0, 0.0]);
        assert_eq!(w[2], [0.0, 0.0, 30.0, 0.0]);
        assert_eq!(w[3], [100.0, 0.0, 0.0, 90.0]);
    }
}
