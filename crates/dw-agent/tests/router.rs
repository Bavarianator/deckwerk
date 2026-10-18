//! Fälle aus scripts/check-router.ts: Antwortprüfung und Regel-Fallback (ohne LLM)
use dw_agent::Effort;
use dw_agent::router::{Input, Routed, route, rule_route};
use dw_model::Profile;
use dw_store::{Edition, Store};
use serde_json::{Value, json};

fn mods() -> Vec<dw_guide::Module> {
    let d = std::env::temp_dir().join(format!("dw-router-{}", std::process::id()));
    dw_guide::modules(&Store::at(Edition::Deckwerk, &d).unwrap())
}

fn input<'a>(text: &'a str, layouts: &'a [String], has_deck: bool, profile: Profile) -> Input<'a> {
    Input { text, profile, layouts_in_deck: layouts, has_deck, podcast: false }
}

fn rr(text: &str) -> Vec<String> {
    rule_route(&input(text, &[], false, Profile::Slides)).route.modules
}

#[test]
fn router() {
    let mods = mods();
    let dl: Vec<String> = ["kpi-grid", "chart", "kpi-grid"].map(String::from).to_vec();
    let deck = input("Animationen ruhiger machen", &dl, true, Profile::Slides);
    let neu = input("Pitch für unser Start-up, 10 Folien", &[], false, Profile::Slides);
    let ok = |v: Value| Ok::<_, String>(v);

    // unbekannte IDs und Kernmodule fallen weg, Deck-Layouts und Gerüst kommen dazu, ohne auto kein Modell
    let r = route(&deck, &mods, false, "haiku", ok(json!({"modules": ["animation", "katalog-animationen", "gibts-nicht", "grundregeln", 42], "reason": "Bewegung"})));
    assert_eq!((r.source, r.reason.as_str(), r.model, r.effort), ("haiku", "Bewegung", None, None));
    assert_eq!(r.route.modules, ["animation", "katalog-animationen", "geruest", "geruest-praesentation", "layout:kpi-grid", "layout:chart"]);

    // auto: opus/sonnet mit effort; ungültiges oder Prototyp-Modell → keins
    let r = route(&neu, &mods, true, "haiku", ok(json!({"modules": ["storyline"], "model": "opus", "effort": "high", "reason": "neu"})));
    assert_eq!((r.model, r.effort), (Some("opus"), Some(Effort::High)));
    assert!(r.route.modules.contains(&"geruest-praesentation".into()));
    let r = route(&deck, &mods, true, "haiku", ok(json!({"modules": ["animation"], "model": "sonnet", "effort": "low", "reason": "k"})));
    assert_eq!((r.model, r.effort), (Some("sonnet"), Some(Effort::Low)));
    for m in ["gpt", "constructor", "__proto__", "haiku"] {
        let r = route(&deck, &mods, true, "haiku", ok(json!({"modules": ["animation"], "model": m, "effort": "max", "reason": "?"})));
        assert_eq!((r.model, r.effort, r.source), (None, None, "haiku"), "{m}");
    }
    let r = route(&deck, &mods, false, "haiku", ok(json!({"modules": ["animation"], "model": "opus", "reason": "x"})));
    assert_eq!(r.model, None, "Modell nur bei auto");
    // Codex/Vibe: kein Auto-Modell, auch wenn die Antwort eines nennt (gespeicherte codex:/vibe:-Wahl bleibt)
    for src in ["codex", "vibe"] {
        let r = route(&deck, &mods, true, src, ok(json!({"modules": ["animation"], "model": "opus", "reason": "x"})));
        assert_eq!((r.source, r.model), (src, None));
    }

    // Visitenkarte bekommt ihr Gerüst
    let r = route(&input("Visitenkarte", &[], false, Profile::Doc), &mods, false, "haiku", ok(json!({"modules": ["layout:business-card"], "reason": "x"})));
    assert!(r.route.modules.contains(&"geruest-visitenkarte".into()) && !r.route.modules.contains(&"geruest-a4".into()));

    // Fehler → Regel-Router mit „Fallback: …“
    let fb = |a: Result<Value, String>, why: &str| {
        let f: Routed = route(&deck, &mods, false, "haiku", a);
        assert_eq!(f.source, "regel");
        assert_eq!(f.reason, format!("Fallback: {why}"));
        assert!(f.route.modules.contains(&"animation".into()) && f.route.modules.contains(&"layout:chart".into()));
    };
    fb(Err("nicht angemeldet".into()), "nicht angemeldet");
    fb(ok(json!({"modules": ["gibts-nicht"], "reason": "x"})), "keine bekannten Module");
    fb(ok(json!({"reason": "x"})), "Antwort ohne modules");

    // reiner Video-Auftrag ohne Gerüst; mit Gerüst (neue Präsentation) nicht
    let short = input("Schneide mein Video zu einem Short", &[], false, Profile::Slides);
    let r = route(&short, &mods, false, "vibe", ok(json!({"modules": ["video", "layout:clip"], "reason": "Video"})));
    assert_eq!((r.source, r.route.modules.clone(), r.route.video), ("vibe", vec!["video".to_string(), "layout:clip".into()], true));
    assert!(!route(&neu, &mods, false, "haiku", ok(json!({"modules": ["video", "layout:clip"], "reason": "x"}))).route.video);

    // Stream-Paket und Regeln
    let v = rr("Schneide mein OBS Video");
    assert!(v.contains(&"video".into()) && !v.contains(&"geruest-stream".into()));
    assert!(!rr("Instagram Thumbnail für Reel").contains(&"geruest-stream".into()));
    assert!(!rr("Präsentation mit Panel-Diskussion").contains(&"geruest-stream".into()));
    if dw_tools::PRO {
        assert!(rr("Starting Soon und BRB für meinen Twitch-Stream").contains(&"geruest-stream".into()));
        assert!(rr("Projektplan als Gantt für den Umzug").contains(&"layout:gantt".into()));
    }
    // „Briefing“ ist kein Brief (Lookahead im TS)
    assert!(!rr("Briefing für den Vortrag").contains(&"geruest-a4".into()));
    assert!(rr("Brief an die Kunden").contains(&"geruest-a4".into()));
}
