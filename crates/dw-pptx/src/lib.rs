//! PPTX in einem Durchgang: gemessene Elemente + Hintergrund-PNG je Folie → .pptx-Bytes (RUST-REWRITE.md §6.3/6.4).
//! Jedes Teil wird genau einmal geschrieben, Rels und Content-Types kommen aus einem Register.

mod parts;
mod slide;
mod xml;

use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Write};

use dw_model::{Measured, Size};
use xml::{X, a};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ungültige Farbe {0:?}")]
    Color(String),
    #[error("ungültige Foliengröße {0}×{1}")]
    Size(f64, f64),
    #[error("ZIP: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("E/A: {0}")]
    Io(#[from] std::io::Error),
}

pub struct PptxInput {
    pub title: String,
    pub author: String,
    pub size: Size,
    /// Theme-Schriften (PowerPoint-Namen) für `font: head/body` ohne eigene `fontFace`
    pub head_font: String,
    pub body_font: String,
    /// Bilddateien nach `ImgEl.src`; fehlt ein Eintrag, entfällt das Bild mit Warnung
    pub media: HashMap<String, Vec<u8>>,
    pub slides: Vec<PptxSlide>,
}

pub struct PptxSlide {
    pub measured: Measured,
    pub background_png: Option<Vec<u8>>,
    pub notes: Option<String>,
    pub hidden: bool,
    /// diese oder die folgende Folie nutzt Morph → Namen mit `!!dw:`
    pub morph: bool,
}

const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const CT: &str = "application/vnd.openxmlformats-officedocument.presentationml.";

/// Beziehungen eines Teils; die ID ist die Position (rId1 …).
#[derive(Default)]
pub(crate) struct Rels(Vec<(String, String, bool)>);

impl Rels {
    pub fn add(&mut self, kind: &str, target: impl Into<String>, external: bool) -> String {
        let kind = if kind.starts_with("http") {
            kind.to_string()
        } else {
            format!("{REL}{kind}")
        };
        self.0.push((kind, target.into(), external));
        format!("rId{}", self.0.len())
    }
    fn xml(&self) -> Vec<u8> {
        let mut x = X::new();
        x.open(
            "Relationships",
            a!["xmlns" => "http://schemas.openxmlformats.org/package/2006/relationships"],
        );
        for (i, (kind, target, ext)) in self.0.iter().enumerate() {
            let id = format!("rId{}", i + 1);
            if *ext {
                x.empty(
                    "Relationship",
                    a!["Id" => id, "Type" => kind, "Target" => target, "TargetMode" => "External"],
                );
            } else {
                x.empty(
                    "Relationship",
                    a!["Id" => id, "Type" => kind, "Target" => target],
                );
            }
        }
        x.close("Relationships");
        x.done()
    }
}

/// Paket-Register: Teile, Content-Type-Overrides, Medien (ein Bild je `src` nur einmal).
#[derive(Default)]
pub(crate) struct Pkg {
    parts: Vec<(String, Vec<u8>)>,
    overrides: Vec<(String, String)>,
    defaults: BTreeMap<&'static str, &'static str>,
    media_by_src: HashMap<String, String>,
    media_count: usize,
}

impl Pkg {
    fn part(&mut self, path: &str, kind: Option<&str>, body: Vec<u8>) {
        if let Some(k) = kind {
            let ct = if k.contains('/') {
                k.to_string()
            } else {
                format!("{CT}{k}+xml")
            };
            self.overrides.push((format!("/{path}"), ct));
        }
        self.parts.push((path.to_string(), body));
    }
    fn rels(&mut self, path: &str, rels: &Rels) {
        let (dir, file) = path.rsplit_once('/').unwrap_or(("", path));
        let p = if dir.is_empty() {
            format!("_rels/{file}.rels")
        } else {
            format!("{dir}/_rels/{file}.rels")
        };
        self.part(&p, None, rels.xml());
    }
    /// Bild ablegen → Ziel relativ zu ppt/slides. None, wenn das Format unbekannt ist.
    pub fn media(&mut self, src: Option<&str>, bytes: &[u8]) -> Option<String> {
        if let Some(t) = src.and_then(|s| self.media_by_src.get(s)) {
            return Some(t.clone());
        }
        let (ext, ct) = match image::guess_format(bytes).ok()? {
            image::ImageFormat::Png => ("png", "image/png"),
            image::ImageFormat::Jpeg => ("jpeg", "image/jpeg"),
            image::ImageFormat::Gif => ("gif", "image/gif"),
            image::ImageFormat::WebP => ("webp", "image/webp"),
            _ => return None,
        };
        self.defaults.insert(ext, ct);
        self.media_count += 1;
        let n = self.media_count;
        self.part(&format!("ppt/media/image{n}.{ext}"), None, bytes.to_vec());
        let target = format!("../media/image{n}.{ext}");
        if let Some(s) = src {
            self.media_by_src.insert(s.to_string(), target.clone());
        }
        Some(target)
    }
    fn content_types(&self) -> Vec<u8> {
        let mut x = X::new();
        x.open(
            "Types",
            a!["xmlns" => "http://schemas.openxmlformats.org/package/2006/content-types"],
        );
        x.empty("Default", a!["Extension" => "rels", "ContentType" => "application/vnd.openxmlformats-package.relationships+xml"]);
        x.empty(
            "Default",
            a!["Extension" => "xml", "ContentType" => "application/xml"],
        );
        for (ext, ct) in &self.defaults {
            x.empty("Default", a!["Extension" => ext, "ContentType" => ct]);
        }
        for (p, ct) in &self.overrides {
            x.empty("Override", a!["PartName" => p, "ContentType" => ct]);
        }
        x.close("Types");
        x.done()
    }
}

pub fn build_pptx(input: &PptxInput) -> Result<Vec<u8>, Error> {
    let Size { w, h } = input.size;
    let (cx, cy) = (slide::emu(w), slide::emu(h));
    // Grenzen von ST_SlideSizeCoordinate
    if !(914_400..=51_206_400).contains(&cx) || !(914_400..=51_206_400).contains(&cy) {
        return Err(Error::Size(w, h));
    }
    let mut pkg = Pkg::default();
    let n = input.slides.len();

    let mut root = Rels::default();
    root.add("officeDocument", "ppt/presentation.xml", false);
    root.add(
        "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
        "docProps/core.xml",
        false,
    );
    root.add("extended-properties", "docProps/app.xml", false);
    pkg.rels("", &root);
    pkg.part(
        "docProps/core.xml",
        Some("application/vnd.openxmlformats-package.core-properties+xml"),
        parts::core(input),
    );
    pkg.part(
        "docProps/app.xml",
        Some("application/vnd.openxmlformats-officedocument.extended-properties+xml"),
        parts::app(n),
    );

    let mut pres = Rels::default();
    let master = pres.add("slideMaster", "slideMasters/slideMaster1.xml", false);
    let slide_ids: Vec<String> = (1..=n)
        .map(|i| pres.add("slide", format!("slides/slide{i}.xml"), false))
        .collect();
    let notes_master = pres.add("notesMaster", "notesMasters/notesMaster1.xml", false);
    pres.add("theme", "theme/theme1.xml", false);
    pres.add("presProps", "presProps.xml", false);
    pres.add("viewProps", "viewProps.xml", false);
    pres.add("tableStyles", "tableStyles.xml", false);
    pkg.part(
        "ppt/presentation.xml",
        Some("presentation.main"),
        parts::presentation(&master, &notes_master, &slide_ids, cx, cy),
    );
    pkg.rels("ppt/presentation.xml", &pres);

    pkg.part(
        "ppt/presProps.xml",
        Some("presProps"),
        parts::PRES_PROPS.into(),
    );
    pkg.part(
        "ppt/viewProps.xml",
        Some("viewProps"),
        parts::VIEW_PROPS.into(),
    );
    pkg.part(
        "ppt/tableStyles.xml",
        Some("tableStyles"),
        parts::TABLE_STYLES.into(),
    );
    for t in ["theme1", "theme2"] {
        pkg.part(
            &format!("ppt/theme/{t}.xml"),
            Some("application/vnd.openxmlformats-officedocument.theme+xml"),
            parts::theme(input),
        );
    }
    let mut r = Rels::default();
    r.add("slideLayout", "../slideLayouts/slideLayout1.xml", false);
    r.add("theme", "../theme/theme1.xml", false);
    pkg.part(
        "ppt/slideMasters/slideMaster1.xml",
        Some("slideMaster"),
        parts::MASTER.into(),
    );
    pkg.rels("ppt/slideMasters/slideMaster1.xml", &r);
    let mut r = Rels::default();
    r.add("slideMaster", "../slideMasters/slideMaster1.xml", false);
    pkg.part(
        "ppt/slideLayouts/slideLayout1.xml",
        Some("slideLayout"),
        parts::LAYOUT.into(),
    );
    pkg.rels("ppt/slideLayouts/slideLayout1.xml", &r);
    let mut r = Rels::default();
    r.add("theme", "../theme/theme2.xml", false);
    pkg.part(
        "ppt/notesMasters/notesMaster1.xml",
        Some("notesMaster"),
        parts::NOTES_MASTER.into(),
    );
    pkg.rels("ppt/notesMasters/notesMaster1.xml", &r);

    for (i, s) in input.slides.iter().enumerate() {
        let k = i + 1;
        let (xml, mut rels) = slide::slide_xml(input, s, &mut pkg)?;
        if let Some(notes) = s.notes.as_deref().filter(|t| !t.trim().is_empty()) {
            rels.add(
                "notesSlide",
                format!("../notesSlides/notesSlide{k}.xml"),
                false,
            );
            let mut nr = Rels::default();
            nr.add("notesMaster", "../notesMasters/notesMaster1.xml", false);
            nr.add("slide", format!("../slides/slide{k}.xml"), false);
            let path = format!("ppt/notesSlides/notesSlide{k}.xml");
            pkg.part(&path, Some("notesSlide"), parts::notes(notes));
            pkg.rels(&path, &nr);
        }
        let path = format!("ppt/slides/slide{k}.xml");
        pkg.part(&path, Some("slide"), xml);
        pkg.rels(&path, &rels);
    }

    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opt = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("[Content_Types].xml", opt)?;
    zip.write_all(&pkg.content_types())?;
    for (p, body) in &pkg.parts {
        zip.start_file(p.as_str(), opt)?;
        zip.write_all(body)?;
    }
    Ok(zip.finish()?.into_inner())
}
