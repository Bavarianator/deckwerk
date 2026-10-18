//! Werkzeuge gegen eine Attrappe der Engine (wie scripts/agent-smoke.ts): Anzahl, Rückmeldung je Folie, Fehlertexte,
//! Hooks „noch nicht verfügbar“, Jobs mit „läuft noch“.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use dw_model::{Deck, Measured};
use dw_store::{Edition, Store};
use dw_tools::{Engine, Job, ToolCtx, Tools};
use serde_json::{Value, json};

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47];

#[derive(Default)]
struct Mock {
    polls: AtomicU32,
    exported: Mutex<Vec<PathBuf>>,
}

impl Engine for &'static Mock {
    fn measure(
        &self,
        deck: &Deck,
        slides: &[usize],
    ) -> Result<Vec<Result<Measured, String>>, String> {
        Ok(slides
            .iter()
            .map(|&i| {
                if deck.slides[i].layout == "gantt" {
                    return Err("unbekanntes Layout: gantt".into());
                }
                Ok(serde_json::from_value(
                    json!({"els": [], "fit": {"ok": true, "head": 0, "body": 1, "overflow": []}}),
                )
                .unwrap())
            })
            .collect())
    }
    fn render_png(&self, _: &Deck, slides: &[usize], _: u32) -> Result<Vec<Vec<u8>>, String> {
        Ok(slides.iter().map(|_| PNG.to_vec()).collect())
    }
    fn render_overview(&self, _: &Deck) -> Result<Vec<u8>, String> {
        Ok(PNG.to_vec())
    }
    fn export(&self, _: &Deck, f: &str, out: &Path) -> Result<u64, String> {
        self.exported
            .lock()
            .unwrap()
            .push(out.join(format!("deck.{f}")));
        Ok(7)
    }
    fn job(&self, _: u64) -> Result<Job, String> {
        // erst beim dritten Nachsehen fertig
        let n = self.polls.fetch_add(1, Ordering::Relaxed);
        Ok(Job {
            done: n >= 2,
            pct: 40.0,
            files: vec!["/x/deck.pptx".into()],
            warnings: vec![],
            error: None,
        })
    }
}

fn home(name: &str) -> Store {
    let d = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("dw-tools-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    Store::at(Edition::Deckwerk, &d).unwrap()
}

fn tools(name: &str, chat: bool) -> Tools {
    let mock: &'static Mock = Box::leak(Box::default());
    let mut ctx = ToolCtx::new(Box::new(mock), home(name));
    if chat {
        ctx.ask = Some(Box::new(|_, _| {}));
        ctx.storyline = Some(Box::new(|_| {}));
    }
    Tools::new(ctx)
}

fn text(t: &Tools, name: &str, i: Value) -> String {
    t.call(name, i)
        .unwrap_or_else(|e| panic!("{name}: {e}"))
        .text
}

#[test]
fn anzahl_wie_buildtools() {
    let fx: Value = serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/tests/fixtures/tools-{}.json",
            env!("CARGO_MANIFEST_DIR"),
            if dw_tools::PRO { "pro" } else { "deckwerk" }
        ))
        .unwrap(),
    )
    .unwrap();
    let names = |t: &Tools| {
        t.list()
            .iter()
            .map(|x| Value::from(x.name))
            .collect::<Vec<_>>()
    };
    // agent-smoke.ts: 28 Basis / 29 Pro; mit ask und storyline (App-Chat) 30 / 31
    assert_eq!(
        names(&tools("n1", false)),
        fx["agent"].as_array().unwrap().clone()
    );
    assert_eq!(
        names(&tools("n2", true)),
        fx["chat"].as_array().unwrap().clone()
    );
    assert_eq!(
        tools("n3", false).list().len(),
        if dw_tools::PRO { 29 } else { 28 }
    );
}

#[test]
fn deck_bauen_mit_rueckmeldung() {
    let t = tools("deck", false);
    assert_eq!(
        t.call(
            "add_slides",
            json!({"slides": [{"layout": "cover", "content": {"title": "Hallo"}}]})
        )
        .unwrap_err(),
        "Noch kein Deck. Erst create_deck aufrufen."
    );
    let c = text(
        &t,
        "create_deck",
        json!({"title": "Quartal \"Q3\"", "style": "sachlich"}),
    );
    assert!(c.starts_with("Deck \"Quartal „Q3“\" angelegt (Theme beratung, Übergang fade, Modus click, Stil sachlich). Bild: das Theme"), "{c}");
    let r = text(
        &t,
        "add_slides",
        json!({"slides": [
            {"layout": "cover", "content": {"title": "Wachstum mit Plan"}},
            {"layout": "bullets", "content": {"title": "Drei Hebel für das nächste Jahr", "items": [{"text": "Vertrieb"}, {"text": "Service"}, {"text": "Produkt"}]}}
        ]}),
    );
    let d = t.deck().unwrap();
    let (a, b) = (&d.slides[0].id, &d.slides[1].id);
    assert!(a.starts_with("s-") && a.len() == 10, "{a}");
    let first = r.lines().next().unwrap();
    assert_eq!(
        first,
        format!("Folie 1 ({a}, cover): OK · Autofit head 0/body 1 · Übergang none, ohne Aufbau")
    );
    assert!(r.contains(&format!("Folie 2 ({b}, bullets)")), "{r}");
    // ungültiger Inhalt: Pfad, zod-Meldung, Schema
    let e = t
        .call(
            "update_slide",
            json!({"id": a, "content": {"title": "x", "kicker": 1}}),
        )
        .unwrap_err();
    assert!(
        e.starts_with(&format!(
            "Folie {a} (cover): Inhalt ungültig.\nUnbekannte Felder: kicker (erlaubt: "
        )),
        "{e}"
    );
    assert!(
        e.contains("✖ Too small: expected string to have >=3 characters\n  → at title")
            && e.contains("Schema von cover: {"),
        "{e}"
    );
    // Schema der Eingabe
    let e = t.call("add_slides", json!({"slides": []})).unwrap_err();
    assert_eq!(
        e,
        "Eingabe für add_slides ungültig:\n✖ Too small: expected array to have >=1 items\n  → at slides"
    );
    // Grenzen aus dem Schema (render_slides width 320..1280)
    for (w, m) in [
        (100, "Too small: expected number to be >=320"),
        (2000, "Too big: expected number to be <=1280"),
    ] {
        let e = t
            .call("render_slides", json!({"ids": [a], "width": w}))
            .unwrap_err();
        assert_eq!(
            e,
            format!("Eingabe für render_slides ungültig:\n✖ {m}\n  → at width")
        );
    }
    assert_eq!(
        t.call("render_slides", json!({"ids": [a], "width": 320}))
            .unwrap()
            .images
            .len(),
        1
    );
    let e = t
        .call("update_slide", json!({"id": a, "frame": "split"}))
        .unwrap_err();
    assert_eq!(
        e,
        format!("Folie {a}: Layout cover kann frame \"split\" nicht. Erlaubt: top")
    );
    let u = text(
        &t,
        "update_slide",
        json!({"id": b, "notes": "Danke \"alle\"", "hidden": true}),
    );
    assert!(
        u.starts_with(&format!("Folie 2 ({b}, bullets) (ausgeblendet): ")),
        "{u}"
    );
    assert_eq!(t.deck().unwrap().slides[1].extra["notes"], "Danke „alle“");
    assert_eq!(
        text(&t, "reorder_slides", json!({"order": [b, a]})),
        "Neue Reihenfolge: 1:bullets (ausgeblendet) 2:cover"
    );
    assert!(
        t.call("reorder_slides", json!({"order": [a]}))
            .unwrap_err()
            .starts_with("order muss genau alle IDs enthalten")
    );
    let l = text(&t, "lint_deck", json!({}));
    assert!(
        l.contains("structure") || l == "Keine Probleme. Das Deck ist sauber.",
        "{l}"
    );
    let o = t.call("render_overview", json!({})).unwrap();
    assert!(o.text.starts_with("Kontaktbogen: 2 Folien, Reihenfolge bullets (ausgeblendet) → cover\nPrüfe als Art Director") && o.images.len() == 1);
    assert_eq!(
        text(&t, "delete_slides", json!({"ids": [a]})),
        "1 Folie(n) gelöscht, 1 übrig."
    );
    // Messung scheitert: kein Tool-Fehler, sonst wiederholt die KI die Änderung (Pro-Layout ist in beiden Editionen lesbar)
    let g = t.call("add_slides", json!({"slides": [{"layout": "gantt", "content": {"title": "Zeitplan bis zum Rollout", "rows": []}}]}));
    if let Ok(g) = g {
        assert!(
            g.text.contains("aber die Messung ist fehlgeschlagen")
                && g.text.contains("unbekanntes Layout: gantt"),
            "{}",
            g.text
        );
    }
}

#[test]
fn theme_lint_und_marke() {
    let t = tools("theme", false);
    let spec = json!({"name": "Mitte", "bg": "#888888", "accent": "#225588", "headFont": "Inter", "bodyFont": "Inter", "radius": 2, "decor": "none"});
    let e = t
        .call("create_deck", json!({"title": "T", "customTheme": spec}))
        .unwrap_err();
    assert!(
        e.starts_with(
            "customTheme: Theme-Lint lehnt ab:\n  - [error] bg-mid: Grund #888888 ist ein Mittelton"
        ),
        "{e}"
    );
    let ok = text(
        &t,
        "create_deck",
        json!({"title": "T", "customTheme": spec, "override": "Markenvorgabe des Kunden"}),
    );
    assert!(
        ok.starts_with("Theme-Hinweise (customTheme):\n  - [warn] bg-mid")
            && ok.contains("Theme eigenes: Mitte"),
        "{ok}"
    );
    assert_eq!(
        t.deck().unwrap().theme.custom.as_ref().unwrap()["elements"],
        "line"
    );
    let e = t
        .call("update_deck", json!({"fonts": ["Interr", "Inter"]}))
        .unwrap_err();
    assert!(
        e.contains("Schrift „Interr“ gibt es nicht – meintest du „Inter“?"),
        "{e}"
    );
    let u = text(
        &t,
        "update_deck",
        json!({"tune": {"margin": "generous"}, "transition": "push"}),
    );
    assert!(
        u.starts_with("Theme-Hinweise") || u.starts_with("Deck aktualisiert: {\"title\":\"T\""),
        "{u}"
    );
    assert!(
        u.contains("\"tune\":{\"margin\":\"generous\"}") && u.contains("\"transition\":\"push\""),
        "{u}"
    );
}

#[test]
fn hooks_symbole_merken_export() {
    let mut t = tools("hooks", false);
    for (name, i) in [
        (
            "generate_image",
            json!({"prompt": "a calm empty office at dawn"}),
        ),
        ("import_video", json!({})),
        ("read_guide", json!({})),
    ] {
        let e = t.call(name, i).unwrap_err();
        assert!(
            e.starts_with(&format!(
                "{name} ist in dieser Deckwerk-Version noch nicht verfügbar"
            )),
            "{e}"
        );
    }
    if !dw_tools::PRO {
        assert_eq!(
            t.call("read_guide", json!({"topic": "timeline"}))
                .unwrap_err(),
            "timeline (Mehrspur-Schnitt) gibt es nur in Deckwerk Pro."
        );
    }
    let s = text(&t, "search_icons", json!({"query": "shield", "limit": 3}));
    assert_eq!(s.split(", ").count(), 3);
    assert!(s.split(", ").all(|n| n.contains("shield")), "{s}");
    assert_eq!(
        text(&t, "search_icons", json!({"query": "qqqzzz"})),
        "Kein Icon zu \"qqqzzz\". Anderen englischen Begriff versuchen."
    );
    let m = text(&t, "remember", json!({"note": "Immer Du statt Sie"}));
    assert!(
        m.starts_with("Gemerkt (")
            && m.ends_with("Gilt ab jetzt für jedes Deck; sag dem Nutzer kurz Bescheid.")
    );
    assert_eq!(
        text(&t, "remember", json!({"note": "Immer Du statt Sie"})),
        "Steht schon im Hausstil."
    );
    assert_eq!(t.ctx().store.house_style(), "- Immer Du statt Sie");
    assert_eq!(
        text(&t, "find_images", json!({})),
        "Keine lokalen Bilder. Für Fotos aus dem Netz eine englische query angeben."
    );
    // Export: erst „läuft noch“, dann dasselbe Werkzeug noch einmal → Ergebnis
    text(&t, "create_deck", json!({"title": "Export"}));
    text(
        &t,
        "add_slides",
        json!({"slides": [{"layout": "cover", "content": {"title": "Ergebnis"}}]}),
    );
    t.job_wait = Duration::ZERO;
    assert_eq!(
        text(&t, "export_deck", json!({"format": "pptx"})),
        "Export läuft noch (40 %). Rufe dasselbe Tool gleich noch einmal mit denselben Eingaben auf; die Arbeit läuft im Hintergrund weiter."
    );
    t.job_wait = Duration::from_secs(5);
    assert_eq!(
        text(&t, "export_deck", json!({"format": "pptx"})),
        "Exportiert (pptx):\n/x/deck.pptx"
    );
    let md = text(&t, "export_deck", json!({"format": "md"}));
    assert!(
        md.starts_with("Exportiert (md):\n") && md.ends_with("/out/export.md"),
        "{md}"
    );
    assert!(
        t.call("export_deck", json!({"format": "mp4"}))
            .unwrap_err()
            .starts_with("export_deck ist in dieser Deckwerk-Version noch nicht verfügbar")
    );
}
