// Fälle aus scripts/check-merge3.ts
use super::*;
use serde_json::json;

const DIR: &str = "/home/anna/Gemeinsam/Pitch Ä";

// wie pathToFileURL: alles außer unreservierten Zeichen und / prozentkodiert
fn url(abs: &str) -> String {
    let enc: String = abs.bytes().map(|b| if b.is_ascii_alphanumeric() || b"/._~:-".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    format!("asset://local{enc}")
}
fn slide(id: &str, content: Value) -> Value {
    json!({ "id": id, "layout": "statement", "content": content })
}
fn st(id: &str) -> Value {
    slide(id, json!({ "title": id }))
}
fn with(mut s: Value, extra: Value) -> Value {
    s.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    s
}
fn deck(slides: &[&Value]) -> Value {
    json!({ "title": "Pitch", "theme": { "id": "beratung" }, "transition": "fade", "mode": "click", "slides": slides })
}
fn ids(d: &Value) -> Vec<&str> {
    d["slides"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect()
}
fn m(b: &Value, l: &Value, t: &Value) -> (Value, usize) {
    merge_deck(b, l, t, DIR)
}
fn base() -> (Value, Value, Value) {
    (slide("a", json!({ "title": "A", "text": "eins", "bullets": ["x", "y"] })), st("b"), st("c"))
}
fn retitle(s: &Value, k: &str, v: &str) -> Value {
    let mut s = s.clone();
    s["content"][k] = json!(v);
    s
}

#[test]
fn portable_path_faelle() {
    assert_eq!(portable_path(&url(&format!("{DIR}/assets/foto ü.png")), DIR), "assets/foto ü.png");
    let fremd = portable_path(&url("/home/anna/Deckwerk/assets/foto ü.png"), DIR);
    let (h, n) = fremd.strip_prefix("assets/").unwrap().split_once('-').unwrap();
    assert!(h.len() == 8 && h.chars().all(|c| c.is_ascii_hexdigit()) && n == "foto ü.png", "{fremd}");
    assert_ne!(fremd, portable_path(&url("/home/bert/Deckwerk/assets/foto ü.png"), DIR));
    assert_ne!(portable_path(&url(&format!("{DIR}/assets/sub/x.png")), DIR), "assets/sub/x.png");
    for v in ["assets/x.png", "data:image/png;base64,AAAA", "Titel", "", "https://x.de/a.png"] {
        assert_eq!(portable_path(v, DIR), v);
    }
    assert_eq!(portable_path(&url("/C:/Daten/Pitch/assets/a.png"), "C:\\Daten\\Pitch"), "assets/a.png");
    assert_eq!(fnv1a(""), "811c9dc5");
}

#[test]
fn portable_deck_faelle() {
    let s = with(
        slide("a", json!({ "title": "A", "image": { "src": url(&format!("{DIR}/assets/f.jpg")) } })),
        json!({ "bg": { "image": url("/tmp/hg.png") }, "items": [{ "id": "i", "kind": "video", "x": 0, "y": 0, "w": 1, "h": 1, "src": url(&format!("{DIR}/assets/v.mp4")), "poster": url(&format!("{DIR}/assets/v.jpg")) }] }),
    );
    let mut d = deck(&[&s]);
    d["theme"] = json!({ "id": "x", "brand": { "primary": "#000000", "logo": url(&format!("{DIR}/assets/logo.svg")) }, "customFont": { "family": "F", "regular": url(&format!("{DIR}/assets/f.ttf")) } });
    let p = portable_deck(&d, DIR);
    let s = &p["slides"][0];
    assert_eq!(s["content"]["image"]["src"], "assets/f.jpg");
    assert!(s["bg"]["image"].as_str().unwrap().ends_with("-hg.png"));
    assert_eq!([&s["items"][0]["src"], &s["items"][0]["poster"], &p["theme"]["brand"]["logo"], &p["theme"]["customFont"]["regular"]], ["assets/v.mp4", "assets/v.jpg", "assets/logo.svg", "assets/f.ttf"]);
}

#[test]
fn canon_json_faelle() {
    let c = |v: Value| canon_json(Some(&v), DIR);
    assert_eq!(c(json!({ "b": 1, "a": [1, { "y": 2, "x": "z" }] })), c(json!({ "a": [1, { "x": "z", "y": 2 }], "b": 1 })));
    assert_ne!(c(json!({ "a": 1 })), c(json!({ "a": "1" })));
    assert_eq!(c(json!({ "src": url(&format!("{DIR}/assets/x.png")) })), c(json!({ "src": "assets/x.png" })));
}

#[test]
fn verschiedene_folien_und_felder() {
    let (a, b, c) = base();
    let bd = deck(&[&a, &b, &c]);
    let r = m(&bd, &deck(&[&retitle(&a, "title", "A neu"), &b, &c]), &deck(&[&a, &b, &retitle(&c, "title", "C neu")]));
    assert_eq!((r.0["slides"][0]["content"]["title"].as_str(), r.0["slides"][2]["content"]["title"].as_str(), r.1), (Some("A neu"), Some("C neu"), 0));

    let l = deck(&[&retitle(&a, "title", "mein Titel"), &b, &c]);
    let r = m(&bd, &l, &deck(&[&retitle(&a, "text", "fremder Text"), &b, &c]));
    assert_eq!((&r.0["slides"][0]["content"]["title"], &r.0["slides"][0]["content"]["text"], r.1), (&json!("mein Titel"), &json!("fremder Text"), 0));
    let t2 = deck(&[&retitle(&a, "title", "fremder Titel"), &b, &c]);
    let r2 = m(&bd, &l, &t2);
    assert_eq!((&r2.0["slides"][0]["content"]["title"], r2.1), (&json!("mein Titel"), 1));
    let mut pfade = vec![];
    merge3(&bd, &l, &t2, "", &mut |p| pfade.push(p.to_string()));
    assert_eq!(pfade, ["/slides/a/content/title"]);
}

#[test]
fn einfuegen_loeschen() {
    let (a, b, c) = base();
    let bd = deck(&[&a, &b, &c]);
    let x = st("x");
    assert_eq!(ids(&m(&bd, &bd, &deck(&[&a, &x, &b, &c])).0), ["a", "x", "b", "c"]);
    assert_eq!(ids(&m(&bd, &deck(&[&a, &c]), &deck(&[&x, &a, &b, &c])).0), ["x", "a", "c"]);
    assert_eq!(ids(&m(&bd, &deck(&[&a, &c]), &deck(&[&a, &c])).0), ["a", "c"]);
    assert_eq!(ids(&m(&bd, &bd, &deck(&[&a, &c])).0), ["a", "c"]);
    let geaendert = deck(&[&a, &st_t("b", "B neu"), &c]);
    let r1 = m(&bd, &deck(&[&a, &c]), &geaendert);
    assert_eq!((ids(&r1.0), r1.1), (vec!["a", "c"], 1));
    let r2 = m(&bd, &geaendert, &deck(&[&a, &c]));
    assert_eq!((ids(&r2.0), &r2.0["slides"][1]["content"]["title"], r2.1), (vec!["a", "b", "c"], &json!("B neu"), 1));
}

fn st_t(id: &str, title: &str) -> Value {
    slide(id, json!({ "title": title }))
}

#[test]
fn reihenfolge() {
    let (a, b, c) = base();
    let bd = deck(&[&a, &b, &c]);
    let bn = st_t("b", "B neu");
    let r = m(&bd, &deck(&[&a, &bn, &c]), &deck(&[&c, &a, &b])).0;
    assert_eq!(ids(&r), ["c", "a", "b"]);
    assert_eq!(r["slides"][2]["content"]["title"], "B neu");
    assert_eq!(ids(&m(&bd, &deck(&[&b, &a, &c]), &deck(&[&a, &b, &st_t("c", "C neu")])).0), ["b", "a", "c"]);
    assert_eq!(ids(&m(&bd, &deck(&[&b, &a, &c]), &deck(&[&c, &b, &a])).0), ["b", "a", "c"]);
    assert_eq!(ids(&m(&bd, &deck(&[&a, &b, &c, &st("m")]), &deck(&[&c, &a, &b])).0), ["c", "m", "a", "b"]);
    assert_eq!(ids(&m(&bd, &deck(&[&b, &a, &c]), &deck(&[&a, &b, &st("t"), &c])).0), ["b", "t", "a", "c"]);
}

#[test]
fn items_verschoben_und_geaendert() {
    let it = json!({ "id": "i1", "kind": "text", "x": 10, "y": 10, "w": 100, "h": 20, "text": "Hallo" });
    let i2 = with(it.clone(), json!({ "id": "i2" }));
    let mk = |first: Value| deck(&[&with(st_t("a", "A"), json!({ "items": [first, i2.clone()] }))]);
    let r = m(&mk(it.clone()), &mk(with(it.clone(), json!({ "text": "Servus" }))), &mk(with(it.clone(), json!({ "x": 300, "y": 200 }))));
    assert_eq!((&r.0["slides"][0]["items"][0], r.1), (&with(it, json!({ "text": "Servus", "x": 300, "y": 200 })), 0));
}

#[test]
fn listen_ohne_ids() {
    let (_, b, c) = base();
    let bd = deck(&[&base().0, &b, &c]);
    let a = |bullets: Value| slide("a", json!({ "title": "A", "text": "eins", "bullets": bullets }));
    let r = m(&bd, &deck(&[&a(json!(["x neu", "y"])), &b, &c]), &deck(&[&a(json!(["x", "y neu"])), &b, &c]));
    assert_eq!((&r.0["slides"][0]["content"]["bullets"], r.1), (&json!(["x neu", "y neu"]), 0));
    let r2 = m(&bd, &deck(&[&a(json!(["x", "y", "z"])), &b, &c]), &deck(&[&a(json!(["x", "y neu"])), &b, &c]));
    assert_eq!((&r2.0["slides"][0]["content"]["bullets"], r2.1), (&json!(["x", "y", "z"]), 1));
    assert_eq!(m(&bd, &deck(&[&a(json!(["x", "y"])), &b, &c]), &deck(&[&a(json!(["x"])), &b, &c])).0["slides"][0]["content"]["bullets"], json!(["x"]));
    // doppelte IDs → als Ganzes
    let d = |v: &[i32]| Value::Array(v.iter().map(|x| json!({ "id": "z", "v": x })).collect());
    let mut k = 0;
    assert_eq!(merge3(&d(&[1, 2]), &d(&[1, 3]), &d(&[4, 2]), "", &mut |_| k += 1), d(&[1, 3]));
    assert_eq!(k, 1);
}

#[test]
fn idempotenz() {
    let (a, b, c) = base();
    let bd = deck(&[&a, &b, &c]);
    let l = deck(&[&retitle(&a, "title", "mein"), &st("m"), &c]);
    let t = deck(&[&st("t"), &a, &b, &st_t("c", "C neu")]);
    let r = m(&bd, &l, &t);
    assert_eq!(ids(&r.0), ["t", "a", "m", "c"]);
    assert_eq!(m(&bd, &r.0, &t), (r.0.clone(), 0));
    assert_eq!(merge3(&json!({ "a": 1 }), &json!({ "a": 1 }), &json!({ "a": 1 }), "", &mut |_| {}), json!({ "a": 1 }));
    assert_eq!(merge3(&json!(1), &json!(2), &json!(3), "", &mut |_| {}), json!(2));
}

#[test]
fn bilder_lokal_gleich_kopie() {
    let lokal = url("/home/x/Deckwerk/assets/foto.png");
    let kopie = url(&format!("{DIR}/{}", portable_path(&lokal, DIR)));
    let mit = |src: &str, title: &str| deck(&[&slide("a", json!({ "title": title, "image": { "src": src } }))]);
    let r = m(&mit(&kopie, "A"), &mit(&lokal, "mein"), &mit(&kopie, "A"));
    assert_eq!((r.0["slides"][0]["content"]["image"]["src"].as_str(), r.0["slides"][0]["content"]["title"].as_str(), r.1), (Some(lokal.as_str()), Some("mein"), 0));
    let neu = url(&format!("{DIR}/assets/anders.png"));
    let r2 = m(&mit(&kopie, "A"), &mit(&lokal, "mein"), &mit(&neu, "A"));
    assert_eq!((r2.0["slides"][0]["content"]["image"]["src"].as_str(), r2.1), (Some(neu.as_str()), 0));
}

#[test]
fn rebase_undo() {
    let (a, b, c) = base();
    let bd = deck(&[&a, &b, &c]);
    let s1 = deck(&[&retitle(&a, "title", "mein"), &b, &c]);
    let t = deck(&[&a, &b, &st_t("c", "C fremd")]);
    let r = rebase(&[bd.clone(), s1], &bd, &t, DIR);
    let tt = |d: &Value, i: usize| d["slides"][i]["content"]["title"].as_str().unwrap().to_string();
    assert_eq!([tt(&r[0], 0), tt(&r[0], 2), tt(&r[1], 0), tt(&r[1], 2)], ["A", "C fremd", "mein", "C fremd"]);
}

#[test]
fn sanitize_faelle() {
    let a = with(
        slide("a", json!({ "title": "asset://local/home/besitzer/privat.jpg", "image": { "src": "assets/foto.jpg" }, "logos": [{ "name": "X", "src": "file:///etc/passwd" }, { "name": "Y", "src": "assets/../x.png" }] })),
        json!({ "bg": { "image": "../x.png" }, "items": [{ "id": "i", "kind": "image", "src": "assets/sub/x.png" }, { "id": "j", "kind": "video", "src": "assets/x.exe", "poster": "data:image/png;base64,AAAA" }] }),
    );
    let b = with(slide("b", json!({ "title": "FILE:///etc/hosts", "image": { "src": "ASSET://local/x.png" }, "text": " \nfile:///x", "quote": "Datei: file:///x" })), json!({ "bg": { "image": "https://tracker.example/p.png" } }));
    let mut roh = deck(&[&a, &b]);
    roh["theme"] = json!({ "id": "x", "brand": { "primary": "#000000", "logo": "assets/logo.svg", "logoDark": "/etc/logo.png" }, "customFont": { "family": "F", "regular": "assets/f.ttf", "bold": "assets/f.ttf.sh" } });
    let s = sanitize(&roh).unwrap();
    let (a, b, th) = (&s["slides"][0], &s["slides"][1], &s["theme"]);
    assert_eq!([&a["content"]["title"], &a["content"]["image"]["src"], &a["content"]["logos"][0]["src"], &a["content"]["logos"][1]["src"], &a["bg"]["image"]], ["", "assets/foto.jpg", "", "", ""]);
    assert_eq!([&a["items"][0]["src"], &a["items"][1]["src"], &a["items"][1]["poster"]], ["", "", "data:image/png;base64,AAAA"]);
    assert_eq!([&b["content"]["title"], &b["content"]["image"]["src"], &b["content"]["text"], &b["content"]["quote"], &b["bg"]["image"]], ["", "", "", "Datei: file:///x", ""]);
    assert_eq!([&th["brand"]["logo"], &th["brand"]["logoDark"], &th["customFont"]["regular"], &th["customFont"]["bold"]], ["assets/logo.svg", "", "assets/f.ttf", ""]);
    let p: Value = serde_json::from_str(r#"{"theme":{"id":"x"},"slides":[{"id":"a","content":{"__proto__":{"x":1}}}]}"#).unwrap();
    assert_eq!(sanitize(&p).unwrap()["slides"][0]["content"], json!({}));
    let v = sanitize(&deck(&[&slide("v", json!({ "video": "/home/u/privat.mp4", "parts": [], "overlays": [{ "video": "assets/b.mp4" }, { "video": "C:\\Users\\u\\x.mp4" }], "chart": { "link": { "file": "/home/u/Zahlen.xlsx", "range": "A1:B2" } } }))])).unwrap();
    let c = &v["slides"][0]["content"];
    assert_eq!([&c["video"], &c["overlays"][0]["video"], &c["overlays"][1]["video"], &c["chart"]["link"]["file"]], ["", "assets/b.mp4", "", ""]);
    let rel: Vec<bool> = ["assets/x.png", "assets/..\\..\\x.png", "assets/a\\b.png", "assets/../x.png", "assets/x.exe", "assets/sub/x.png"].map(is_asset_rel).into();
    assert_eq!(rel, [true, false, false, false, false, false]);
    assert!(sanitize(&json!({ "theme": { "id": "x" } })).unwrap_err().contains("deck.json"));
    assert!(sanitize(&json!({ "slides": [] })).unwrap_err().contains("deck.json"));
    assert!(sanitize(&json!({ "theme": { "id": "x" }, "slides": [{ "id": 3 }] })).unwrap_err().contains("Folie"));
    assert!(sanitize(&Value::Null).unwrap_err().contains("deck.json"));
}

#[test]
fn tempo_100_snapshots() {
    let viele: Vec<Value> = (0..60).map(|i| slide(&format!("s{i}"), json!({ "title": format!("T{i}"), "bullets": (0..8).map(|j| format!("Punkt {j}")).collect::<Vec<_>>() }))).collect();
    let vd = deck(&viele.iter().collect::<Vec<_>>());
    let stack: Vec<Value> = (0..100).map(|i| { let mut d = vd.clone(); d["slides"][i % 60]["content"]["title"] = json!(format!("mein {i}")); d }).collect();
    let mut t = vd.clone();
    t["slides"][59]["notes"] = json!("fremd");
    let t0 = std::time::Instant::now();
    let r = rebase(&stack, &vd, &t, DIR);
    let ms = t0.elapsed().as_millis();
    assert!(r.iter().all(|d| d["slides"][59]["notes"] == "fremd"));
    assert!(ms < if cfg!(debug_assertions) { 3000 } else { 500 }, "rebase über 100 Snapshots: {ms} ms"); // TS-Grenze 500 ms gilt für Release
}
