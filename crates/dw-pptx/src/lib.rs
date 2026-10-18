//! PPTX in einem Durchgang: gemessene Elemente + Hintergrund-PNG je Folie → .pptx-Bytes (RUST-REWRITE.md §6.3/6.4).
//! Jedes Teil wird genau einmal geschrieben, Rels und Content-Types kommen aus einem Register.

pub mod anim;
pub mod chart;
mod deckinfo;
pub mod fonts;
mod parts;
mod slide;
mod xml;

use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Write};

use dw_model::{Measured, Size};
use xml::{X, a};

pub use deckinfo::{agenda_links, sections};
pub use fonts::EmbedFont;

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

/// Theme-Farben, die der Export braucht: Diagramme (charts.ts chartColors) und Duotone (themes.ts duotoneOf).
#[derive(Debug, Clone, PartialEq)]
pub struct Palette {
    pub bg: String,
    pub text: String,
    pub muted: String,
    pub border: String,
    pub good: String,
    pub bad: String,
    pub chart: Vec<String>,
    /// [dunkel, hell]
    pub duotone: (String, String),
}

impl Default for Palette {
    fn default() -> Self {
        let s = |v: &str| v.to_string();
        Palette {
            bg: s("#FFFFFF"),
            text: s("#161616"),
            muted: s("#6B6B6B"),
            border: s("#D9D9D9"),
            good: s("#1E7A45"),
            bad: s("#B83227"),
            chart: vec![s("#2563EB"), s("#6B6B6B"), s("#A3A3A3")],
            duotone: (s("#0F2A5E"), s("#C8D6F5")),
        }
    }
}

/// Was über `PptxInput` hinaus aus dem Deck kommt. Alles optional; `Default` = Export wie `build_pptx`.
#[derive(Debug, Clone, Default)]
pub struct PptxOpts {
    /// deck.mode == "auto": keine Klicks, alles nacheinander
    pub auto: bool,
    pub palette: Palette,
    /// je Folie (Index wie `PptxInput.slides`); fehlende Einträge = Standard
    pub slides: Vec<SlideOpts>,
    /// eingebettete Schriften; Office-Schriften gehören nicht hierher
    pub fonts: Vec<EmbedFont>,
}

#[derive(Debug, Clone, Default)]
pub struct SlideOpts {
    /// Übergang an der Grenze zu dieser Folie (deck.ts transitionOf); auf Folie 1 ignoriert
    pub transition: Option<String>,
    /// slow | fast
    pub transition_speed: Option<String>,
    /// Aufbau-Preset (layouts.ts buildOf)
    pub build: Option<String>,
    /// Start und Verzögerung (s) freier Elemente nach Slot `items.<id>` (Item.animStart/animDelay)
    pub items: HashMap<String, (Option<String>, f64)>,
    /// Name des Abschnitts, den diese Folie beginnt (Kapiteltrenner), siehe `sections`
    pub section: Option<String>,
    /// Agenda-Punkt k → Folienindex (0-basiert), siehe `agenda_links`
    pub agenda: Vec<(usize, usize)>,
    /// Farben bei abweichendem Folien-Ton
    pub palette: Option<Palette>,
}

pub struct PptxOutput {
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
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
    pub(crate) defaults: BTreeMap<&'static str, &'static str>,
    media_by_src: HashMap<String, String>,
    media_count: usize,
    pub(crate) chart_count: usize,
}

impl Pkg {
    pub(crate) fn part(&mut self, path: &str, kind: Option<&str>, body: Vec<u8>) {
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
    pub(crate) fn rels(&mut self, path: &str, rels: &Rels) {
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
        Some(self.blob(src, bytes, "image", ext, ct))
    }
    /// Beliebige Datei unter ppt/media (ein Eintrag je `key`) → Ziel relativ zu ppt/slides.
    pub fn blob(
        &mut self,
        key: Option<&str>,
        bytes: &[u8],
        stem: &str,
        ext: &'static str,
        ct: &'static str,
    ) -> String {
        if let Some(t) = key.and_then(|s| self.media_by_src.get(s)) {
            return t.clone();
        }
        self.defaults.insert(ext, ct);
        self.media_count += 1;
        let n = self.media_count;
        self.part(&format!("ppt/media/{stem}{n}.{ext}"), None, bytes.to_vec());
        let target = format!("../media/{stem}{n}.{ext}");
        if let Some(s) = key {
            self.media_by_src.insert(s.to_string(), target.clone());
        }
        target
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

/// Wie `build_pptx_with` ohne Deck-Optionen; Warnungen gehen nach stderr.
pub fn build_pptx(input: &PptxInput) -> Result<Vec<u8>, Error> {
    let out = build_pptx_with(input, &PptxOpts::default())?;
    for w in &out.warnings {
        eprintln!("[dw-pptx] {w}");
    }
    Ok(out.bytes)
}

pub fn build_pptx_with(input: &PptxInput, opts: &PptxOpts) -> Result<PptxOutput, Error> {
    let mut warnings = vec![];
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
    let fonts = embed_fonts(&opts.fonts, &mut pres, &mut pkg, &mut warnings);
    let none = SlideOpts::default();
    let so = |i: usize| opts.slides.get(i).unwrap_or(&none);
    let secs: Vec<Option<String>> = (0..n).map(|i| so(i).section.clone()).collect();
    pkg.part(
        "ppt/presentation.xml",
        Some("presentation.main"),
        parts::presentation(&master, &notes_master, &slide_ids, cx, cy, &fonts, &secs),
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

    let mut prev = vec![];
    for (i, s) in input.slides.iter().enumerate() {
        let k = i + 1;
        let (xml, mut rels) =
            slide::slide_xml(input, opts, i, s, &mut pkg, &mut prev, &mut warnings)?;
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
    Ok(PptxOutput {
        bytes: zip.finish()?.into_inner(),
        warnings,
    })
}

/// Schnitte → EOT-Teile + Rels an presentation.xml; Rückgabe: (typeface, serif, [(Schnitt, rId)]).
fn embed_fonts(
    fonts: &[EmbedFont],
    pres: &mut Rels,
    pkg: &mut Pkg,
    warnings: &mut Vec<String>,
) -> Vec<parts::Font> {
    let mut out = vec![];
    let mut n = 0;
    for f in fonts {
        if out.iter().any(|(fam, _, _): &parts::Font| fam == &f.family) {
            continue;
        }
        let faces = [
            ("regular", Some(&f.regular)),
            ("bold", f.bold.as_ref()),
            ("italic", f.italic.as_ref()),
            ("boldItalic", f.bold_italic.as_ref()),
        ];
        let mut refs = vec![];
        for (face, ttf) in faces {
            let Some(ttf) = ttf else { continue };
            // „restricted“: nicht einbetten statt das Bit zu löschen (RUST-REWRITE §7.1 S14)
            match fonts::fs_type(ttf) {
                // mehrere Bits: das am wenigsten strenge gilt
                Ok(t) if t & 0x0002 != 0 && t & 0x000C == 0 => {
                    warnings.push(format!(
                        "{} {face}: Lizenz verbietet Einbetten (fsType restricted), nicht eingebettet",
                        f.family
                    ));
                    continue;
                }
                Ok(_) => {}
                Err(e) => {
                    warnings.push(format!("{} {face} nicht einbettbar: {e}", f.family));
                    continue;
                }
            }
            match fonts::ttf_to_eot(ttf) {
                Ok(eot) => {
                    n += 1;
                    let path = format!("fonts/font{n}.fntdata");
                    pkg.defaults.insert("fntdata", "application/x-fontdata");
                    pkg.part(&format!("ppt/{path}"), None, eot);
                    refs.push((face, pres.add("font", path, false)));
                }
                Err(e) => warnings.push(format!("{} {face} nicht einbettbar: {e}", f.family)),
            }
        }
        if !refs.is_empty() {
            out.push((f.family.clone(), f.serif, refs));
        }
    }
    out
}
