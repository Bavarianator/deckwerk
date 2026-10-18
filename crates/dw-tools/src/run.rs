//! Ausführung der Werkzeuge (tools.ts `run`). Gelesen wird die gegen das Schema geprüfte Eingabe als JSON:
//! fehlt = unverändert, null = entfernen, wie in TS. Das Deck wird als JSON bearbeitet und beim Speichern als
//! `dw_model::Deck` gelesen, damit unbekannte Felder (Pro, Film, Podcast) erhalten bleiben.

use std::collections::{BTreeSet, HashSet};
use std::hash::{BuildHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use dw_lint::theme::{BrandGiven, FontInfo, Level, ThemeIssue, ThemeLintOpts};
use dw_lint::video::{ClipContent, ClipInfo, OtherClip, SlideRef, lint_clip, parts_length};
use dw_lint::{Issue, LintCtx, LintTheme, Severity};
use dw_model::{Deck, El, Measured, ThemeRef};
use serde_json::{Map, Value, json};

use crate::catalog::{self, validate_content};
use crate::{HookOut, PRO, ToolOutput, Tools, asset_path, asset_url, lock, mime_of};

type R = Result<ToolOutput, String>;

// ---------- Texte (tools.ts) ----------

const PREVIEW: [&str; 4] = ["cover", "kpi-grid", "chart", "section"];
const PREVIEW_HINT: &str = "Bild: das Theme an Musterfolien (Cover, Kennzahlen, Diagramm, Kapiteltrenner mit Akzentfläche; Texte sind Platzhalter). Kritisch prüfen: eigenständig statt generisch, passend zur Stimmung, Akzent und Schriften mit Charakter? Wenn nicht, jetzt mit update_deck.customTheme nachschärfen, dann add_slides.";
const ART_DIRECTOR: &str = "Prüfe als Art Director: Erzählen die Titel allein die Geschichte? Gibt es mindestens drei verschiedene Kompositionen und einen Hell/Dunkel-Rhythmus (tone)? Wirkt eine Folie leer oder überladen? Folgen dieselben Layouts zu oft aufeinander? Gibt es einen klaren Höhepunkt? Wirken Fotos einheitlich? Schwächste 1–3 Folien gezielt verbessern.";
const NO_DECK: &str = "Noch kein Deck. Erst create_deck aufrufen.";

/// Hook-Werkzeug ohne Umsetzung
pub fn not_yet(name: &str) -> String {
    format!(
        "{name} ist in dieser Deckwerk-Version noch nicht verfügbar (Netz, Medien und KI kommen mit dw-net, dw-media, dw-video, dw-podcast und dw-guide). Ohne dieses Werkzeug weiterarbeiten oder den Nutzer fragen."
    )
}

// ---------- kleine Helfer ----------

fn st<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn has(v: &Value, k: &str) -> bool {
    v.get(k).is_some()
}

/// gesetzt und nicht null
fn given<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.get(k).filter(|x| !x.is_null())
}

fn obj(v: &mut Value) -> &mut Map<String, Value> {
    if !v.is_object() {
        *v = json!({});
    }
    v.as_object_mut().unwrap()
}

/// TS-Wahrheitswert
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}

fn typed(d: &Value) -> Result<Deck, String> {
    serde_json::from_value(d.clone()).map_err(|e| format!("Deck ungültig: {e}"))
}

fn untyped(d: &Deck) -> Value {
    serde_json::to_value(d).unwrap_or_default()
}

fn typeset(s: &str) -> String {
    dw_lint::typeset(s)
}

/// JS `Math.round`
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `String(+n.toFixed(1)).replace('.', ',')`
fn sec(n: f64) -> String {
    let x: f64 = dw_lint::js::to_fixed(n, 1).parse().unwrap_or(n);
    dw_lint::js::num(x).replace('.', ",")
}

/// Zufällige ID wie items.ts `newId` (8 Zeichen a–z0–9)
fn new_id() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    SystemTime::now().hash(&mut h);
    N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        .hash(&mut h);
    let mut n = h.finish();
    (0..8)
        .map(|_| {
            let c = char::from_digit((n % 36) as u32, 36).unwrap();
            n /= 36;
            c
        })
        .collect()
}

fn new_slide_id(list: &[Value]) -> String {
    let used: HashSet<&str> = list.iter().filter_map(|s| st(s, "id")).collect();
    loop {
        let id = format!("s-{}", new_id());
        if !used.contains(id.as_str()) {
            return id;
        }
    }
}

fn with_ids(items: &Value) -> Value {
    Value::Array(
        items
            .as_array()
            .into_iter()
            .flatten()
            .map(|it| {
                let mut it = it.clone();
                if !truthy(it.get("id")) {
                    obj(&mut it).insert("id".into(), new_id().into());
                }
                it
            })
            .collect(),
    )
}

fn hid(s: &Value) -> &'static str {
    if truthy(s.get("hidden")) {
        " (ausgeblendet)"
    } else {
        ""
    }
}

fn slides(d: &Value) -> &[Value] {
    d["slides"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn index_of(d: &Value, id: &str) -> Result<usize, String> {
    slides(d)
        .iter()
        .position(|s| st(s, "id") == Some(id))
        .ok_or_else(|| {
            let ids: Vec<&str> = slides(d).iter().filter_map(|s| st(s, "id")).collect();
            format!(
                "Folie \"{id}\" gibt es nicht. Vorhanden: {}",
                if ids.is_empty() {
                    "(keine)".into()
                } else {
                    ids.join(", ")
                }
            )
        })
}

fn check_frame(layout: &str, frame: Option<&str>, at: &str) -> Result<(), String> {
    let Some(f) = frame.filter(|f| *f != "top") else {
        return Ok(());
    };
    let ok = catalog::get(layout).and_then(|l| l.frames.as_ref());
    if ok.is_some_and(|o| o.iter().any(|x| x == f)) {
        return Ok(());
    }
    let more = ok
        .filter(|o| !o.is_empty())
        .map(|o| format!(", {}", o.join(", ")))
        .unwrap_or_default();
    Err(format!(
        "{at}: Layout {layout} kann frame \"{f}\" nicht. Erlaubt: top{more}"
    ))
}

/// zod fontName-Refinement: gebündelte Schrift oder Katalogfamilie
fn check_font(name: &str, path: &str) -> Result<(), String> {
    if dw_theme::known_font(name) {
        return Ok(());
    }
    let hint = match dw_theme::fonts::suggest_font(name) {
        Some(s) => format!(" – meintest du „{s}“?"),
        None => {
            ". Erlaubt: gebündelte Schriften und der Schriftkatalog (Systemprompt, „Themes“)".into()
        }
    };
    Err(format!(
        "✖ Schrift „{name}“ gibt es nicht{hint}\n  → at {path}"
    ))
}

fn check_fonts(i: &Value) -> Result<(), String> {
    let theme = |v: &Value, p: &str| -> Result<(), String> {
        for k in ["headFont", "bodyFont"] {
            if let Some(f) = st(v, k) {
                check_font(f, &format!("{p}.{k}"))?;
            }
        }
        Ok(())
    };
    for k in ["customTheme", "brand"] {
        if let Some(c) = given(i, k) {
            theme(c, k)?;
        }
    }
    for (k, f) in i
        .get("fonts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if let Some(f) = f.as_str() {
            check_font(f, &format!("fonts[{k}]"))?;
        }
    }
    for (k, l) in i
        .get("looks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if l.is_object() {
            theme(l, &format!("looks[{k}]"))?;
        }
    }
    let items = |v: &Value, p: &str| -> Result<(), String> {
        for (k, it) in v.as_array().into_iter().flatten().enumerate() {
            if let Some(f) = st(it, "font").filter(|f| *f != "head" && *f != "body") {
                check_font(f, &format!("{p}[{k}].font"))?;
            }
        }
        Ok(())
    };
    if let Some(v) = given(i, "items") {
        items(v, "items")?;
    }
    for (k, s) in i
        .get("slides")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if let Some(v) = given(s, "items") {
            items(v, &format!("slides[{k}].items"))?;
        }
    }
    Ok(())
}

// ---------- Theme: Lint, Designtyp ----------

fn font_catalog() -> &'static [FontInfo] {
    static C: std::sync::OnceLock<Vec<FontInfo>> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        use dw_theme::fonts::{FontCat::*, FontFlag, FontRole};
        dw_theme::fonts::FONT_CATALOG
            .iter()
            .map(|f| FontInfo {
                family: f.family.into(),
                cat: match f.cat {
                    Grotesk => "grotesk",
                    Humanist => "humanist",
                    Geometric => "geometric",
                    Condensed => "condensed",
                    Serif => "serif",
                    DisplaySerif => "display-serif",
                    Slab => "slab",
                    Mono => "mono",
                }
                .into(),
                role: match f.role {
                    FontRole::Head => "head",
                    FontRole::Body => "body",
                    FontRole::Both => "both",
                }
                .into(),
                weights: f.weights.iter().map(|w| *w as f64).collect(),
                flag: f.flag.map(|x| match x {
                    FontFlag::Slop => "slop".into(),
                    FontFlag::Common => "common".into(),
                }),
            })
            .collect()
    })
}

/// Theme-Lint für ein eigenes Design, wie es gerendert wird: ein Brand-Kit ersetzt Akzent und ggf. Schriften
fn lint_for(spec: &Value, kit: Option<&Value>, r#override: bool) -> Vec<ThemeIssue> {
    let mut s = spec.clone();
    if let Some(k) = kit {
        let o = obj(&mut s);
        if let Some(p) = k.get("primary") {
            o.insert("accent".into(), p.clone());
        }
        for f in ["headFont", "bodyFont"] {
            if let Some(v) = given(k, f) {
                o.insert(f.into(), v.clone());
            }
        }
    }
    let Ok(ts) = serde_json::from_value::<dw_lint::theme::ThemeSpec>(s) else {
        return vec![];
    };
    let brand = kit
        .map(|k| BrandGiven {
            accent: true,
            head_font: truthy(k.get("headFont")),
            body_font: truthy(k.get("bodyFont")),
        })
        .unwrap_or_default();
    let bundled: Vec<&str> = dw_theme::fonts::FONT_LIST.iter().map(|f| f.0).collect();
    // Rauschen: „sehr verbreitet“ bei gebündelten Schriften (die erprobte Grundauswahl)
    dw_lint::lint_theme(&ts, ThemeLintOpts { r#override, brand }, font_catalog())
        .into_iter()
        .filter(|x| {
            !(x.rule == "font-common"
                && bundled.contains(&x.message.split(" ist ").next().unwrap_or("")))
        })
        .collect()
}

fn level(l: Level) -> &'static str {
    match l {
        Level::Error => "error",
        Level::Warn => "warn",
        Level::Info => "info",
    }
}

/// Fehler lehnen ab (mit override nur Hinweis), außer sie bestanden schon vor dem Aufruf; Rest als kurzer Block
fn check_theme(issues: &[ThemeIssue], at: &str, before: &[ThemeIssue]) -> Result<String, String> {
    let key = |x: &ThemeIssue| format!("{}|{}", x.rule, x.message);
    let old: HashSet<String> = before
        .iter()
        .filter(|x| x.level == Level::Error)
        .map(key)
        .collect();
    let line = |x: &ThemeIssue| {
        format!(
            "  - [{}{}] {}: {}",
            level(x.level),
            if old.contains(&key(x)) {
                ", schon vorher"
            } else {
                ""
            },
            x.rule,
            x.message
        )
    };
    let errors: Vec<String> = issues
        .iter()
        .filter(|x| x.level == Level::Error && !old.contains(&key(x)))
        .map(line)
        .collect();
    if !errors.is_empty() {
        return Err(format!(
            "{at}: Theme-Lint lehnt ab:\n{}\nKorrigieren und erneut aufrufen. Will der Nutzer es ausdrücklich so (z. B. Markenvorgabe), override mit Begründung setzen.",
            errors.join("\n")
        ));
    }
    Ok(if issues.is_empty() {
        String::new()
    } else {
        format!(
            "Theme-Hinweise ({at}):\n{}\n",
            issues.iter().map(line).collect::<Vec<_>>().join("\n")
        )
    })
}

/// tune schlägt das Theme, auch ein neues customTheme: sonst scheint ein neuer Wert nicht zu greifen
fn shadowed(custom: Option<&Value>, tune: Option<&Value>) -> String {
    let keys: Vec<&String> = custom
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|o| o.keys())
        .filter(|k| tune.is_some_and(|t| has(t, k)))
        .collect();
    if keys.is_empty() {
        return String::new();
    }
    format!(
        "Hinweis: tune überschreibt {}; mit tune {{ {} }} entfernen.\n",
        keys.iter()
            .map(|k| format!("customTheme.{k}"))
            .collect::<Vec<_>>()
            .join(", "),
        keys.iter()
            .map(|k| format!("{k}: null"))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// tune mischen, null entfernt einen Wert; leer = weg
fn merge_tune(old: Option<&Value>, patch: Option<&Value>) -> Option<Value> {
    let mut t = old.and_then(Value::as_object).cloned().unwrap_or_default();
    for (k, v) in patch.and_then(Value::as_object).into_iter().flatten() {
        t.insert(k.clone(), v.clone());
    }
    t.retain(|_, v| !v.is_null());
    (!t.is_empty()).then_some(Value::Object(t))
}

/// `{ ...custom, ...tune }` für den Lint
fn spec_with_tune(theme: &Value) -> Value {
    let mut s = theme["custom"].clone();
    for (k, v) in theme
        .get("tune")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        obj(&mut s).insert(k.clone(), v.clone());
    }
    s
}

fn theme_ref(theme: &Value) -> ThemeRef {
    serde_json::from_value(theme.clone())
        .unwrap_or_else(|_| serde_json::from_value(json!({"id": "beratung"})).unwrap())
}

/// Designtyp (Guide §6 „Abwechslung“): die fünf Merkmale, an denen man Decks auf einen Blick unterscheidet
#[derive(Debug, Clone, PartialEq)]
struct LookTyp {
    hell: &'static str,
    schrift: &'static str,
    gewicht: &'static str,
    grund: &'static str,
    bauteile: &'static str,
}

fn look_typ(theme: &Value) -> LookTyp {
    let t = dw_theme::resolve_theme(&theme_ref(theme), None);
    let o = t.c.bg.to_oklab();
    let (l, c) = (o.l, (o.a * o.a + o.b * o.b).sqrt());
    let tinted = if t.dark {
        c > 0.02
    } else {
        l < 0.955 && c > 0.006
    };
    let serif = t.head.font.serif;
    LookTyp {
        hell: if t.dark { "dunkel" } else { "hell" },
        schrift: if serif { "Serif" } else { "Sans" },
        gewicht: if t.head.weight < 600 && (serif || !t.head.font.single) {
            "regular"
        } else {
            "bold"
        },
        grund: if t.vivid {
            "kräftig"
        } else if tinted {
            "getönt"
        } else {
            "neutral"
        },
        bauteile: t.elements.map_or("line", |e| e.as_str()),
    }
}

fn typ_text(t: &LookTyp) -> String {
    let b = match t.bauteile {
        "line" => "Linie",
        "plain" => "frei",
        _ => "Fläche",
    };
    format!(
        "{}, {}-Titel {}, Grund {}, Bauteile {b}",
        t.hell, t.schrift, t.gewicht, t.grund
    )
}

/// Zuletzt gebaute Decks, neueste zuerst; Decks mit Brand-Kit zählen nicht (dort ist der Look vorgegeben)
fn recent_looks(t: &Tools, except: Option<&str>) -> Vec<(String, LookTyp)> {
    let Ok(rd) = std::fs::read_dir(t.ctx.store.root()) else {
        return vec![];
    };
    let mut files: Vec<(PathBuf, SystemTime)> = rd
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            !n.starts_with('.')
                && !["versions", "out", "assets", "models", "kunden"].contains(&n.as_str())
        })
        .filter_map(|e| {
            let f = e.path().join("deck.json");
            let m = std::fs::metadata(&f).ok()?.modified().ok()?;
            Some((f, m))
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.1));
    let mut out = vec![];
    // begrenzt: mit Brand-Kit zählt kein Deck, sonst würde jede deck.json gelesen
    for (f, _) in files.into_iter().take(12) {
        if out.len() >= 4 {
            break;
        }
        let Some(d) = std::fs::read_to_string(&f)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        else {
            continue;
        };
        let title = d["title"].as_str().unwrap_or("").to_string();
        if !truthy(d["theme"].get("brand")) && Some(title.as_str()) != except {
            let title: String = title
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(80)
                .collect();
            out.push((title, look_typ(&d["theme"])));
        }
    }
    out
}

/// Hinweis, wenn ein Design im Typ einem der 3 neuesten Decks gleicht; "" sonst
fn repeats(typ: &LookTyp, recent: &[(String, LookTyp)]) -> String {
    let alike: Vec<String> = recent
        .iter()
        .take(3)
        .filter(|r| &r.1 == typ)
        .map(|r| format!("„{}“", r.0))
        .collect();
    if alike.is_empty() {
        return String::new();
    }
    format!(
        "gleicht im Typ deinen letzten Decks {} ({}). Ändere mindestens eins: Grund (getönt, dunkel, im Stil mutig kräftig), Schrift (Sans statt Serif oder umgekehrt), Titelgewicht oder Bauteile (line/plain) – außer der Nutzer will eine Serie (Design-Guide §6 „Abwechslung“).",
        alike.join(", "),
        typ_text(typ)
    )
}

/// Film-Einstellungen ohne leere Werte; das Tempo geklemmt wie in der Stimme
fn film_of(f: &Value) -> Value {
    let mut o = Map::new();
    if let Some(v) = given(f, "voice").filter(|v| truthy(Some(v))) {
        o.insert("voice".into(), v.clone());
    }
    if let Some(s) = f.get("speed").and_then(Value::as_f64) {
        o.insert("speed".into(), json!(s.clamp(0.8, 1.3)));
    }
    if let Some(c) = given(f, "captions").filter(|v| truthy(Some(v))) {
        o.insert("captions".into(), c.clone());
    }
    Value::Object(o)
}

/// Excel-Link (Deckwerk Pro) setzt nur die App: link aus KI-Eingaben verwerfen, den Bestand behalten
fn keep_links(s: &mut Value, old: Option<&Value>) -> String {
    let mut notes = vec![];
    let keep = |now: Option<&mut Value>, was: Option<&Value>, notes: &mut Vec<String>| {
        let Some(now) = now.filter(|n| n.is_object()) else {
            return;
        };
        if Some(&*now) == was {
            return; // unverändert übernommen
        }
        obj(now).remove("link");
        let Some(w) = was else { return };
        let Some(link) = given(w, "link") else { return };
        obj(now).insert("link".into(), link.clone());
        if json!([now.get("categories"), now.get("series")])
            != json!([w.get("categories"), w.get("series")])
        {
            let file = st(link, "file")
                .and_then(|f| Path::new(f).file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            notes.push(format!("Diagramm ist mit Excel verknüpft ({file}); „Aktualisieren“ in der App überschreibt die Werte aus der Datei."));
        }
    };
    let old_chart = old
        .and_then(|o| o.get("content"))
        .and_then(|c| c.get("chart"));
    keep(
        s.get_mut("content").and_then(|c| c.get_mut("chart")),
        old_chart,
        &mut notes,
    );
    let old_items: Vec<Value> = old
        .and_then(|o| o["items"].as_array().cloned())
        .unwrap_or_default();
    for it in s
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let id = it.get("id").cloned();
        let was = old_items
            .iter()
            .find(|o| o.get("id") == id.as_ref())
            .and_then(|o| o.get("spec"));
        keep(it.get_mut("spec"), was, &mut notes);
    }
    notes.iter().map(|n| format!("{n}\n")).collect()
}

// ---------- Rückmeldung je Folie ----------

/// Lint-Meldung samt Clip-Prüfung; info = Hinweis, zählt nicht als Warnung
struct Note {
    slide: usize,
    slide_id: String,
    slot: Option<String>,
    severity: &'static str,
    rule: String,
    message: String,
}

fn sev(s: &str) -> &str {
    if s == "info" { "hinweis" } else { s }
}

fn fmt_issues(xs: &[&Note]) -> String {
    xs.iter()
        .map(|i| {
            format!(
                "  - [{}] {}{}: {}",
                sev(i.severity),
                i.rule,
                i.slot
                    .as_ref()
                    .map(|s| format!(" @{s}"))
                    .unwrap_or_default(),
                i.message
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn note_of(x: Issue) -> Note {
    Note {
        slide: x.slide,
        slide_id: x.slide_id,
        slot: x.slot,
        severity: if x.severity == Severity::Error {
            "error"
        } else {
            "warn"
        },
        rule: x.rule,
        message: x.message,
    }
}

struct ClipCheck {
    issues: Vec<Note>,
    summary: String,
}

impl Tools {
    fn need_deck(&self) -> Result<Value, String> {
        self.deck()
            .map(|d| untyped(&d))
            .ok_or_else(|| NO_DECK.to_string())
    }

    /// Speichern mit Schriften (webfonts.ts withDeckFonts über den Hook); Hinweis fürs Ergebnis, sonst ""
    fn put(&self, d: &Value) -> Result<String, String> {
        let mut deck = typed(d)?;
        dw_store::check_deck(&deck)?;
        let notes = self.ctx.hooks.deck_fonts(&mut deck);
        self.set_deck(deck);
        Ok(if notes.is_empty() {
            String::new()
        } else {
            format!("Schriften: {}\n", notes.join("; "))
        })
    }

    /// alle Folien messen; Fehler einer Folie = Fehler der Messung
    fn measure_all(&self, deck: &Deck) -> Result<Vec<Measured>, String> {
        let idx: Vec<usize> = (0..deck.slides.len()).collect();
        self.ctx
            .engine
            .measure(deck, &idx)?
            .into_iter()
            .enumerate()
            .map(|(i, m)| {
                m.map_err(|e| format!("Folie {} ({}): {e}", i + 1, deck.slides[i].layout))
            })
            .collect()
    }

    fn lint(&self, deck: &Deck, measured: &[Measured]) -> Vec<Issue> {
        let schema = catalog::schema_check;
        let margin = dw_theme::resolve_theme(&deck.theme, None)
            .margin
            .map(|m| m.as_str().to_string());
        let ctx = LintCtx {
            layouts: catalog::lint_infos(),
            theme: LintTheme { margin },
            schema: &schema,
            film: None,
        };
        dw_lint::lint_deck(deck, measured, &ctx)
    }

    /// Clip-Prüfung der clip-Folien an `idx`; liest nur den Cache (Hook), rechnet nie
    fn clip_checks(&self, deck: &Deck, idx: &[usize]) -> Vec<(usize, ClipCheck)> {
        let clips: Vec<usize> = (0..deck.slides.len())
            .filter(|&i| deck.slides[i].layout == "clip")
            .collect();
        let content = |i: usize| {
            serde_json::from_value::<ClipContent>(deck.slides[i].content.clone())
                .unwrap_or_default()
        };
        let others: Vec<OtherClip> = clips
            .iter()
            .map(|&i| content(i))
            .map(|c| OtherClip {
                video: c.video,
                parts: c.parts,
            })
            .collect();
        let refs: Vec<SlideRef> = deck
            .slides
            .iter()
            .map(|s| SlideRef {
                layout: s.layout.clone(),
                hidden: s.hidden,
            })
            .collect();
        let size = deck.size();
        let deck_music = deck
            .extra
            .get("music")
            .is_some_and(|m| truthy(m.get("src")));
        let mut out = vec![];
        for &i in idx {
            let Some(k) = clips.iter().position(|&c| c == i) else {
                continue;
            };
            let c = content(i);
            let d = c
                .video
                .as_deref()
                .and_then(clip_file)
                .and_then(|f| self.ctx.hooks.video_cache(&f));
            let info = ClipInfo {
                duration: d.as_ref().and_then(|d| d.duration),
                transcript: d.as_ref().and_then(|d| d.transcript.clone()),
                music: d.as_ref().and_then(|d| d.music.clone()),
                deck_music: Some(deck_music),
                slides: Some(refs.clone()),
            };
            let issues: Vec<Note> = lint_clip(
                &c,
                dw_lint::video::Size {
                    w: size.w,
                    h: size.h,
                },
                &info,
                &others,
                Some(k),
            )
            .into_iter()
            .map(|x| Note {
                slide: i,
                slide_id: deck.slides[i].id.clone(),
                slot: None,
                severity: match x.severity {
                    dw_lint::video::Severity::Error => "error",
                    dw_lint::video::Severity::Warn => "warn",
                    dw_lint::video::Severity::Info => "info",
                },
                rule: x.rule,
                message: x.message,
            })
            .collect();
            let n = c.parts.len();
            let transcript = if info.transcript.is_some()
                && !issues.iter().any(|x| x.rule == "clip-transkript")
            {
                "ok"
            } else {
                "fehlt"
            };
            let summary = format!(
                "Länge {} s{} · {n} {} · Transkript {transcript}",
                sec(parts_length(&c.parts)),
                if c.pauses.as_deref() == Some("kurz") {
                    " (vor dem Pausenkürzen)"
                } else {
                    ""
                },
                if n == 1 { "Ausschnitt" } else { "Ausschnitte" }
            );
            out.push((i, ClipCheck { issues, summary }));
        }
        out
    }

    /// Ablauf beim Präsentieren in Worten, damit die KI Animationen beurteilen kann, ohne sie zu sehen
    fn motion_of(&self, deck: &Deck, i: usize, m: &Measured) -> String {
        let schema = catalog::schema_check;
        let ctx = LintCtx {
            layouts: catalog::lint_infos(),
            theme: LintTheme::default(),
            schema: &schema,
            film: None,
        };
        let preset = dw_lint::lint::build_of(deck, i, &ctx);
        let groups = m
            .els
            .iter()
            .filter_map(|e| e.base().build)
            .collect::<BTreeSet<_>>()
            .len();
        let clicks = if deck.mode.as_deref() == Some("click") {
            (if preset == "list" { groups } else { 0 })
                + dw_lint::lint::item_clicks(&deck.slides[i])
        } else {
            0
        };
        let build = if preset == "none" || groups == 0 {
            "ohne Aufbau".to_string()
        } else {
            format!(
                "Aufbau {preset} ({groups} {})",
                if groups > 1 { "Gruppen" } else { "Gruppe" }
            )
        };
        let tr = transition_of(deck, i);
        let s = &deck.slides[i];
        if s.layout == "clip" {
            // die Übergänge an den Schnitten macht der Export selbst, transition gilt nur für den Folienwechsel
            let live = s.content.get("style").and_then(Value::as_str) == Some("lebendig");
            return format!(
                "Folienwechsel {tr}; im MP4 blenden die Schnitte über (Jump-Cuts kurz, neuer Moment ab 20 s Sprung 0,5 s){}, die Vorschau ebenso",
                if live {
                    ", bei jedem zweiten neuen Moment leichter Zoom"
                } else {
                    ""
                }
            );
        }
        let clicks = if clicks > 0 {
            format!(", {clicks} Klick{}", if clicks > 1 { "s" } else { "" })
        } else {
            String::new()
        };
        format!("Übergang {tr}, {build}{clicks}")
    }

    /// Zeitachse einer Szene (Film-Decks), geschätzt über den Hook
    fn scene_line(&self, deck: &Deck, i: usize, m: Option<&Measured>) -> String {
        if deck.slides[i].hidden == Some(true) {
            return "keine Szene (ausgeblendet)".into();
        }
        self.ctx.hooks.scene_line(deck, i, m).unwrap_or_else(|| {
            let k = deck.slides[..=i]
                .iter()
                .filter(|s| s.hidden != Some(true))
                .count();
            format!("Szene {k}: Zeitachse noch nicht verfügbar")
        })
    }

    /// Autofit + Lint für die Folien an `idx` – die Rückmeldung, mit der die KI korrigiert
    fn report(&self, d: &Value, idx: &[usize]) -> String {
        // Das Deck ist schon gespeichert: nicht als Tool-Fehler melden, sonst wiederholt die KI die Änderung
        let fail = |e: String| {
            format!(
                "Gespeichert (Folien {}), aber die Messung ist fehlgeschlagen: {e}. Später lint_deck aufrufen.",
                idx.iter()
                    .map(|i| (i + 1).to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let deck = match typed(d) {
            Ok(x) => x,
            Err(e) => return fail(e),
        };
        let measured = match self.measure_all(&deck) {
            Ok(m) => m,
            Err(e) => return fail(e),
        };
        let issues: Vec<Note> = self
            .lint(&deck, &measured)
            .into_iter()
            .map(note_of)
            .collect();
        let clips = self.clip_checks(&deck, idx);
        let film = deck.extra.get("film").is_some_and(|f| truthy(Some(f)));
        idx.iter()
            .map(|&i| {
                let s = &deck.slides[i];
                let m = &measured[i];
                let clip = clips.iter().find(|c| c.0 == i).map(|c| &c.1);
                let own: Vec<&Note> = issues.iter().filter(|x| x.slide == i).chain(clip.into_iter().flat_map(|c| c.issues.iter())).collect();
                let errors = own.iter().filter(|x| x.severity == "error").count();
                let over = if m.fit.ok {
                    String::new()
                } else {
                    let kind = |k: dw_model::OverflowKind| serde_json::to_value(k).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
                    format!(", Überlauf: {}", m.fit.overflow.iter().map(|o| format!("{} +{}px ({})", o.slot, round(o.over_px), kind(o.kind))).collect::<Vec<_>>().join(", "))
                };
                let fit = match clip {
                    Some(c) => format!("{}{over}", c.summary),
                    None => format!("Autofit head {}/body {}{over}", m.fit.head, m.fit.body),
                };
                let extra = if film {
                    format!("\n  {}", self.scene_line(&deck, i, Some(m)))
                } else if s.items.iter().flatten().any(|it| it.extra.get("keys").and_then(Value::as_array).is_some_and(|k| !k.is_empty())) {
                    "\n  Hinweis: keys wirken nur im Film (update_deck film); Präsentation und PowerPoint zeigen die Grundlage.".into()
                } else {
                    String::new()
                };
                let head = format!(
                    "Folie {} ({}, {}){}: {} · {fit} · {}{extra}",
                    i + 1,
                    s.id,
                    s.layout,
                    hid(&d["slides"][i]),
                    if errors > 0 { format!("{errors} FEHLER") } else { "OK".into() },
                    self.motion_of(&deck, i, m)
                );
                if own.is_empty() { head } else { format!("{head}\n{}", fmt_issues(&own)) }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Theme sofort sichtbar: Musterfolien mit Theme und Brand als ein Kontaktbogen; scheitert das Rendern, keins
    fn theme_preview(&self, d: &Value) -> Vec<Vec<u8>> {
        let mut p = d.clone();
        let s: Vec<Value> = PREVIEW
            .iter()
            .filter_map(|l| catalog::get(l))
            .map(|l| json!({"id": format!("preview-{}", l.id), "layout": l.id, "content": l.typ}))
            .collect();
        obj(&mut p).insert("slides".into(), Value::Array(s));
        match typed(&p).and_then(|deck| self.ctx.engine.render_overview(&deck)) {
            Ok(png) => vec![png],
            Err(e) => {
                eprintln!("[tools] Theme-Vorschau übersprungen: {e}");
                vec![]
            }
        }
    }

    /// Brand-Kit des Nutzers (~/Deckwerk/brand.json)
    fn default_brand(&self) -> Option<Value> {
        self.ctx
            .store
            .brand()
            .map(|b| serde_json::to_value(b).unwrap_or_default())
    }

    /// Lange Arbeiten laufen im Hintergrund weiter; ein Aufruf wartet höchstens `job_wait`. Der nächste Aufruf mit
    /// gleichem Schlüssel hängt sich an den laufenden Job oder holt sein Ergebnis ab; danach ist der Job vergessen.
    fn job(
        &self,
        key: &str,
        start: impl FnOnce() -> Result<u64, String>,
    ) -> Result<crate::Job, String> {
        let known = lock(&self.jobs).get(key).copied();
        let id = match known {
            Some(id) => id,
            None => {
                let id = start()?;
                lock(&self.jobs).insert(key.into(), id);
                id
            }
        };
        let until = Instant::now() + self.job_wait;
        loop {
            let j = self.ctx.engine.job(id);
            if j.as_ref().map_or(true, |j| j.done) {
                lock(&self.jobs).remove(key);
                return j;
            }
            if Instant::now() >= until {
                return j;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

fn still_running(what: &str, pct: f32) -> String {
    format!(
        "{what} läuft noch ({} %). Rufe dasselbe Tool gleich noch einmal mit denselben Eingaben auf; die Arbeit läuft im Hintergrund weiter.",
        round(pct as f64)
    )
}

/// deck.ts `transitionOf`
fn transition_of(deck: &Deck, i: usize) -> String {
    if i == 0 {
        return "none".into();
    }
    deck.slides[i]
        .extra
        .get("transition")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| deck.transition.clone())
        .unwrap_or_else(|| "fade".into())
}

/// Videopfad einer clip-Folie; None = keine Videodatei
fn clip_file(src: &str) -> Option<PathBuf> {
    let p = asset_path(src);
    (p.is_absolute() && dw_store::media_kind(&p) == Some(dw_store::MediaKind::Video)).then_some(p)
}

fn key_of(v: &Value) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    v.to_string().hash(&mut h);
    format!("{:016x}", h.finish())
}

// ---------- Bilder ----------

const IMG_EXT: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];

fn is_img(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMG_EXT.contains(&e.to_ascii_lowercase().as_str()))
}

/// Pixelmaße aus dem Dateikopf (PNG, GIF, JPEG, WebP); None = unbekannt (SVG, kaputt)
pub fn image_size(b: &[u8]) -> Option<(u32, u32)> {
    let be16 = |i: usize| Some(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]) as u32);
    let le16 = |i: usize| Some(u16::from_le_bytes([*b.get(i)?, *b.get(i + 1)?]) as u32);
    let le24 = |i: usize| {
        Some(u32::from_le_bytes([
            *b.get(i)?,
            *b.get(i + 1)?,
            *b.get(i + 2)?,
            0,
        ]))
    };
    if b.len() >= 24 && b.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        return Some((
            u32::from_be_bytes(b[16..20].try_into().ok()?),
            u32::from_be_bytes(b[20..24].try_into().ok()?),
        ));
    }
    if b.len() >= 10 && b.starts_with(b"GIF8") {
        return Some((le16(6)?, le16(8)?));
    }
    if b.starts_with(&[0xff, 0xd8]) {
        // JPEG: Segmente bis zum Frame-Kopf SOF0–SOF15 (ohne DHT C4, JPG C8, DAC CC)
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xff {
                return None;
            }
            let m = b[i + 1];
            if m == 0xff {
                i += 1;
                continue;
            }
            if (0xc0..=0xcf).contains(&m) && ![0xc4, 0xc8, 0xcc].contains(&m) {
                return Some((be16(i + 7)?, be16(i + 5)?));
            }
            i += 2 + be16(i + 2)? as usize;
        }
        return None;
    }
    if b.len() >= 30 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return match &b[12..16] {
            b"VP8X" => Some((1 + le24(24)?, 1 + le24(27)?)),
            b"VP8L" => {
                let v = u32::from_le_bytes(b[21..25].try_into().ok()?);
                Some(((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1))
            }
            b"VP8 " => Some((le16(26)? & 0x3fff, le16(28)? & 0x3fff)),
            _ => None,
        };
    }
    None
}

fn dims(buf: &[u8], file: &Path) -> (String, f64, f64) {
    match image_size(buf) {
        None => (
            file.extension()
                .map(|e| e.to_string_lossy().to_uppercase())
                .unwrap_or_default(),
            1600.0,
            1000.0,
        ),
        Some((w, h)) => {
            let r = w as f64 / h as f64;
            (
                format!(
                    "{w}×{h} px, {}",
                    if r > 1.1 {
                        "quer"
                    } else if r < 0.9 {
                        "hoch"
                    } else {
                        "quadratisch"
                    }
                ),
                w as f64,
                h as f64,
            )
        }
    }
}

fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = ((c[0] as u32) << 16)
            | ((*c.get(1).unwrap_or(&0) as u32) << 8)
            | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            s.push(if k <= c.len() {
                T[((n >> (18 - 6 * k)) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    s
}

fn walk_images(dir: &Path, out: &mut Vec<(PathBuf, SystemTime)>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if md.is_dir() {
            walk_images(&p, out);
        } else if is_img(&p) {
            out.push((p, md.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
        }
    }
}

impl Tools {
    /// Vorschau, die ins Modell passt: das Bild auf einer leeren Folie in Vorschaugröße gerendert
    fn preview(&self, src: &str, w0: f64, h0: f64, width: u32) -> Vec<Vec<u8>> {
        if !self.ctx.previews {
            return vec![];
        }
        let w = (width as f64 / 2.0).round();
        let h = (w * h0 / w0).round();
        let theme = self
            .deck()
            .map(|d| untyped(&d)["theme"].clone())
            .unwrap_or(json!({"id": "beratung"}));
        let deck = json!({"title": "", "theme": theme, "transition": "none", "mode": "click", "size": {"w": w, "h": h},
            "slides": [{"id": "bild", "layout": "blank", "content": {}, "items": [{"id": "bild", "kind": "image", "src": src, "x": 0, "y": 0, "w": w, "h": h}]}]});
        match typed(&deck).and_then(|d| self.ctx.engine.render_png(&d, &[0], width)) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[tools] Bildvorschau übersprungen: {e}");
                vec![]
            }
        }
    }

    /// Bild aus dem Asset-Ordner ansehen, ohne es zu kopieren; die KI wählt den Pfad, deshalb nur dort und nur Bilder
    fn view_asset(&self, url: &str) -> R {
        let assets = self.ctx.store.assets_dir();
        let file = asset_path(url);
        let inside = file
            .canonicalize()
            .ok()
            .zip(assets.canonicalize().ok())
            .is_some_and(|(f, a)| f.starts_with(&a) && f != a);
        if !is_img(&file) || !inside {
            return Err(format!(
                "Nur Bilder aus dem Asset-Ordner ({}) lassen sich ansehen.",
                assets.display()
            ));
        }
        let buf = std::fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        let (label, w, h) = dims(&buf, &file);
        let src = asset_url(&file);
        Ok(ToolOutput {
            text: format!(
                "Bild: {src} — {label}\nAls Logo: update_deck mit brand (logo = dieser Pfad; vorhandene Brand-Felder mitgeben, sonst gehen die Farben verloren); es steht dann nur auf Titel- und Schlussfolie (A4: Seite 1), nie auf jeder Folie. Als Foto oder Abbildung: image.src, image.focus nach der Vorschau."
            ),
            images: self.preview(&src, w, h, 640),
        })
    }

    /// Lokale Treffer (neueste zuerst): die ersten `limit` mit Vorschau und Maßen, der Rest nur als Pfad, höchstens 30 Zeilen
    fn local_images(&self, files: &[PathBuf], limit: usize) -> R {
        if files.is_empty() {
            return Ok(ToolOutput::text(format!(
                "Keine passenden Bilder in {}.",
                self.ctx.store.assets_dir().display()
            )));
        }
        let (mut lines, mut images) = (vec![], vec![]);
        for (n, file) in files.iter().take(30).enumerate() {
            let src = asset_url(file);
            if n >= limit {
                lines.push(src);
                continue;
            }
            let buf = std::fs::read(file).unwrap_or_default();
            let (label, w, h) = dims(&buf, file);
            images.extend(self.preview(&src, w, h, 512));
            lines.push(format!("{src} — {label}"));
        }
        let more = if files.len() > 30 {
            format!("\n… und {} weitere, query eingrenzen", files.len() - 30)
        } else {
            String::new()
        };
        Ok(ToolOutput {
            text: format!(
                "{} eigene Bilder, neueste zuerst (die ersten {} mit Vorschau, gleiche Reihenfolge):\n{}{more}",
                files.len(),
                limit.min(files.len()),
                lines.join("\n")
            ),
            images,
        })
    }
}

// ---------- Werkzeuge ----------

pub fn run(t: &Tools, name: &str, i: &Value) -> R {
    match name {
        "create_deck" => create_deck(t, i),
        "update_deck" => update_deck(t, i),
        "add_slides" => add_slides(t, i),
        "update_slide" => update_slide(t, i),
        "reorder_slides" => reorder_slides(t, i),
        "delete_slides" => delete_slides(t, i),
        "decorate_slide" => decorate_slide(t, i),
        "render_slides" => render_slides(t, i),
        "propose_looks" => propose_looks(t, i),
        "render_overview" => render_overview(t),
        "lint_deck" => lint_deck(t),
        "search_icons" => search_icons(i),
        "read_guide" => read_guide(t, i),
        "find_images" => find_images(t, i),
        "export_deck" => export_deck(t, i),
        "remember" => remember(t, i),
        "plan_storyline" => {
            let s: Vec<(String, String)> = i["slides"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|x| {
                    (
                        st(x, "title").unwrap_or("").into(),
                        st(x, "layout").unwrap_or("").into(),
                    )
                })
                .collect();
            if let Some(f) = &t.ctx.storyline {
                f(&s);
            }
            Ok(ToolOutput::text(format!(
                "Storyline mit {} Folien angezeigt. Weiter mit create_deck bzw. add_slides.",
                s.len()
            )))
        }
        "ask_user" => {
            let opts: Vec<String> = i["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect();
            if let Some(f) = &t.ctx.ask {
                f(st(i, "question").unwrap_or(""), &opts);
            }
            Ok(ToolOutput::text(
                "Frage angezeigt. Beende jetzt den Turn und warte auf die Antwort.",
            ))
        }
        // Netz, Medien, KI
        _ => hook(t, name, i),
    }
}

fn hook(t: &Tools, name: &str, i: &Value) -> R {
    if name == "check_clip" {
        // wie TS: erst die Folie prüfen, dann braucht es die Video-Funktionen
        let d = t.need_deck()?;
        let id = st(i, "slide").unwrap_or("");
        let k = index_of(&d, id)?;
        let layout = st(&d["slides"][k], "layout").unwrap_or("");
        if layout != "clip" {
            return Err(format!("Folie {id} ist keine clip-Folie ({layout})."));
        }
    }
    let deck = t.deck();
    match t.ctx.hooks.call(name, i, deck.as_ref()) {
        None => Err(not_yet(name)),
        Some(Err(e)) => Err(e),
        Some(Ok(HookOut { out, deck })) => {
            if let Some(d) = deck {
                t.set_deck(d);
            }
            Ok(out)
        }
    }
}

fn create_deck(t: &Tools, i: &Value) -> R {
    check_fonts(i)?;
    if has(i, "brand") && PRO && t.default_brand().is_some_and(|b| truthy(b.get("lock"))) {
        return Err(
            "Die Marke des Nutzers ist gesperrt (Brand-Lock). brand weglassen, dann gilt sie."
                .into(),
        );
    }
    let theme_id = st(i, "theme").unwrap_or("beratung");
    let custom = given(i, "customTheme").map(|c| {
        let mut c = c.clone();
        obj(&mut c).entry("elements").or_insert(json!("line"));
        c
    });
    let brand = if has(i, "brand") {
        given(i, "brand").cloned()
    } else {
        t.default_brand()
    };
    let mut theme = json!({"id": if custom.is_some() { "custom" } else { theme_id }});
    if let Some(b) = &brand {
        theme["brand"] = b.clone();
    }
    if let Some(c) = &custom {
        theme["custom"] = c.clone();
    }
    if let Some(tu) = merge_tune(None, i.get("tune")) {
        theme["tune"] = tu;
    }
    let mutig = custom.is_none() && dw_theme::theme(theme_id).is_some_and(|x| x.mutig);
    let style = st(i, "style")
        .map(str::to_string)
        .or(mutig.then(|| "mutig".to_string()));
    let mut d = json!({"title": typeset(st(i, "title").unwrap_or("")), "theme": theme, "transition": st(i, "transition").unwrap_or("fade"), "mode": st(i, "mode").unwrap_or("click"), "slides": []});
    let o = obj(&mut d);
    if let Some(b) = given(i, "brief") {
        o.insert("brief".into(), b.clone());
    }
    if let Some(m) = st(i, "motion").filter(|m| *m != "standard") {
        o.insert("motion".into(), m.into());
    }
    if let Some(s) = &style {
        o.insert("style".into(), s.clone().into());
    }
    if let Some(f) = st(i, "format")
        .filter(|f| *f != "16:9")
        .and_then(dw_model::format)
    {
        o.insert("size".into(), json!({"w": f.w, "h": f.h}));
    }
    if let Some(f) = given(i, "film") {
        o.insert("film".into(), film_of(f));
    }
    let hints = match &custom {
        Some(_) => {
            check_theme(
                &lint_for(
                    &spec_with_tune(&d["theme"]),
                    brand.as_ref(),
                    has(i, "override"),
                ),
                "customTheme",
                &[],
            )? + &shadowed(i.get("customTheme"), d["theme"].get("tune"))
        }
        None => String::new(),
    };
    let fonts = t.put(&d)?;
    let d = t.need_deck()?;
    let rep = if brand.is_some() {
        String::new()
    } else {
        repeats(
            &look_typ(&d["theme"]),
            &recent_looks(t, d["title"].as_str()),
        )
    };
    let film = d
        .get("film")
        .map(|f| {
            format!(
                ", Film {}",
                st(f, "voice")
                    .map(|v| format!("mit Stimme {v}"))
                    .unwrap_or("ohne Stimme".into())
            )
        })
        .unwrap_or_default();
    let br = d["theme"]
        .get("brand")
        .map(|b| {
            format!(
                ", Brand-Kit des Nutzers angewendet{}",
                st(b, "logo")
                    .filter(|l| !l.is_empty())
                    .map(|l| format!(", Logo {l} auf Titel- und Schlussfolie (A4: Seite 1)"))
                    .unwrap_or_default()
            )
        })
        .unwrap_or_default();
    let theme_name = match custom.as_ref().and_then(|c| st(c, "name")) {
        Some(n) => format!("eigenes: {n}"),
        None => theme_id.into(),
    };
    let text = format!(
        "{hints}{fonts}{}Deck \"{}\" angelegt (Theme {theme_name}, Übergang {}, Modus {}, Stil {}{film}{br}). {PREVIEW_HINT}",
        if rep.is_empty() {
            String::new()
        } else {
            format!("Hinweis: Dieses Design {rep}\n")
        },
        st(&d, "title").unwrap_or(""),
        st(&d, "transition").unwrap_or(""),
        st(&d, "mode").unwrap_or(""),
        style.unwrap_or(
            "nicht gewählt (gilt als sachlich; nach Anlass wählen, Design-Guide §6)".into()
        )
    );
    Ok(ToolOutput {
        text,
        images: t.theme_preview(&d),
    })
}

/// Felder von ThemeSpec: zod parst, nur bekannte Felder bleiben
const THEME_KEYS: [&str; 28] = [
    "name",
    "bg",
    "text",
    "accent",
    "accent2",
    "headFont",
    "bodyFont",
    "radius",
    "decor",
    "texture",
    "titleSize",
    "titleWeight",
    "rule",
    "sectionTone",
    "vivid",
    "labelFont",
    "elements",
    "field",
    "headWeight",
    "headTracking",
    "leading",
    "labels",
    "margin",
    "measure",
    "signature",
    "heroTone",
    "chart",
    "images",
];

/// Patch auf ein Objekt: fehlt = bleibt, null = entfernen, sonst setzen
fn patch(o: &mut Map<String, Value>, i: &Value, k: &str) {
    match i.get(k) {
        Some(Value::Null) => {
            o.remove(k);
        }
        Some(v) => {
            o.insert(k.into(), v.clone());
        }
        None => {}
    }
}

fn update_deck(t: &Tools, i: &Value) -> R {
    check_fonts(i)?;
    let mut d = t.need_deck()?;
    if has(i, "brand") && PRO && truthy(d["theme"]["brand"].get("lock")) {
        return Err("Die Marke ist gesperrt (Brand-Lock). Farben, Schriften und Logo ändert nur der Nutzer in den Einstellungen.".into());
    }
    let old_custom = given(&d["theme"], "custom").cloned();
    let ct = given(i, "customTheme");
    // Neues eigenes Design (keins vorher oder neuer Name): Bauteile line; Korrekturen an einem alten Design behalten sie
    let fresh = old_custom.is_none()
        || ct
            .and_then(|c| st(c, "name"))
            .is_some_and(|n| Some(n) != old_custom.as_ref().and_then(|c| st(c, "name")));
    // Lint-Stand vor dem Aufruf: alte Fehler blockieren keine Korrekturen; ein ganz neuer Entwurf erbt keine Altlast
    let before = if (ct.is_some() || has(i, "tune")) && old_custom.is_some() && !fresh {
        lint_for(
            &spec_with_tune(&d["theme"]),
            given(&d["theme"], "brand"),
            false,
        )
    } else {
        vec![]
    };
    let o = obj(&mut d);
    match i.get("film") {
        Some(Value::Null) => {
            o.remove("film");
        }
        Some(f) => {
            let mut m = o.get("film").cloned().unwrap_or(json!({}));
            for (k, v) in f.as_object().into_iter().flatten() {
                obj(&mut m).insert(k.clone(), v.clone());
            }
            o.insert("film".into(), film_of(&m));
        }
        None => {}
    }
    match i.get("music") {
        Some(Value::Null) => {
            o.remove("music");
        }
        Some(m) => {
            let mut m = m.clone();
            let src = audio_src(st(&m, "src").unwrap_or(""), "music.src")?;
            obj(&mut m).insert("src".into(), src.into());
            o.insert("music".into(), m);
        }
        None => {}
    }
    if has(i, "videoRes") {
        match st(i, "videoRes") {
            None | Some("1080p") => {
                o.remove("videoRes");
            }
            Some(r) => {
                o.insert("videoRes".into(), r.into());
            }
        }
    }
    if let Some(ti) = st(i, "title").filter(|x| !x.is_empty()) {
        o.insert("title".into(), typeset(ti).into());
    }
    if let Some(b) = given(i, "brief") {
        let mut br = o.get("brief").cloned().unwrap_or(json!({}));
        for (k, v) in b.as_object().into_iter().flatten() {
            obj(&mut br).insert(k.clone(), v.clone());
        }
        o.insert("brief".into(), br);
    }
    let th = obj(o.entry("theme").or_insert(json!({})));
    if let Some(id) = st(i, "theme") {
        th.insert("id".into(), id.into());
        th.remove("custom");
    }
    match i.get("customTheme") {
        Some(Value::Null) => {
            th.remove("custom");
            if th.get("id").and_then(Value::as_str) == Some("custom") {
                th.insert("id".into(), "beratung".into());
            }
        }
        Some(c) => {
            let mut merged = th.get("custom").cloned().unwrap_or(json!({}));
            if fresh {
                obj(&mut merged).insert("elements".into(), "line".into());
            }
            for (k, v) in c.as_object().into_iter().flatten() {
                obj(&mut merged).insert(k.clone(), v.clone());
            }
            let issues = crate::schema::validate(
                &crate::schema::schema_of::<crate::input::ThemeSpec>(),
                &merged,
            );
            if !issues.is_empty() {
                return Err(format!(
                    "customTheme unvollständig: {}\nBeim ersten Setzen alle Pflichtfelder angeben.",
                    crate::schema::pretty(&issues)
                ));
            }
            obj(&mut merged).retain(|k, _| THEME_KEYS.contains(&k.as_str()));
            th.insert("custom".into(), merged);
            th.insert("id".into(), "custom".into());
        }
        None => {}
    }
    if has(i, "tune") {
        match merge_tune(th.get("tune"), i.get("tune")) {
            Some(x) => th.insert("tune".into(), x),
            None => th.remove("tune"),
        };
    }
    patch(th, i, "brand");
    let hints = if (ct.is_some() || has(i, "tune")) && given(&d["theme"], "custom").is_some() {
        check_theme(
            &lint_for(
                &spec_with_tune(&d["theme"]),
                given(&d["theme"], "brand"),
                has(i, "override"),
            ),
            "customTheme",
            &before,
        )? + &shadowed(ct, d["theme"].get("tune"))
    } else {
        String::new()
    };
    let o = obj(&mut d);
    for k in ["transition", "mode", "style"] {
        if let Some(v) = st(i, k) {
            o.insert(k.into(), v.into());
        }
    }
    match st(i, "motion") {
        Some("standard") => {
            o.remove("motion");
        }
        Some(m) => {
            o.insert("motion".into(), m.into());
        }
        None => {}
    }
    let th = obj(o.entry("theme").or_insert(json!({})));
    match i.get("shuffle").and_then(Value::as_i64) {
        Some(0) => {
            th.remove("shuffle");
        }
        Some(n) => {
            th.insert("shuffle".into(), n.into());
        }
        None => {}
    }
    patch(th, i, "fonts");
    if let Some(f) = st(i, "format").and_then(dw_model::format) {
        d = resize_deck(&d, f.w, f.h);
    }
    let fonts = t.put(&d)?;
    let d = t.need_deck()?;
    // Theme geändert → neue Vorschau
    let look = ["theme", "customTheme", "tune", "brand", "shuffle", "fonts"]
        .iter()
        .any(|k| {
            if *k == "theme" || *k == "customTheme" || *k == "tune" {
                given(i, k).is_some() || (*k == "customTheme" && has(i, k))
            } else {
                has(i, k)
            }
        });
    let mut theme = d["theme"].clone();
    obj(&mut theme).remove("fontFiles");
    let mut sum = Map::new();
    sum.insert("title".into(), d["title"].clone());
    sum.insert("theme".into(), theme);
    for k in ["transition", "mode"] {
        if let Some(v) = given(&d, k) {
            sum.insert(k.into(), v.clone());
        }
    }
    sum.insert(
        "style".into(),
        d.get("style").cloned().unwrap_or(json!("nicht gewählt")),
    );
    for k in ["music", "film", "videoRes"] {
        if let Some(v) = given(&d, k) {
            sum.insert(k.into(), v.clone());
        }
    }
    Ok(ToolOutput {
        text: format!(
            "{hints}{fonts}Deck aktualisiert: {}{}",
            Value::Object(sum),
            if look {
                format!("\n{PREVIEW_HINT}")
            } else {
                String::new()
            }
        ),
        images: if look { t.theme_preview(&d) } else { vec![] },
    })
}

/// Hintergrundmusik: asset://-URL oder absoluter Pfad einer Audiodatei → asset://-URL
fn audio_src(src: &str, what: &str) -> Result<String, String> {
    let path = asset_path(src);
    if !path.is_absolute() {
        return Err(format!(
            "{what} \"{src}\": asset://-Pfad aus find_music oder absoluten Dateipfad angeben."
        ));
    }
    if dw_store::media_kind(&path) != Some(dw_store::MediaKind::Audio) {
        return Err(format!("{what}: {} ist keine Audiodatei.", path.display()));
    }
    if !path.is_file() {
        return Err(format!(
            "{} nicht gefunden: {}",
            if what == "music.src" {
                "Musik".to_string()
            } else {
                format!("{what}: Datei")
            },
            path.display()
        ));
    }
    Ok(asset_url(&path))
}

/// Magic Resize (items.ts resizeDeck): freie Elemente mitskalieren, Gruppen als Ganzes
fn resize_deck(d: &Value, tw: f64, th: f64) -> Value {
    let size = d
        .get("size")
        .cloned()
        .unwrap_or(json!({"w": 1280, "h": 720}));
    let (fw, fh) = (
        size["w"].as_f64().unwrap_or(1280.0),
        size["h"].as_f64().unwrap_or(720.0),
    );
    let (sx, sy) = (tw / fw, th / fh);
    let k = sx.min(sy);
    let r = |v: f64| round(v * 100.0) / 100.0;
    let num = |v: &Value, key: &str| v.get(key).and_then(Value::as_f64);
    let place = |b: [f64; 4]| -> [f64; 4] {
        let (w, h) = (b[2] * k, b[3] * k);
        [
            r((b[0] + b[2] / 2.0) * sx - w / 2.0),
            r((b[1] + b[3] / 2.0) * sy - h / 2.0),
            r(w),
            r(h),
        ]
    };
    let bx = |it: &Value| {
        [
            num(it, "x").unwrap_or(0.0),
            num(it, "y").unwrap_or(0.0),
            num(it, "w").unwrap_or(0.0),
            num(it, "h").unwrap_or(0.0),
        ]
    };
    const XYWH: [&str; 4] = ["x", "y", "w", "h"];
    let fit = |it: &Value| -> Value {
        let mut out = it.clone();
        let o = obj(&mut out);
        for (n, v) in XYWH.iter().zip(place(bx(it))) {
            o.insert((*n).into(), json!(v));
        }
        if let Some(keys) = it.get("keys").and_then(Value::as_array) {
            // Ziel je Takt aus dem bis dahin gültigen Stand umrechnen (fehlende Werte bleiben)
            let mut ks = keys.clone();
            ks.sort_by(|a, b| {
                num(a, "step")
                    .partial_cmp(&num(b, "step"))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let mut cur = bx(it);
            let ks: Vec<Value> = ks
                .into_iter()
                .map(|key| {
                    for (j, n) in XYWH.iter().enumerate() {
                        if let Some(v) = num(&key, n) {
                            cur[j] = v;
                        }
                    }
                    let f = place(cur);
                    let mut nk = key.clone();
                    for (j, n) in XYWH.iter().enumerate() {
                        if has(&key, n) {
                            obj(&mut nk).insert((*n).into(), json!(f[j]));
                        }
                    }
                    nk
                })
                .collect();
            o.insert("keys".into(), Value::Array(ks));
        }
        for key in ["size", "strokeW", "radius"] {
            if let Some(v) = num(it, key).filter(|v| *v != 0.0) {
                o.insert(key.into(), json!(r(v * k)));
            }
        }
        out
    };
    let mut out = d.clone();
    for s in out
        .get_mut("slides")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let Some(items) = s
            .get("items")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty())
            .cloned()
        else {
            continue;
        };
        let mut fitted: Vec<Value> = items.iter().map(fit).collect();
        let mut groups: Vec<&str> = vec![];
        for it in &items {
            if let Some(g) = st(it, "group").filter(|g| !g.is_empty())
                && !groups.contains(&g)
            {
                groups.push(g);
            }
        }
        // Gruppen bewegen sich als Ganzes: gemeinsamer Mittelpunkt statt je Element
        for g in groups {
            let idx: Vec<usize> = (0..items.len())
                .filter(|&j| st(&items[j], "group") == Some(g))
                .collect();
            let b: Vec<[f64; 4]> = idx.iter().map(|&j| bx(&items[j])).collect();
            let x = b.iter().map(|b| b[0]).fold(f64::INFINITY, f64::min);
            let y = b.iter().map(|b| b[1]).fold(f64::INFINITY, f64::min);
            let cx = (x + b
                .iter()
                .map(|b| b[0] + b[2])
                .fold(f64::NEG_INFINITY, f64::max))
                / 2.0;
            let cy = (y + b
                .iter()
                .map(|b| b[1] + b[3])
                .fold(f64::NEG_INFINITY, f64::max))
                / 2.0;
            for (&j, bb) in idx.iter().zip(&b) {
                let (w, h) = (
                    num(&fitted[j], "w").unwrap_or(0.0),
                    num(&fitted[j], "h").unwrap_or(0.0),
                );
                let o = obj(&mut fitted[j]);
                o.insert(
                    "x".into(),
                    json!(r(cx * sx + (bb[0] + bb[2] / 2.0 - cx) * k - w / 2.0)),
                );
                o.insert(
                    "y".into(),
                    json!(r(cy * sy + (bb[1] + bb[3] / 2.0 - cy) * k - h / 2.0)),
                );
            }
        }
        obj(s).insert("items".into(), Value::Array(fitted));
    }
    let o = obj(&mut out);
    if tw == 1280.0 && th == 720.0 {
        o.remove("size");
    } else {
        o.insert("size".into(), json!({"w": tw, "h": th}));
    }
    out
}

/// Folienfelder aus add_slides, die unverändert übernommen werden
const SLIDE_PLAIN: [&str; 9] = [
    "variant",
    "build",
    "transition",
    "tone",
    "decor",
    "frame",
    "bg",
    "duration",
    "camera",
];

fn add_slides(t: &Tools, i: &Value) -> R {
    check_fonts(i)?;
    let mut d = t.need_deck()?;
    let mut fresh = vec![];
    for (k, s) in i["slides"].as_array().into_iter().flatten().enumerate() {
        let layout = st(s, "layout").unwrap_or("");
        let at = format!("slides[{k}]");
        check_frame(layout, st(s, "frame"), &at)?;
        let mut n = json!({"id": "", "layout": layout});
        let o = obj(&mut n);
        for f in SLIDE_PLAIN {
            if let Some(v) = given(s, f) {
                o.insert(f.into(), v.clone());
            }
        }
        if let Some(x) = st(s, "notes").filter(|x| !x.is_empty()) {
            o.insert("notes".into(), typeset(x).into());
        }
        if let Some(it) = given(s, "items") {
            o.insert("items".into(), with_ids(it));
        }
        if let Some(v) = st(s, "voice").filter(|v| !v.trim().is_empty()) {
            o.insert("voice".into(), typeset(v).into());
        }
        o.insert(
            "content".into(),
            validate_content(layout, &s["content"], &at)?,
        );
        fresh.push(n);
    }
    let list = obj(&mut d)
        .entry("slides")
        .or_insert(json!([]))
        .as_array_mut()
        .ok_or("slides fehlt")?;
    let mut ids = list.clone();
    for s in &mut fresh {
        keep_links(s, None);
        s["id"] = new_slide_id(&ids).into();
        ids.push(s.clone());
    }
    let at = i
        .get("at")
        .and_then(Value::as_u64)
        .map_or(list.len(), |x| x as usize)
        .min(list.len());
    let n = fresh.len();
    list.splice(at..at, fresh);
    let fonts = t.put(&d)?;
    let idx: Vec<usize> = (at..at + n).collect();
    Ok(ToolOutput::text(fonts + &t.report(&d, &idx)))
}

fn update_slide(t: &Tools, i: &Value) -> R {
    check_fonts(i)?;
    let mut d = t.need_deck()?;
    let id = st(i, "id").unwrap_or("");
    let idx = index_of(&d, id)?;
    let old = d["slides"][idx].clone();
    let s = &mut d["slides"][idx];
    let cur = st(s, "layout").unwrap_or("").to_string();
    let layout = st(i, "layout").unwrap_or(&cur).to_string();
    let merged = if layout != cur {
        i.get("content").cloned().unwrap_or(json!({}))
    } else {
        let mut c = s.get("content").cloned().unwrap_or(json!({}));
        for (k, v) in i
            .get("content")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            obj(&mut c).insert(k.clone(), v.clone());
        }
        c
    };
    let at = format!("Folie {id}");
    let frame = match i.get("frame") {
        None => st(s, "frame"),
        Some(f) => f.as_str(),
    };
    check_frame(&layout, frame, &at)?; // vor jeder Änderung
    let content = validate_content(&layout, &merged, &at)?;
    let o = obj(s);
    o.insert("content".into(), content);
    o.insert("layout".into(), layout.into());
    for f in [
        "variant",
        "tone",
        "decor",
        "frame",
        "build",
        "transition",
        "bg",
        "duration",
        "camera",
    ] {
        patch(o, i, f);
    }
    for f in ["notes", "voice"] {
        match st(i, f) {
            Some(x) if !x.is_empty() => {
                o.insert(f.into(), typeset(x).into());
            }
            _ if has(i, f) => {
                o.remove(f);
            }
            _ => {}
        }
    }
    match i.get("items") {
        Some(Value::Null) => {
            o.remove("items");
        }
        Some(it) => {
            o.insert("items".into(), with_ids(it));
        }
        None => {}
    }
    match i.get("hidden").and_then(Value::as_bool) {
        Some(true) => {
            o.insert("hidden".into(), true.into());
        }
        Some(false) => {
            o.remove("hidden");
        }
        None => {}
    }
    let linked = keep_links(s, Some(&old));
    let fonts = t.put(&d)?;
    Ok(ToolOutput::text(fonts + &linked + &t.report(&d, &[idx])))
}

fn reorder_slides(t: &Tools, i: &Value) -> R {
    let mut d = t.need_deck()?;
    let ids: Vec<&str> = slides(&d).iter().filter_map(|s| st(s, "id")).collect();
    let order: Vec<&str> = i["order"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let (mut a, mut b) = (ids.clone(), order.clone());
    a.sort();
    b.sort();
    if a != b {
        return Err(format!(
            "order muss genau alle IDs enthalten: {}",
            ids.join(", ")
        ));
    }
    let next: Vec<Value> = order
        .iter()
        .map(|id| index_of(&d, id).map(|k| d["slides"][k].clone()))
        .collect::<Result<_, _>>()?;
    d["slides"] = Value::Array(next);
    t.set_deck(typed(&d)?);
    let line: Vec<String> = slides(&d)
        .iter()
        .enumerate()
        .map(|(k, s)| format!("{}:{}{}", k + 1, st(s, "layout").unwrap_or(""), hid(s)))
        .collect();
    Ok(ToolOutput::text(format!(
        "Neue Reihenfolge: {}",
        line.join(" ")
    )))
}

fn delete_slides(t: &Tools, i: &Value) -> R {
    let mut d = t.need_deck()?;
    let ids: Vec<&str> = i["ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    for id in &ids {
        index_of(&d, id)?;
    }
    let keep: Vec<Value> = slides(&d)
        .iter()
        .filter(|s| !ids.contains(&st(s, "id").unwrap_or("")))
        .cloned()
        .collect();
    d["slides"] = Value::Array(keep);
    t.set_deck(typed(&d)?);
    Ok(ToolOutput::text(format!(
        "{} Folie(n) gelöscht, {} übrig.",
        ids.len(),
        slides(&d).len()
    )))
}

fn decorate_slide(t: &Tools, i: &Value) -> R {
    let mut d = t.need_deck()?;
    let idx = index_of(&d, st(i, "id").unwrap_or(""))?;
    let mut items: Vec<Value> = d["slides"][idx]["items"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    items.retain(|it| st(it, "id") != Some("accent"));
    let mut place = "entfernt".to_string();
    if let Some(a) = given(i, "accent") {
        let kind = st(a, "kind").unwrap_or("");
        if !has(a, kind) {
            return Err(format!("accent.{kind} fehlt"));
        }
        obj(&mut d["slides"][idx]).insert("items".into(), Value::Array(items.clone()));
        let deck = typed(&d)?;
        let m = t
            .ctx
            .engine
            .measure(&deck, &[idx])?
            .into_iter()
            .next()
            .ok_or("keine Messung")??;
        let size = deck.size();
        let (w, h) = (size.w, size.h);
        let sz = st(a, "size").unwrap_or("m");
        let px = match sz {
            "s" => 72.0,
            "l" => 160.0,
            _ => 112.0,
        };
        let (gap, edge) = (16.0, 28.0);
        let blocked: Vec<dw_model::ElBox> = m
            .els
            .iter()
            .filter(|e| {
                !e.base().slot.starts_with("items.")
                    && !matches!(e, El::Img(img) if img.under == Some(true))
            })
            .map(|e| e.base().bbox)
            .collect();
        let free = |x: f64, y: f64| {
            blocked.iter().all(|b| {
                x + px + gap <= b.x
                    || x >= b.x + b.w + gap
                    || y + px + gap <= b.y
                    || y >= b.y + b.h + gap
            })
        };
        // Kandidaten von der Ecke nach innen, nächstgelegene zuerst
        let zone = st(a, "zone").unwrap_or("top-right");
        let (right, bottom) = (zone.ends_with("right"), zone.starts_with("bottom"));
        let mut cands = vec![];
        let mut dx = 0.0;
        while dx <= w / 2.0 - px {
            let mut dy = 0.0;
            while dy <= h / 2.0 - px {
                cands.push((
                    if right { w - edge - px - dx } else { edge + dx },
                    if bottom {
                        h - edge - px - dy
                    } else {
                        edge + dy
                    },
                ));
                dy += 16.0;
            }
            dx += 16.0;
        }
        let dist = |p: &(f64, f64)| {
            (p.0 - if right { w } else { 0.0 }).hypot(p.1 - if bottom { h } else { 0.0 })
        };
        cands.sort_by(|p, q| {
            dist(p)
                .partial_cmp(&dist(q))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let Some(&(x, y)) = cands.iter().find(|(x, y)| free(*x, *y)) else {
            return Err(format!(
                "In der Ecke {zone} ist kein Platz für Größe {sz}. Kleinere Größe oder andere Ecke wählen."
            ));
        };
        let color = st(a, "color").map(str::to_string).unwrap_or_else(|| {
            dw_theme::resolve_theme(&deck.theme, None)
                .c
                .accent2
                .to_hex()
        });
        let mut it = json!({"id": "accent", "x": x, "y": y, "w": px, "h": px});
        if let Some(r) = given(a, "rot") {
            it["rot"] = r.clone();
        }
        let (field, paint) = match kind {
            "shape" => ("shape", "fill"),
            "graphic" => ("graphic", "color"),
            _ => ("icon", "color"),
        };
        it["kind"] = field.into();
        it[field] = a[field].clone();
        it[paint] = color.into();
        items.push(it);
        let n = dw_lint::js::num;
        place = format!("gesetzt bei x={}, y={} ({} px)", n(x), n(y), n(px));
    }
    obj(&mut d["slides"][idx]).insert("items".into(), Value::Array(items));
    t.set_deck(typed(&d)?);
    Ok(ToolOutput::text(format!(
        "Akzent {place}.\n{}",
        t.report(&d, &[idx])
    )))
}

fn render_slides(t: &Tools, i: &Value) -> R {
    let d = t.need_deck()?;
    let idx: Vec<usize> = i["ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|id| index_of(&d, id))
        .collect::<Result<_, _>>()?;
    if has(i, "at") {
        if idx.len() > 2 {
            return Err("Mit at höchstens 2 ids (je Zeitpunkt ein Bild).".into());
        }
        return hook(t, "render_slides", i); // Frames der Film-Zeitachse
    }
    let width = i.get("width").and_then(Value::as_u64).unwrap_or(1024) as u32;
    let images = t.ctx.engine.render_png(&typed(&d)?, &idx, width)?;
    let s = slides(&d);
    let text = idx
        .iter()
        .map(|&k| {
            format!(
                "Folie {} ({}, {}){}",
                k + 1,
                st(&s[k], "id").unwrap_or(""),
                st(&s[k], "layout").unwrap_or(""),
                hid(&s[k])
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(ToolOutput { text, images })
}

fn propose_looks(t: &Tools, i: &Value) -> R {
    check_fonts(i)?;
    let title = t
        .deck()
        .map(|d| d.title)
        .unwrap_or_else(|| "Vorschau".into());
    let looks: Vec<&Value> = i["looks"].as_array().into_iter().flatten().collect();
    let refs: Vec<Value> = looks
        .iter()
        .map(|l| match l.as_str() {
            Some(id) => json!({"id": id}),
            None => {
                let mut c = (*l).clone();
                obj(&mut c).entry("elements").or_insert(json!("line"));
                json!({"id": "custom", "custom": c})
            }
        })
        .collect();
    let kit = t.default_brand();
    let mut lint = String::new();
    for (k, l) in looks.iter().enumerate().filter(|(_, l)| l.is_object()) {
        lint += &check_theme(
            &lint_for(l, kit.as_ref(), has(i, "override")),
            &format!("Look {} {}", k + 1, st(l, "name").unwrap_or("")),
            &[],
        )?;
    }
    let spec = |v: &Value| serde_json::from_value::<dw_lint::theme::ThemeSpec>(v.clone()).ok();
    // Guide §6: Entwürfe unterscheiden sich in der Struktur (mindestens 4 Merkmale), sonst nur Umfärbungen
    let traits: Vec<Vec<(&str, Value)>> = refs
        .iter()
        .map(|r| {
            let th = dw_theme::resolve_theme(&theme_ref(r), None);
            let ax = r
                .get("custom")
                .and_then(spec)
                .map(|s| dw_lint::theme::axes_of(&s));
            let ax = ax.as_ref();
            vec![
                ("hell/dunkel", json!(th.dark)),
                ("Serif/Sans", json!(th.head.font.serif)),
                ("titleSize", json!(th.head_scale.unwrap_or(1.0) > 1.0)),
                ("titleWeight", json!(th.head.weight)),
                ("rule", json!(th.rule.map_or("none", |x| x.as_str()))),
                (
                    "sectionTone",
                    json!(th.section_tone.map_or("accent", |x| x.as_str())),
                ),
                ("Farbgrund", json!(th.vivid)),
                (
                    "Bauteile",
                    json!(th.elements.map_or("line", |x| x.as_str())),
                ),
                ("field", json!(ax.is_some_and(|a| a.field == Some(true)))),
                (
                    "signature",
                    json!(
                        ax.and_then(|a| a.signature.clone())
                            .unwrap_or("none".into())
                    ),
                ),
                (
                    "margin/measure",
                    json!(
                        ax.and_then(|a| a.space.clone())
                            .unwrap_or("standard".into())
                    ),
                ),
                (
                    "heroTone",
                    json!(
                        ax.and_then(|a| a.hero_tone.clone())
                            .unwrap_or("normal".into())
                    ),
                ),
            ]
        })
        .collect();
    for a in 0..traits.len() {
        for b in a + 1..traits.len() {
            let same: Vec<&str> = traits[a]
                .iter()
                .zip(&traits[b])
                .filter(|(x, y)| x.1 == y.1)
                .map(|(x, _)| x.0)
                .collect();
            let differ = traits[a].len() - same.len();
            if differ < 4 {
                return Err(format!(
                    "Look {} und {} unterscheiden sich kaum, gleich sind: {}. Ändere bei einem mindestens {} davon, damit der Nutzer echte Alternativen sieht.",
                    a + 1,
                    b + 1,
                    same.join(", "),
                    4 - differ
                ));
            }
        }
    }
    // dazu Farbstrategie und Schriftgenre als Hinweis
    let axes: Vec<_> = looks
        .iter()
        .filter(|l| l.is_object())
        .filter_map(|l| spec(l))
        .map(|s| dw_lint::theme::axes_of(&s))
        .collect();
    let similar: String = dw_lint::lint_looks(&axes, font_catalog())
        .iter()
        .map(|x| format!("Hinweis: {}\n", x.message))
        .collect();
    // Guide §6 „Abwechslung“: mindestens ein Look hebt sich im Typ von den letzten Decks ab (mit Brand-Kit gilt dessen Look)
    let recent = if kit.is_some() {
        vec![]
    } else {
        recent_looks(t, None)
    };
    let reps: Vec<String> = refs
        .iter()
        .map(|r| repeats(&look_typ(r), &recent))
        .collect();
    if reps.iter().all(|x| !x.is_empty()) {
        return Err(format!(
            "Alle Looks gleichen im Typ deinen letzten Decks ({}). Baue mindestens einen Look in Grund (getönt, dunkel, im Stil mutig kräftig), Schrift (Sans statt Serif oder umgekehrt), Titelgewicht oder Bauteile (line/plain) anders – außer der Nutzer will eine Serie, dann create_deck direkt (Design-Guide §6 „Abwechslung“).",
            recent
                .iter()
                .take(3)
                .map(|r| format!("„{}“: {}", r.0, typ_text(&r.1)))
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    let mut images = vec![];
    for r in &refs {
        let mut p = t.theme_preview(&json!({"title": title, "theme": r, "transition": "fade", "mode": "click", "slides": []}));
        if p.is_empty() {
            return Err("Vorschau fehlgeschlagen, bitte einzeln mit create_deck prüfen.".into());
        }
        images.push(p.remove(0));
    }
    let label = |l: &Value| match l.as_str() {
        Some(id) => dw_theme::theme(id).map_or(id.to_string(), |x| x.name.clone()),
        None => st(l, "name").unwrap_or("").into(),
    };
    let names = looks
        .iter()
        .enumerate()
        .map(|(k, l)| format!("{}. {}", k + 1, label(l)))
        .collect::<Vec<_>>()
        .join("\n");
    let hints = lint
        + &similar
        + &reps
            .iter()
            .enumerate()
            .filter(|(_, x)| !x.is_empty())
            .map(|(k, x)| format!("Hinweis: Look {} {x}\n", k + 1))
            .collect::<String>();
    let Some(choice) = &t.ctx.choice else {
        return Ok(ToolOutput {
            text: format!(
                "{hints}Looks (Bilder in dieser Reihenfolge):\n{names}\nZeig dem Nutzer die Namen und frag, welchen er möchte."
            ),
            images,
        });
    };
    let opts: Vec<(String, String)> = looks
        .iter()
        .zip(&images)
        .map(|(l, b)| {
            (
                label(l),
                format!("data:{};base64,{}", mime_of(b), base64(b)),
            )
        })
        .collect();
    choice("Welcher Look soll es werden?", &opts);
    Ok(ToolOutput {
        text: format!(
            "{hints}Looks zur Auswahl angezeigt:\n{names}\nBeende jetzt den Turn ohne weiteren Text; die Wahl kommt als nächste Nachricht (Name des Looks)."
        ),
        images,
    })
}

fn render_overview(t: &Tools) -> R {
    let d = t.need_deck()?;
    if slides(&d).is_empty() {
        return Err("Das Deck hat noch keine Folien.".into());
    }
    let order = slides(&d)
        .iter()
        .map(|s| format!("{}{}", st(s, "layout").unwrap_or(""), hid(s)))
        .collect::<Vec<_>>()
        .join(" → ");
    let png = t.ctx.engine.render_overview(&typed(&d)?)?;
    Ok(ToolOutput {
        text: format!(
            "Kontaktbogen: {} Folien, Reihenfolge {order}\n{ART_DIRECTOR}",
            slides(&d).len()
        ),
        images: vec![png],
    })
}

fn lint_deck(t: &Tools) -> R {
    let d = t.need_deck()?;
    let deck = typed(&d)?;
    let measured = t.measure_all(&deck)?;
    let all: Vec<usize> = (0..deck.slides.len()).collect();
    let mut issues: Vec<Note> = t.lint(&deck, &measured).into_iter().map(note_of).collect();
    issues.extend(
        t.clip_checks(&deck, &all)
            .into_iter()
            .flat_map(|c| c.1.issues),
    );
    issues.sort_by_key(|x| x.slide); // stabil: je Folie erst Lint, dann Clip-Prüfung
    if issues.is_empty() {
        return Ok(ToolOutput::text("Keine Probleme. Das Deck ist sauber."));
    }
    let e = issues.iter().filter(|x| x.severity == "error").count();
    let h = issues.iter().filter(|x| x.severity == "info").count();
    let lines = issues
        .iter()
        .map(|x| {
            format!(
                "  - Folie {} ({}){} [{}] {}{}: {}",
                x.slide + 1,
                x.slide_id,
                hid(&d["slides"][x.slide]),
                sev(x.severity),
                x.rule,
                x.slot
                    .as_ref()
                    .map(|s| format!(" @{s}"))
                    .unwrap_or_default(),
                x.message
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(ToolOutput::text(format!(
        "{e} Fehler, {} Warnungen{}:\n{lines}",
        issues.len() - e - h,
        if h > 0 {
            format!(", {h} Hinweise")
        } else {
            String::new()
        }
    )))
}

fn search_icons(i: &Value) -> R {
    let q = st(i, "query").unwrap_or("");
    let terms: Vec<String> = q
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect();
    let limit = i.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
    let hits: Vec<&str> = catalog::icons()
        .iter()
        .filter(|n| terms.iter().any(|t| n.contains(t.as_str())))
        .take(limit)
        .map(String::as_str)
        .collect();
    Ok(ToolOutput::text(if hits.is_empty() {
        format!("Kein Icon zu \"{q}\". Anderen englischen Begriff versuchen.")
    } else {
        hits.join(", ")
    }))
}

fn read_guide(t: &Tools, i: &Value) -> R {
    if st(i, "topic") == Some("timeline") && !PRO {
        return Err("timeline (Mehrspur-Schnitt) gibt es nur in Deckwerk Pro.".into());
    }
    hook(t, "read_guide", i)
}

fn find_images(t: &Tools, i: &Value) -> R {
    if let Some(u) = st(i, "url") {
        return if u.starts_with("asset:") {
            t.view_asset(u)
        } else {
            hook(t, "find_images", i)
        };
    }
    let q = st(i, "query").map(str::to_lowercase);
    let dir = t.ctx.store.assets_dir();
    let mut local = vec![];
    walk_images(&dir, &mut local);
    local.retain(|(f, _)| {
        q.as_ref().is_none_or(|q| {
            f.strip_prefix(&dir)
                .unwrap_or(f)
                .to_string_lossy()
                .to_lowercase()
                .contains(q.as_str())
        })
    });
    local.sort_by_key(|f| std::cmp::Reverse(f.1));
    let files: Vec<PathBuf> = local.into_iter().map(|x| x.0).collect();
    let source = st(i, "source").unwrap_or("auto");
    if source == "local" || (source == "auto" && !files.is_empty()) {
        return t.local_images(
            &files,
            i.get("limit").and_then(Value::as_u64).unwrap_or(3) as usize,
        );
    }
    if q.is_none() {
        return Ok(ToolOutput::text(format!(
            "{}Für Fotos aus dem Netz eine englische query angeben.",
            if files.is_empty() {
                "Keine lokalen Bilder. "
            } else {
                ""
            }
        )));
    }
    hook(t, "find_images", i) // Unsplash, Openverse
}

fn export_deck(t: &Tools, i: &Value) -> R {
    let d = t.need_deck()?;
    let format = st(i, "format").unwrap_or("");
    let audio = format == "mp3" || format == "m4a";
    if !audio && slides(&d).is_empty() {
        return Err("Das Deck hat noch keine Folien.".into());
    }
    if !["png", "pdf", "pptx", "md"].contains(&format) {
        return hook(t, "export_deck", i); // docx, zip, print, Video, Podcast
    }
    if has(i, "formats") {
        return Err("formats gibt es nur für clips und mp4.".into());
    }
    let deck = typed(&d)?;
    let out = t.out_dir();
    if let Some(rows) = i.get("rows").and_then(Value::as_array) {
        let files = export_series(t, &deck, rows, format, &out)?;
        return Ok(ToolOutput::text(format!(
            "Exportiert ({format}):\n{}",
            files
                .iter()
                .map(|f| f.display().to_string())
                .collect::<Vec<_>>()
                .join("\n")
        )));
    }
    if format == "md" {
        return Ok(ToolOutput::text(format!(
            "Exportiert (md):\n{}",
            md_file(&deck, &out)?.display()
        )));
    }
    // geändertes Deck = neuer Export
    let key = format!("export:{}", key_of(&json!([format, out, d])));
    let j = t.job(&key, || t.ctx.engine.export(&deck, format, &out))?;
    if !j.done {
        return Ok(ToolOutput::text(still_running("Export", j.pct)));
    }
    if let Some(e) = j.error {
        return Err(e);
    }
    let mut lines = vec![format!("Exportiert ({format}):")];
    lines.extend(files_of(&j.files).iter().map(|f| f.display().to_string()));
    lines.extend(j.warnings);
    Ok(ToolOutput::text(lines.join("\n")))
}

/// PNG-Export liefert einen Ordner: die Dateien darin, sortiert
fn files_of(files: &[PathBuf]) -> Vec<PathBuf> {
    files
        .iter()
        .flat_map(|f| {
            if f.is_dir() {
                let mut v: Vec<PathBuf> = std::fs::read_dir(f)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|e| e.path())
                    .collect();
                v.sort();
                v
            } else {
                vec![f.clone()]
            }
        })
        .collect()
}

/// Handout (Titel, Inhalte, Notizen) wie engine.ts: <out>/<slug><format>.md
fn md_file(deck: &Deck, out: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let file = out.join(format!(
        "{}{}.md",
        dw_store::file_slug(&deck.title),
        dw_model::format_suffix(deck.size)
    ));
    dw_store::write_atomic(&file, dw_lint::handout(deck).as_bytes()).map_err(|e| e.to_string())?;
    Ok(file)
}

/// Serienbrief: je Zeile ein gefülltes Deck, seriell nach <out>/serie-<format>/NNN-<erster Wert>
fn export_series(
    t: &Tools,
    deck: &Deck,
    rows: &[Value],
    format: &str,
    out: &Path,
) -> Result<Vec<PathBuf>, String> {
    let rows: Vec<dw_lint::Row> = rows
        .iter()
        .map(|r| {
            r.as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                .collect()
        })
        .collect();
    let missing: Vec<String> = dw_lint::placeholders(deck)
        .into_iter()
        .filter(|k| rows.iter().any(|r| !r.iter().any(|(c, _)| c == k)))
        .collect();
    if !missing.is_empty() {
        let have = rows
            .first()
            .map(|r| {
                r.iter()
                    .map(|(k, _)| k.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|s| !s.is_empty())
            .unwrap_or("–".into());
        return Err(format!(
            "Spalten fehlen für Platzhalter: {}. Vorhanden: {have}",
            missing
                .iter()
                .map(|k| format!("{{{{{k}}}}}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let dir = out.join(format!("serie-{format}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // nur eigene Altlasten früherer Läufe entfernen, sonst mischen sich alte und neue Serie; fremde Dateien bleiben
    let own = regex::Regex::new(r"^(\d{3}-|\d{3}$|\.tmp-)").unwrap();
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        if own.is_match(&e.file_name().to_string_lossy()) {
            let p = e.path();
            let _ = if p.is_dir() {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_file(&p)
            };
        }
    }
    let word = regex::Regex::new(r"[^\p{L}\p{N}]+").unwrap();
    let mut files = vec![];
    for (n, row) in rows.iter().enumerate() {
        // Engine benennt nach dem Deck-Titel; daher in einen Zwischenordner exportieren und umbenennen
        let tmp = dir.join(format!(".tmp-{n}"));
        let filled = dw_lint::fill_deck(deck, row);
        let r = (|| -> Result<(), String> {
            let made = if format == "md" {
                vec![md_file(&filled, &tmp)?]
            } else {
                let id = t.ctx.engine.export(&filled, format, &tmp)?;
                loop {
                    let j = t.ctx.engine.job(id)?;
                    if j.done {
                        if let Some(e) = j.error {
                            return Err(e);
                        }
                        break j.files;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            };
            let first = row
                .first()
                .map(|(_, v)| v.to_lowercase())
                .unwrap_or_default();
            let slug: String = word
                .replace_all(&first, "-")
                .trim_matches('-')
                .chars()
                .take(40)
                .collect();
            let name = [format!("{:03}", n + 1), slug]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("-");
            for f in made {
                let ext = f
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_default();
                let to = dir.join(format!("{name}{ext}"));
                std::fs::rename(&f, &to).map_err(|e| format!("{}: {e}", to.display()))?;
                files.push(to);
            }
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(&tmp);
        r?;
    }
    Ok(files)
}

/// Hausstil (hausstil.md): ein kurzer Satz je Aufruf
fn remember(t: &Tools, i: &Value) -> R {
    let note = st(i, "note").unwrap_or("").trim();
    if t.ctx.store.house_style().contains(note) {
        return Ok(ToolOutput::text("Steht schon im Hausstil."));
    }
    let f = t.ctx.store.root().join("hausstil.md");
    let old = std::fs::read_to_string(&f).unwrap_or_default();
    t.ctx
        .store
        .set_house_style(&format!("{old}- {note}\n"))
        .map_err(|e| e.to_string())?;
    Ok(ToolOutput::text(format!(
        "Gemerkt ({}). Gilt ab jetzt für jedes Deck; sag dem Nutzer kurz Bescheid.",
        f.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helfer() {
        assert_eq!(sec(12.34), "12,3");
        assert_eq!(sec(5.0), "5");
        assert_eq!(base64(b"Deckwerk"), "RGVja3dlcms=");
        let png = [
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 3, 0, 0, 0, 2,
        ];
        assert_eq!(image_size(&png), Some((3, 2)));
        let jpg = [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0xaa, 0xaa, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02,
            0x80, 0x01, 0xe0, 0x03, 0x00,
        ];
        assert_eq!(image_size(&jpg), Some((480, 640)));
        assert_eq!(
            image_size(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
            None
        );
        assert_eq!(
            asset_path(&asset_url(Path::new("/a b/ä.png"))),
            PathBuf::from("/a b/ä.png")
        );
        assert_eq!(new_id().len(), 8);
        assert_ne!(new_id(), new_id());
    }
}
