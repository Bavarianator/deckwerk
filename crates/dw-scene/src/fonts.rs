//! Schriften aus einem Verzeichnis, ohne Systemschriften (gleiches Ergebnis auf jedem Rechner).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parley::fontique::{Blob, Collection, CollectionOptions, FontStyle};
use parley::{FontContext, LayoutContext};

use crate::Error;

struct Face {
    data: Arc<Vec<u8>>,
    family: String,
    weight: u16,
    italic: bool,
}

pub struct FontStore {
    pub(crate) fcx: FontContext,
    pub(crate) lcx: LayoutContext<u32>,
    faces: HashMap<u64, Face>, // Blob-ID → Datei
}

impl Default for FontStore {
    fn default() -> Self {
        Self::new()
    }
}

impl FontStore {
    pub fn new() -> Self {
        let collection = Collection::new(CollectionOptions {
            shared: false,
            system_fonts: false,
        });
        FontStore {
            fcx: FontContext {
                collection,
                source_cache: Default::default(),
            },
            lcx: LayoutContext::new(),
            faces: HashMap::new(),
        }
    }

    /// assets/fonts im Repo.
    pub fn default_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/fonts")
    }

    /// Alle .ttf/.otf eines Verzeichnisses (sortiert, damit die Reihenfolge stabil ist).
    pub fn from_dir(dir: &Path) -> Result<Self, Error> {
        let mut store = FontStore::new();
        let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
            .map_err(|e| Error::Font(format!("{}: {e}", dir.display())))?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| x.eq_ignore_ascii_case("ttf") || x.eq_ignore_ascii_case("otf"))
            })
            .collect();
        paths.sort();
        for p in paths {
            let bytes =
                std::fs::read(&p).map_err(|e| Error::Font(format!("{}: {e}", p.display())))?;
            store.add_font(bytes);
        }
        Ok(store)
    }

    /// Registriert eine Schriftdatei; liefert die Familiennamen.
    pub fn add_font(&mut self, bytes: Vec<u8>) -> Vec<String> {
        let data = Arc::new(bytes);
        let blob = Blob::new(data.clone());
        let id = blob.id();
        let mut names = Vec::new();
        for (fid, infos) in self.fcx.collection.register_fonts(blob, None) {
            let family = self
                .fcx
                .collection
                .family_name(fid)
                .unwrap_or_default()
                .to_string();
            if let Some(info) = infos.first() {
                self.faces.insert(
                    id,
                    Face {
                        data: data.clone(),
                        family: family.clone(),
                        weight: info.weight().value().round() as u16,
                        italic: info.style() != FontStyle::Normal,
                    },
                );
            }
            names.push(family);
        }
        names
    }

    pub(crate) fn font_data(&self, f: &parley::FontData) -> dw_model::FontData {
        match self.faces.get(&f.data.id()) {
            Some(face) => dw_model::FontData {
                data: face.data.clone(),
                index: f.index,
                family: face.family.clone(),
                weight: face.weight,
                italic: face.italic,
            },
            None => dw_model::FontData {
                data: Arc::new(f.data.data().to_vec()),
                index: f.index,
                family: String::new(),
                weight: 400,
                italic: false,
            },
        }
    }
}
