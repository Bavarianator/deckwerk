//! Differenztests gegen die TS-Fassung: Fixtures aus tests/gen/gen-lint.ts, Vergleich exakt (Zahlen als f64).

use std::path::PathBuf;

use dw_lint::theme::{FontInfo, ThemeLintOpts, ThemeSpec, axes_of};
use dw_lint::{FindOpts, Issue, LayoutInfo, LintCtx, LintTheme, Only, SchemaIssue};
use dw_model::{Deck, Measured};
use serde::Deserialize;
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

// Zahlen vereinheitlichen (Rust schreibt 700.0, TS 700); null-Felder fallen weg wie undefined in JSON.stringify
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => serde_json::Number::from_f64(n.as_f64().unwrap()).map_or(Value::Null, Value::Number),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().filter(|(_, x)| !x.is_null()).map(|(k, x)| (k.clone(), norm(x))).collect()),
        x => x.clone(),
    }
}

// {"$ref": n} aus dem Pool der Fixture einsetzen
fn resolve(v: &Value, pool: &Value) -> Value {
    match v {
        Value::Object(o) if o.len() == 1 && o.contains_key("$ref") => resolve(&pool[o["$ref"].as_u64().unwrap() as usize], pool),
        Value::Array(a) => Value::Array(a.iter().map(|x| resolve(x, pool)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), resolve(x, pool))).collect()),
        x => x.clone(),
    }
}

fn from<T: for<'de> Deserialize<'de>>(v: &Value) -> T {
    serde_json::from_value(v.clone()).unwrap()
}

struct Tally {
    what: &'static str,
    ok: usize,
    all: usize,
    fails: Vec<String>,
}

impl Tally {
    fn new(what: &'static str) -> Self {
        Tally { what, ok: 0, all: 0, fails: Vec::new() }
    }
    fn check(&mut self, name: &str, got: &Value, want: &Value) {
        self.all += 1;
        if norm(got) == norm(want) {
            self.ok += 1;
        } else if self.fails.len() < 8 {
            self.fails.push(format!("{name}\n  erwartet {}\n  bekommen {}", norm(want), norm(got)));
        }
    }
    fn done(self) {
        println!("{}: {}/{} identisch", self.what, self.ok, self.all);
        assert!(self.fails.is_empty(), "{}: {} Abweichungen\n{}", self.what, self.all - self.ok, self.fails.join("\n"));
    }
}

#[derive(Deserialize)]
struct Rec {
    layout: String,
    content: Value,
    issues: Vec<SchemaIssue>,
}

fn schema_of(recs: &[Rec]) -> impl Fn(&str, &Value) -> Option<Vec<SchemaIssue>> + '_ {
    move |layout, content| {
        let r = recs.iter().find(|r| r.layout == layout && norm(&r.content) == norm(content));
        Some(r.unwrap_or_else(|| panic!("Schema-Aufruf ohne Mitschnitt: {layout} {content}")).issues.clone())
    }
}

#[test]
fn lint() {
    let f = fixture("lint.json");
    let layouts: Vec<LayoutInfo> = from(&f["layouts"]);
    let mut t = Tally::new("lintDeck");
    for c in f["cases"].as_array().unwrap() {
        let c = &resolve(c, &f["pool"]);
        let deck: Deck = from(&c["deck"]);
        let measured: Vec<Measured> = from(&c["measured"]);
        let recs: Vec<Rec> = from(&c["schema"]);
        let film: Vec<Issue> = from(&c["film"]);
        let schema = schema_of(&recs);
        let film_fn = |_: &Deck, _: &[Measured]| film.clone();
        let ctx = LintCtx { layouts: &layouts, theme: LintTheme { margin: c["margin"].as_str().map(str::to_string) }, schema: &schema, film: Some(&film_fn) };
        let got = dw_lint::lint_deck(&deck, &measured, &ctx);
        t.check(c["name"].as_str().unwrap(), &serde_json::to_value(got).unwrap(), &c["expected"]);
    }
    t.done();
}

#[test]
fn text() {
    let f = fixture("text.json");
    let mut t = Tally::new("typeset");
    for c in f["typeset"].as_array().unwrap() {
        let s = c[0].as_str().unwrap();
        t.check(&format!("{s:?}"), &Value::String(dw_lint::typeset(s)), &c[1]);
    }
    t.done();
    let mut t = Tally::new("klartext");
    for c in f["klartext"].as_array().unwrap() {
        let s = c[0].as_str().unwrap();
        t.check(s, &serde_json::to_value(dw_lint::klartext(s)).unwrap(), &c[1]);
    }
    t.done();
}

#[test]
fn find() {
    let f = fixture("find.json");
    let mut hits = Tally::new("findInDeck");
    let mut rep = Tally::new("replaceInDeck");
    for c in f["cases"].as_array().unwrap() {
        let c = &resolve(c, &f["pool"]);
        let src = &f["examples"][c["deck"].as_str().unwrap()];
        let deck: Deck = from(src);
        let q = c["query"].as_str().unwrap();
        let opts: FindOpts = from(&c["opts"]);
        let name = format!("{} {q:?} {opts:?}", c["deck"]);
        hits.check(&name, &serde_json::to_value(dw_lint::find_in_deck(&deck, q, opts)).unwrap(), &c["hits"]);
        let recs: Vec<Rec> = from(&c["schema"]);
        let only: Option<Only> = from(&c["only"]);
        let schema = schema_of(&recs);
        let (out, skipped) = dw_lint::replace_in_deck(&deck, q, c["replacement"].as_str().unwrap(), opts, only.as_ref(), &schema);
        // erwartet = Ausgangsdeck mit den geänderten Folien aus der Fixture
        let mut want = src.clone();
        if let Some(o) = c["out"].as_object() {
            want["title"] = o["title"].clone();
            for (i, x) in o["slides"].as_object().unwrap() {
                want["slides"][i.parse::<usize>().unwrap()] = x.clone();
            }
        }
        rep.check(&name, &serde_json::json!([out, skipped]), &serde_json::json!([from::<Deck>(&want), c["skipped"]]));
    }
    hits.done();
    rep.done();
}

#[test]
fn merge() {
    let f = fixture("merge.json");
    let mut t = Tally::new("parseCsv");
    for c in f["csv"].as_array().unwrap() {
        let s = c[0].as_str().unwrap();
        t.check(&format!("{s:?}"), &serde_json::to_value(dw_lint::parse_csv(s)).unwrap(), &c[1]);
    }
    t.done();
    let mut t = Tally::new("fillDeck/placeholders");
    for (i, c) in f["fill"].as_array().unwrap().iter().enumerate() {
        let deck: Deck = from(&c["deck"]);
        let row: dw_lint::Row = from(&c["row"]);
        let want = serde_json::json!([from::<Deck>(&c["out"]), c["placeholders"]]);
        t.check(&format!("fill {i}"), &serde_json::json!([dw_lint::fill_deck(&deck, &row), dw_lint::placeholders(&deck)]), &want);
    }
    t.done();
}

#[test]
fn handout() {
    let f = fixture("handout.json");
    let mut t = Tally::new("handout");
    for c in f["cases"].as_array().unwrap() {
        let deck: Deck = from(&c["deck"]);
        t.check(c["name"].as_str().unwrap(), &Value::String(dw_lint::handout(&deck)), &c["md"]);
    }
    t.done();
    let mut t = Tally::new("speakSec/fmtSec");
    for c in f["speak"].as_array().unwrap() {
        let s = dw_lint::speak_sec(c[0].as_str());
        t.check(&format!("{}", c[0]), &serde_json::json!([s, dw_lint::fmt_sec(s)]), &serde_json::json!([c[1], c[2]]));
    }
    t.done();
}

#[test]
fn theme() {
    let f = fixture("theme.json");
    let fonts: Vec<FontInfo> = from(&f["fonts"]);
    let mut t = Tally::new("lintTheme/axesOf");
    for (i, c) in f["cases"].as_array().unwrap().iter().enumerate() {
        let spec: ThemeSpec = from(&c["spec"]);
        let opts: ThemeLintOpts = from(&c["opts"]);
        let got = serde_json::json!([dw_lint::lint_theme(&spec, opts, &fonts), axes_of(&spec)]);
        t.check(&format!("theme {i} {}", c["spec"]), &got, &serde_json::json!([c["issues"], c["axes"]]));
    }
    t.done();
    let mut t = Tally::new("lintLooks");
    for (i, c) in f["looks"].as_array().unwrap().iter().enumerate() {
        let specs: Vec<ThemeSpec> = from(&c["specs"]);
        let axes: Vec<_> = specs.iter().map(axes_of).collect();
        t.check(&format!("looks {i}"), &serde_json::to_value(dw_lint::lint_looks(&axes, &fonts)).unwrap(), &c["issues"]);
    }
    t.done();
}
