use dw_model::{El, TextEl};
use dw_scene::{FontStore, render_slide, samples};

fn fonts() -> FontStore {
    FontStore::from_dir(&FontStore::default_dir()).expect("Schriften")
}

fn render(
    layout: &str,
    variant: &str,
    sample: &str,
    fonts: &mut FontStore,
) -> (dw_model::Scene, dw_model::Measured) {
    let content = samples::samples(layout)
        .unwrap()
        .into_iter()
        .find(|(n, _)| *n == sample)
        .unwrap()
        .1;
    render_slide(&samples::deck(layout, variant, content), 0, fonts).unwrap()
}

fn text<'a>(m: &'a dw_model::Measured, slot: &str) -> &'a TextEl {
    m.els
        .iter()
        .find_map(|e| match e {
            El::Text(t) if t.base.slot == slot => Some(t),
            _ => None,
        })
        .unwrap_or_else(|| panic!("kein Text {slot}"))
}

#[test]
fn autofit_steps() {
    let mut f = fonts();
    let (_, m) = render("bullets", "list", "max", &mut f);
    assert!(
        m.fit.head + m.fit.body > 0,
        "max muss verkleinern: {:?}",
        m.fit
    );
    let (_, m) = render("cover", "left", "typ", &mut f);
    assert!(
        m.fit.ok && m.fit.head == 0 && m.fit.body == 0 && m.fit.overflow.is_empty(),
        "{:?}",
        m.fit
    );
}

#[test]
fn line_counts() {
    let mut f = fonts();
    let (_, m) = render("cover", "left", "typ", &mut f);
    // „Wie wir den Umsatz in 18 Monaten verdoppeln“ in 76 px auf 1000 px Breite: zwei Zeilen
    let title = text(&m, "title");
    assert_eq!(title.size_px, 76.);
    assert_eq!(title.lines, 2);
    assert_eq!(
        title
            .runs
            .iter()
            .filter(|r| r.break_after == Some(true))
            .count(),
        1
    );
    assert!(
        (title.base.bbox.h - 2. * 76. * 1.06).abs() < 0.5,
        "{:?}",
        title.base.bbox
    );
    assert_eq!(text(&m, "meta").lines, 1);
    // Box links am Satzspiegel
    assert_eq!(title.base.bbox.x, 72.);
}

#[test]
fn deterministic() {
    let mut f = fonts();
    let a = render("two-column", "rule", "max", &mut f);
    let mut g = fonts();
    let b = render("two-column", "rule", "max", &mut g);
    assert_eq!(
        serde_json::to_string(&a.0).unwrap(),
        serde_json::to_string(&b.0).unwrap()
    );
    assert_eq!(
        serde_json::to_string(&a.1).unwrap(),
        serde_json::to_string(&b.1).unwrap()
    );
}

#[test]
fn glyphs_on_slide() {
    let mut f = fonts();
    let (scene, m) = render("bullets", "list", "typ", &mut f);
    let runs: Vec<_> = scene
        .nodes
        .iter()
        .filter_map(|n| match n {
            dw_model::Node::Glyphs { run, meta } => Some((run, meta)),
            _ => None,
        })
        .collect();
    assert!(!runs.is_empty());
    for (run, meta) in &runs {
        assert!(meta.export && !run.font.data.is_empty() && run.font.family == "IBM Plex Sans");
        for g in &run.glyphs {
            assert!(
                g.x >= 70. && g.x < 1210. && g.y > 60. && g.y < 700.,
                "{g:?}"
            );
        }
    }
    // Fußzeile „1 / 1“ rechts unten
    let page = text(&m, "_footer.page");
    assert!(page.base.bbox.x + page.base.bbox.w <= 1208.01 && page.base.bbox.y > 670.);
    // fett aus **…** und has-sub
    assert!(text(&m, "items.0.text").runs[0].bold);
}

#[test]
fn empty_text_has_no_el() {
    let mut f = fonts();
    let deck = samples::deck("cover", "left", serde_json::json!({ "title": "" }));
    let (_, m) = render_slide(&deck, 0, &mut f).unwrap();
    assert!(!m.els.iter().any(|e| e.base().slot == "title"));
}

#[test]
fn baselines_like_chromium() {
    let mut f = fonts();
    let (scene, m) = render("bullets", "list", "typ", &mut f);
    let title = text(&m, "title");
    assert_eq!(title.lines, 2);
    let mut ys: Vec<f32> = scene
        .nodes
        .iter()
        .filter_map(|n| match n {
            dw_model::Node::Glyphs { run, meta } if meta.slot.as_deref() == Some("title") => {
                Some(run.glyphs[0].y)
            }
            _ => None,
        })
        .collect();
    ys.dedup();
    // 42 px × 1.14 = 47.88 Zeilenabstand; Grundlinie = gerundeter Aufstieg 43 + (47.88 − 55) / 2
    assert!((ys[1] - ys[0] - 47.88).abs() < 0.01, "{ys:?}");
    assert!(
        (ys[0] - title.base.bbox.y as f32 - 39.44).abs() < 0.02,
        "{ys:?}"
    );
    assert!((title.base.bbox.h - 2. * 47.88).abs() < 0.01);
}

#[test]
fn hanging_quote() {
    let mut f = fonts();
    let deck = samples::deck(
        "cover",
        "left",
        serde_json::json!({ "title": "„Kunden bleiben“" }),
    );
    let (scene, m) = render_slide(&deck, 0, &mut f).unwrap();
    let x0 = scene
        .nodes
        .iter()
        .find_map(|n| match n {
            dw_model::Node::Glyphs { run, meta } if meta.slot.as_deref() == Some("title") => {
                Some(run.glyphs[0].x)
            }
            _ => None,
        })
        .unwrap();
    assert!((x0 - (72. - 0.4 * 76.)).abs() < 0.5, "{x0}");
    assert_eq!(text(&m, "title").base.bbox.x, 72.);
}
