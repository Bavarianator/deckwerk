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

fn deck_with(
    layout: &str,
    variant: &str,
    sample: &str,
    edit: impl Fn(&mut serde_json::Value),
) -> dw_model::Deck {
    let content = samples::samples(layout)
        .unwrap()
        .into_iter()
        .find(|(n, _)| *n == sample)
        .unwrap()
        .1;
    let mut v = serde_json::to_value(samples::deck(layout, variant, content)).unwrap();
    edit(&mut v);
    serde_json::from_value(v).unwrap()
}

#[test]
fn all_themes_render() {
    let mut f = fonts();
    let ids: Vec<&str> = dw_theme::themes().iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids.len(), 20);
    for id in ids {
        for (layout, variants, _) in dw_scene::LAYOUTS {
            for variant in *variants {
                let deck = deck_with(layout, variant, "typ", |v| v["theme"]["id"] = id.into());
                let (scene, m) = render_slide(&deck, 0, &mut f)
                    .unwrap_or_else(|e| panic!("{id} {layout}-{variant}: {e}"));
                assert!(m.fit.ok, "{id} {layout}-{variant}: {:?}", m.fit);
                assert!(!scene.nodes.is_empty());
                // Text in der Theme-Schrift gesetzt (keine leeren Glyphenläufe)
                let lines = m.els.iter().find_map(|e| match e {
                    El::Text(t) if t.base.slot == "title" => Some(t.lines),
                    _ => None,
                });
                assert!(
                    lines.is_some_and(|n| n >= 1),
                    "{id} {layout}-{variant}: kein Titel"
                );
            }
        }
    }
}

#[test]
fn theme_levers() {
    let mut f = fonts();
    // solid (legacy): Karten mit Fläche, Punkte als Ellipse
    let deck = deck_with("two-column", "equal", "typ", |v| {
        v["theme"]["id"] = "corporate".into()
    });
    let (_, m) = render_slide(&deck, 0, &mut f).unwrap();
    let card = m.els.iter().find_map(|e| match e {
        El::Box(b) if b.base.slot == "_card.left" => Some(b),
        _ => None,
    });
    let card = card.expect("Karte");
    assert!(card.fill.is_some(), "solid: Karte mit Fläche");
    assert!(m.els.iter().any(|e| matches!(e, El::Box(b) if b.ellipse)));
    // beratung (line): Karten ohne Fläche
    let (_, m) = render("two-column", "equal", "typ", &mut f);
    assert!(
        m.els.iter().all(
            |e| !matches!(e, El::Box(b) if b.fill.is_some() && b.base.slot.starts_with("_card"))
        )
    );
}

#[test]
fn frame_split() {
    let mut f = fonts();
    let deck = deck_with("bullets", "list", "typ", |v| {
        v["slides"][0]["frame"] = "split".into()
    });
    let (_, m) = render_slide(&deck, 0, &mut f).unwrap();
    assert!(m.fit.ok, "{:?}", m.fit);
    let title = text(&m, "title");
    // Titel auf der Akzentfläche links (72 px Rand, 492 px breit), Text in onAccent
    assert_eq!(title.base.bbox.x, 72.);
    assert!(title.base.bbox.x + title.base.bbox.w <= 492. - 48. + 0.01);
    let th = dw_theme::resolve_theme(&deck.theme, None);
    assert_eq!(title.bg, th.c.fill.unwrap().to_hex().to_uppercase());
    // Inhalt rechts ab 560 px, Fußzeile ebenso
    assert!(text(&m, "items.0.text").base.bbox.x >= 560.);
    assert!(text(&m, "_footer.page").base.bbox.x > 560.);
}

#[test]
fn frame_band() {
    let mut f = fonts();
    let deck = deck_with("two-column", "rule", "typ", |v| {
        v["slides"][0]["frame"] = "band".into()
    });
    let (scene, m) = render_slide(&deck, 0, &mut f).unwrap();
    assert!(m.fit.ok, "{:?}", m.fit);
    let title = text(&m, "title");
    // Band oben über die volle Breite: Titel 48 px unter der Oberkante, Fläche im Hintergrund
    assert!(
        (title.base.bbox.y - 48.).abs() < 0.01,
        "{:?}",
        title.base.bbox
    );
    let th = dw_theme::resolve_theme(&deck.theme, None);
    assert_eq!(title.bg, th.c.fill.unwrap().to_hex().to_uppercase());
    assert!(scene.nodes.iter().any(|n| matches!(n, dw_model::Node::Rect { rect, meta, .. } if !meta.export && rect.x0 == 0. && rect.y0 == 0. && rect.x1 == 1280.)));
    // band ist für bullets erlaubt, für cover nicht: dort bleibt top
    let deck = deck_with("cover", "left", "typ", |v| {
        v["slides"][0]["frame"] = "band".into()
    });
    let (_, m) = render_slide(&deck, 0, &mut f).unwrap();
    assert_eq!(text(&m, "title").base.bbox.x, 72.);
}

#[test]
fn frame_center() {
    let mut f = fonts();
    let deck = deck_with("bullets", "list", "typ", |v| {
        v["slides"][0]["frame"] = "center".into()
    });
    let (_, m) = render_slide(&deck, 0, &mut f).unwrap();
    let title = text(&m, "title");
    let mid = title.base.bbox.x + title.base.bbox.w / 2.;
    assert!((mid - 640.).abs() < 1., "{:?}", title.base.bbox);
    assert_eq!(title.align, dw_model::Align::Center);
}

#[test]
fn formats() {
    let mut f = fonts();
    // Story 720×1280 (social, fmt-narrow): Spalten untereinander, Schrift größer
    let deck = deck_with("two-column", "rule", "typ", |v| {
        v["size"] = serde_json::json!({ "w": 720, "h": 1280 })
    });
    let (_, m) = render_slide(&deck, 0, &mut f).unwrap();
    assert!(m.fit.ok, "{:?}", m.fit);
    let (l, r) = (text(&m, "left.heading"), text(&m, "right.heading"));
    assert!(
        r.base.bbox.y > l.base.bbox.y + 50.,
        "gestapelt: {:?} {:?}",
        l.base.bbox,
        r.base.bbox
    );
    assert_eq!(text(&m, "title").size_px, 40.); // 42 × 720/750
    // split wird im Hochformat zum Band oben
    let deck = deck_with("bullets", "list", "typ", |v| {
        v["size"] = serde_json::json!({ "w": 1080, "h": 1350 });
        v["slides"][0]["frame"] = "split".into();
    });
    let (_, m) = render_slide(&deck, 0, &mut f).unwrap();
    let title = text(&m, "title");
    assert!(
        title.base.bbox.y < 100. && title.base.bbox.w > 600.,
        "{:?}",
        title.base.bbox
    );
}

#[test]
fn wrap_lines_text() {
    let mut f = fonts();
    let deck = samples::deck(
        "cover",
        "left",
        serde_json::json!({ "title": "Wie wir den Umsatz in 18 Monaten verdoppeln" }),
    );
    let (_, _, lines) = dw_scene::render_slide_lines(&deck, 0, &mut f).unwrap();
    let title = lines.iter().find(|l| l.slot == "title").unwrap();
    // balance: zwei gleich lange Zeilen statt „… in 18 Monaten“ / „verdoppeln“
    assert_eq!(title.lines.len(), 2);
    assert_eq!(
        title.lines.join(" "),
        "Wie wir den Umsatz in 18 Monaten verdoppeln"
    );
}

#[test]
fn signature_and_decor() {
    let mut f = fonts();
    // jedes Theme rendert Cover mit Dekor/Signatur ohne Exportknoten im Hintergrund
    for t in dw_theme::themes() {
        let deck = deck_with("cover", "left", "typ", |v| {
            v["theme"]["id"] = t.id.as_str().into()
        });
        let (scene, _) = render_slide(&deck, 0, &mut f).unwrap();
        let bg_nodes = scene.nodes.iter().filter(|n| !n.meta().export).count();
        if t.decor != dw_theme::Decor::None {
            assert!(bg_nodes > 0, "{}: Dekor fehlt", t.id);
        }
    }
}
