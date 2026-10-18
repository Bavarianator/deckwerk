//! Differenztest gegen resolveTheme/withTone in TS (Fixture: tests/gen/resolved.ts) und fs()-Tabelle gegen measure.ts.

use dw_model::{Profile, ThemeRef};
use std::collections::BTreeMap;

use dw_theme::{FontRef, Role, Tokens, Tone, font_factor, fs, resolve_theme, with_tone};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/resolved.json")).unwrap()
}

/// Feldweise: fehlend = false = null, Hexfarben ohne Groß/klein, Zahlen bis 1e-9.
fn diff(path: &str, a: &Value, b: &Value, out: &mut Vec<String>) {
    let empty = |v: &Value| matches!(v, Value::Null | Value::Bool(false));
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                let n = Value::Null;
                diff(
                    &format!("{path}.{k}"),
                    x.get(k).unwrap_or(&n),
                    y.get(k).unwrap_or(&n),
                    out,
                );
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                diff(&format!("{path}[{i}]"), p, q, out);
            }
        }
        (Value::Number(x), Value::Number(y))
            if (x.as_f64().unwrap() - y.as_f64().unwrap()).abs() < 1e-9 => {}
        (Value::String(x), Value::String(y)) if x.starts_with('#') && x.eq_ignore_ascii_case(y) => {
        }
        _ if a == b || (empty(a) && empty(b)) => {}
        _ => out.push(format!("{path}: Rust {a} ≠ TS {b}")),
    }
}

/// Unvollständige Specs: TS trägt undefined weiter, Rust die Werte, mit denen der Renderer dann rechnet.
fn undef(t: &Value) -> Value {
    let mut t = t.clone();
    let o = t.as_object_mut().unwrap();
    for (k, v) in [("name", ""), ("decor", "none")] {
        o.entry(k).or_insert(Value::from(v));
    }
    o.entry("radius").or_insert(Value::from(0.0));
    t
}

#[test]
fn resolve_wie_ts() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap();
    let mut bad = vec![];
    for c in cases {
        let r: ThemeRef = serde_json::from_value(c["ref"].clone()).unwrap();
        let t = resolve_theme(&r, None);
        let mut d = vec![];
        diff(
            "theme",
            &serde_json::to_value(&t).unwrap(),
            &undef(&c["theme"]),
            &mut d,
        );
        diff(
            "accent",
            &serde_json::to_value(with_tone(&t, Tone::Accent)).unwrap(),
            &undef(&c["accent"]),
            &mut d,
        );
        diff(
            "invert",
            &serde_json::to_value(with_tone(&t, Tone::Invert)).unwrap(),
            &undef(&c["invert"]),
            &mut d,
        );
        if !d.is_empty() {
            bad.push(format!("{}:\n  {}", c["name"], d.join("\n  ")));
        }
    }
    println!(
        "{}/{} Fälle identisch",
        cases.len() - bad.len(),
        cases.len()
    );
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn fs_wie_measure() {
    let fx = fixture();
    for f in fx["fs"].as_array().unwrap() {
        let profile: Profile = serde_json::from_value(f["profile"].clone()).unwrap();
        let k = font_factor(profile, f["w"].as_f64().unwrap());
        assert!((k - f["k"].as_f64().unwrap()).abs() < 1e-12);
        let rows = f["rows"].as_object().unwrap();
        assert_eq!(rows.len(), Role::ALL.len());
        for (name, tab) in rows {
            let role = Role::from_name(name).unwrap();
            for (h, row) in tab.as_array().unwrap().iter().enumerate() {
                for (b, want) in row.as_array().unwrap().iter().enumerate() {
                    assert_eq!(
                        fs(role, h, b, k),
                        want.as_f64().unwrap(),
                        "{name} {profile:?} {} h{h} b{b}",
                        f["w"]
                    );
                }
            }
        }
    }
}

/// themeVars in slide.tsx: dieselben Variablen und Schreibweisen aus Tokens.
fn vars(k: &Tokens) -> BTreeMap<String, String> {
    let mut v = BTreeMap::new();
    let mut put = |key: &str, val: String| {
        v.insert(format!("--{key}"), val);
    };
    let fam = |f: &FontRef| {
        f.families()
            .iter()
            .map(|n| format!("'{n}'"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    for (key, c) in [
        ("bg", k.bg),
        ("surface", k.surface),
        ("surface2", k.surface2),
        ("text", k.text),
        ("muted", k.muted),
        ("accent", k.accent),
        ("accent2", k.accent2),
        ("on-accent", k.on_accent),
        ("border", k.border),
        ("good", k.good),
        ("bad", k.bad),
        ("accent-tint", k.accent_tint),
        ("fill", k.fill),
        ("on-accent-soft", k.on_accent_soft),
    ] {
        put(key, c.to_hex());
    }
    put("font-head", fam(&k.font_head));
    put("font-body", fam(&k.font_body));
    if let Some(f) = &k.font_label {
        put("font-label", fam(f));
    }
    put("head-weight", k.head_weight.to_string());
    put("head-tracking", format!("{}em", k.head_tracking));
    put("radius", format!("{}px", k.radius));
    put("head-scale", k.head_scale.to_string());
    put("lh", k.lh.to_string());
    put("lh-head", k.lh_head.to_string());
    if let Some(m) = k.measure {
        put(
            "measure",
            if m.is_finite() {
                format!("{m}px")
            } else {
                "none".into()
            },
        );
    }
    for (key, m) in [
        ("m-l", k.m_l),
        ("m-r", k.m_r),
        ("m-t", k.m_t),
        ("m-b", k.m_b),
        ("m-foot", k.m_foot),
    ] {
        put(key, format!("{m}px"));
    }
    if let Some(c) = k.rule_c {
        put("rule-c", c.to_hex());
    }
    for (key, px) in [
        ("rule-s", k.rule_s),
        ("rule-w", k.rule_w),
        ("sig-s", k.sig_s),
    ] {
        if let Some(px) = px {
            put(key, format!("{px}px"));
        }
    }
    if let Some(c) = k.sig_c {
        put("sig-c", c.to_hex());
    }
    for r in Role::ALL {
        put(
            &format!("fs-{}", r.name()),
            format!("{}px", fs(r, 0, 0, 1.)),
        );
    }
    v
}

#[test]
fn tokens_wie_theme_vars() {
    let res = fixture();
    let cases: BTreeMap<&str, &Value> = res["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["name"].as_str().unwrap(), &c["ref"]))
        .collect();
    let sets: Vec<Value> = serde_json::from_str(include_str!("fixtures/tokens.json")).unwrap();
    let hexlow = |s: &str| {
        if s.starts_with('#') {
            s.to_lowercase()
        } else {
            s.to_string()
        }
    };
    let mut bad = vec![];
    for set in &sets {
        let name = set["name"].as_str().unwrap();
        let mut t = resolve_theme(&serde_json::from_value(cases[name].clone()).unwrap(), None);
        match set["tone"].as_str().unwrap() {
            "accent" => t = with_tone(&t, Tone::Accent),
            "invert" => t = with_tone(&t, Tone::Invert),
            _ => {}
        }
        let (w, h) = (set["w"].as_f64().unwrap(), set["h"].as_f64().unwrap());
        let got: BTreeMap<String, String> = vars(&Tokens::new(&t, w, h))
            .into_iter()
            .map(|(k, v)| (k, hexlow(&v)))
            .collect();
        // ohne Token setzt themeVars nichts, es gelten die CSS-Fallbacks (slide.css); radius undefined ist ungültiges CSS → 0
        let mut want: BTreeMap<String, String> = [
            ("--lh", "1"),
            ("--lh-head", "1"),
            ("--m-l", "72px"),
            ("--m-r", "72px"),
            ("--m-t", "60px"),
            ("--m-b", "72px"),
            ("--m-foot", "24px"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .into();
        for (k, v) in set["vars"].as_object().unwrap() {
            let v = v.as_str().unwrap();
            want.insert(
                k.clone(),
                hexlow(if v == "undefinedpx" { "0px" } else { v }),
            );
        }
        if got != want {
            let keys: std::collections::BTreeSet<_> = got.keys().chain(want.keys()).collect();
            let d: Vec<_> = keys
                .into_iter()
                .filter(|k| got.get(*k) != want.get(*k))
                .map(|k| format!("{k}: Rust {:?} ≠ TS {:?}", got.get(k), want.get(k)))
                .collect();
            bad.push(format!("{name} {} {w}×{h}: {}", set["tone"], d.join(", ")));
        }
    }
    println!(
        "{}/{} Token-Sätze identisch",
        sets.len() - bad.len(),
        sets.len()
    );
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}
