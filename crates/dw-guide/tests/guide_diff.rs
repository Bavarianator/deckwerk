//! Differenztest gegen guide-modules.ts: Fixture aus tests/gen/gen-guide.ts mit demselben Datenordner (Hausstil, ein Deck).

use dw_guide::{
    Route, core_prompt, full_prompt, guide_index, guide_parts, leitfaden, modules, read_guide,
};
use dw_store::{Edition, Store};
use serde_json::{Value, json};

fn store() -> Store {
    let base = std::env::var_os("CARGO_TARGET_TMPDIR").map_or_else(std::env::temp_dir, Into::into);
    let dir = base.join(format!("dw-guide-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("Vortrag")).unwrap();
    std::fs::write(
        dir.join("hausstil.md"),
        "- Immer Du statt Sie\n- Kurze Sätze\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("Vortrag/deck.json"),
        json!({"title": "Test  Vortrag", "theme": {"id": "keynote"}, "slides": []}).to_string(),
    )
    .unwrap();
    Store::at(Edition::Deckwerk, &dir).unwrap()
}

fn fixture() -> Value {
    let f = if dw_tools::PRO {
        "guide-pro.json"
    } else {
        "guide-deckwerk.json"
    };
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(f);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

// bei Abweichung die Stelle zeigen statt 100 KB Text
fn same(name: &str, got: &str, want: &str) {
    if got == want {
        return;
    }
    let i = got
        .bytes()
        .zip(want.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    let ctx = |s: &str| {
        s.get(i.saturating_sub(80)..(i + 120).min(s.len()))
            .unwrap_or("")
            .to_string()
    };
    panic!(
        "{name} weicht ab bei Byte {i} (Länge {} statt {}):\nRust: {:?}\nTS:   {:?}",
        got.len(),
        want.len(),
        ctx(got),
        ctx(want)
    );
}

#[test]
fn gleich_wie_ts() {
    let (s, fx) = (store(), fixture());
    same(
        "core",
        &core_prompt(&s, false),
        fx["core"].as_str().unwrap(),
    );
    same(
        "video",
        &core_prompt(&s, true),
        fx["video"].as_str().unwrap(),
    );
    let mods = modules(&s);
    same("index", &guide_index(&mods), fx["index"].as_str().unwrap());
    same("full", &full_prompt(&s), fx["full"].as_str().unwrap());
    let route = Route {
        modules: vec!["stil".into(), "layout:chart".into(), "gibt-es-nicht".into()],
        video: false,
    };
    same(
        "leitfaden",
        &leitfaden(&s, Some(&route)),
        fx["leitfaden"].as_str().unwrap(),
    );
    assert_eq!(
        guide_parts(&s, 20000).len() as u64,
        fx["parts"].as_u64().unwrap()
    );
    let ids: Vec<Value> = mods
        .iter()
        .map(|m| json!({"id": m.id, "title": m.title, "kurz": m.kurz, "always": m.always}))
        .collect();
    assert_eq!(Value::Array(ids), fx["modules"]);
}

#[test]
fn read_guide_module_teile_index() {
    let s = store();
    let t = read_guide(&s, &json!({"topic": "video", "module": ["nix"]})).unwrap();
    assert!(t.starts_with("## 11. Video"), "{}", &t[..40]);
    assert!(t.ends_with("Unbekannte Module: nix (Index: read_guide ohne Eingabe)"));
    let p = read_guide(&s, &json!({"part": 99})).unwrap();
    let n = guide_parts(&s, 20000).len();
    assert!(p.starts_with(&format!("Teil {n} von {n}\n\n")));
    assert!(read_guide(&s, &json!({})).unwrap().starts_with("## Index"));
    assert_eq!(leitfaden(&s, None), "");
}
