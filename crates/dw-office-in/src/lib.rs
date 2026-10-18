//! Quellmaterial lesen (Port von src/main/source-text.ts): Text aus TXT/MD/CSV/JSON, DOCX, PPTX, PDF und eingebettete Abbildungen.
use regex::Regex;
use std::io::{Read, Seek};
use std::path::Path;
use std::sync::LazyLock;

pub const SOURCE_MAX: usize = 60_000; // Zeichen; der Rest wird abgeschnitten
const MAX_IMG: usize = 20;
const MAX_BYTES: u64 = 25 << 20; // je Datei und Zip-Eintrag (Zip-Bombe: die Größenangabe im Archiv kann lügen)
const TEXT_EXT: &[&str] = &["txt", "md", "csv", "json"];

/// Text für die KI; Abbildungen stehen darin als `Bild: <name>` und liegen in `images` (Name, Bytes), der Aufrufer legt sie ab.
#[derive(Debug, Default)]
pub struct Source {
    pub text: String,
    pub images: Vec<(String, Vec<u8>)>,
}

static RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[aw]:t(?: [^>]*)?>([^<]*)</[aw]:t>").unwrap());
static PARA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"</[aw]:p>").unwrap());
static SLIDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ppt/slides/slide\d+\.xml$").unwrap());
static NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+").unwrap());
static IMG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(png|jpe?g|gif|webp|svg)$").unwrap()); // kein EMF/WMF
static MEDIA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"Target="\.\./media/([^"]+)""#).unwrap());

fn unxml(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}
// nur Textläufe (<a:t>, <w:t>) je Absatz
fn runs(xml: &str) -> String {
    PARA.split(xml)
        .map(|p| RUN.captures_iter(p).map(|c| unxml(&c[1])).collect::<String>())
        .filter(|t| !t.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
fn capped(r: impl Read) -> Result<Vec<u8>, String> {
    let mut b = Vec::new();
    r.take(MAX_BYTES + 1).read_to_end(&mut b).map_err(|e| e.to_string())?;
    if b.len() as u64 > MAX_BYTES { return Err("Datei ist größer als 25 MB.".into()) }
    Ok(b)
}
fn entry<R: Read + Seek>(z: &mut zip::ZipArchive<R>, n: &str) -> Option<Vec<u8>> {
    capped(z.by_name(n).ok()?).ok()
}
fn clean(n: &str) -> String {
    // Namen aus fremden Dateien nie als Pfad nutzen
    n.rsplit(['/', '\\']).next().unwrap_or("").chars().map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { '-' }).collect()
}

fn office(path: &Path, pptx: bool) -> Result<Source, String> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut parts: Vec<String> = z.file_names().filter_map(|n| n.ok().map(|n| n.to_string())).filter(|n| if pptx { SLIDE.is_match(n) } else { n == "word/document.xml" }).collect();
    parts.sort_by_key(|n| NUM.find(n).and_then(|m| m.as_str().parse::<u32>().ok()).unwrap_or(0));
    let mut s = Source::default();
    let mut out = Vec::new();
    for (i, n) in parts.iter().enumerate() {
        let xml = String::from_utf8_lossy(&entry(&mut z, n).ok_or("Teil zu groß oder unlesbar")?).into_owned();
        let mut lines = vec![runs(&xml)];
        // ponytail: Bilder je Folie/Dokument per Media-Ziel in den .rels, nicht nach Absatz und ohne Mindestgröße; Ausbau wie docxWithImages
        let rels = n.replace("slides/", "slides/_rels/").replace("word/document.xml", "word/_rels/document.xml.rels") + if pptx { ".rels" } else { "" };
        let rels = entry(&mut z, &rels).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        for m in MEDIA.captures_iter(&rels.replace("Target=\"media/", "Target=\"../media/")) {
            let name = &m[1];
            if !IMG.is_match(name) || s.images.len() >= MAX_IMG || s.images.iter().any(|(k, _)| k == &clean(name)) { continue }
            let full = if pptx { format!("ppt/media/{name}") } else { format!("word/media/{name}") };
            if let Some(b) = entry(&mut z, &full) { // fehlt bei verlinkten Bildern
                lines.push(format!("Bild: {}", clean(name)));
                s.images.push((clean(name), b));
            }
        }
        let t = lines.into_iter().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n");
        out.push(if pptx { format!("--- Folie {} ---\n{t}", i + 1) } else { t });
    }
    s.text = out.join(if pptx { "\n\n" } else { "\n" });
    Ok(s)
}

pub fn read_source(path: impl AsRef<Path>) -> Result<Source, String> {
    let path = path.as_ref();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let file = || std::fs::File::open(path).map_err(|e| e.to_string());
    let mut s = match ext.as_str() {
        "pdf" => {
            // wie TS: Poppler pdftotext; ponytail: keine PDF-Abbildungen (pdfimages), Ausbau mit pdfPick-Grenzen
            let o = std::process::Command::new("pdftotext").arg(path).arg("-").output().map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound { "PDF lesen braucht pdftotext (Paket poppler).".into() } else { e.to_string() }
            })?;
            if !o.status.success() { return Err(String::from_utf8_lossy(&o.stderr).into_owned()) }
            Source { text: String::from_utf8_lossy(&o.stdout).into_owned(), ..Default::default() }
        }
        "docx" | "pptx" => office(path, ext == "pptx")?,
        _ if IMG.is_match(&format!(".{ext}")) => {
            let name = clean(&path.to_string_lossy());
            Source { text: format!("Bild: {name}"), images: vec![(name, capped(file()?)?)] }
        }
        // ponytail: Videos (nur Verweis + ffprobe) fehlen, Ausbau mit dw-media
        _ if TEXT_EXT.contains(&ext.as_str()) => Source { text: String::from_utf8_lossy(&capped(file()?)?).into_owned(), ..Default::default() },
        _ => return Err(format!("Dateityp .{ext} wird nicht unterstützt.")),
    };
    if let Some((i, _)) = s.text.char_indices().nth(SOURCE_MAX) { s.text.truncate(i) }
    Ok(s)
}
