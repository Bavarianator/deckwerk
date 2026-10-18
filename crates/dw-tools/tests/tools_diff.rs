//! Werkzeugliste, Beschreibungen und Schemas gegen tools/list des TS-Servers (tests/fixtures/tools-<edition>.json aus
//! tests/gen/gen-tools.ts). Verglichen wird nach einer kleinen Normalisierung: `type: [x, "null"]` = anyOf mit null,
//! Zahlen als f64, `required` als Menge, Records ohne propertyNames.

use serde_json::{Value, json};

fn fixture() -> Value {
    let f = if dw_tools::PRO {
        "tools-pro.json"
    } else {
        "tools-deckwerk.json"
    };
    serde_json::from_str(
        &std::fs::read_to_string(format!("{}/tests/fixtures/{f}", env!("CARGO_MANIFEST_DIR")))
            .unwrap(),
    )
    .unwrap()
}

fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => {
            let mut o = o.clone();
            o.remove("$schema");
            if o.get("propertyNames") == Some(&json!({"type": "string"})) {
                o.remove("propertyNames");
            }
            if o.get("additionalProperties") == Some(&json!({})) {
                o.insert("additionalProperties".into(), json!(true));
            }
            if o.get("type") == Some(&json!("object"))
                && !o.contains_key("properties")
                && !o.contains_key("additionalProperties")
            {
                o.insert("properties".into(), json!({}));
            }
            if let Some(Value::Array(r)) = o.get_mut("required") {
                r.sort_by_key(|x| x.to_string());
                if r.is_empty() {
                    o.remove("required");
                }
            }
            if let Some(Value::Array(t)) = o.get("type").cloned()
                && t.len() == 2
                && t.contains(&json!("null"))
            {
                let x = t.into_iter().find(|x| x != "null").unwrap();
                let mut inner = serde_json::Map::new();
                for (k, v) in o.clone() {
                    if k != "description" && k != "default" {
                        inner.insert(k, v);
                    }
                }
                inner.insert("type".into(), x);
                o.retain(|k, _| k == "description" || k == "default");
                o.insert("anyOf".into(), json!([inner, {"type": "null"}]));
            }
            Value::Object(
                o.iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            if k == "enum" || k == "const" || k == "default" {
                                v.clone()
                            } else {
                                norm(v)
                            },
                        )
                    })
                    .collect::<serde_json::Map<_, _>>(),
            )
        }
        _ => v.clone(),
    }
}

fn diff(got: &Value, exp: &Value, path: &str, out: &mut Vec<String>) {
    match (got, exp) {
        (Value::Object(g), Value::Object(e)) => {
            for k in e.keys().chain(g.keys().filter(|k| !e.contains_key(*k))) {
                match (g.get(k), e.get(k)) {
                    (Some(a), Some(b)) => diff(a, b, &format!("{path}.{k}"), out),
                    (a, b) => out.push(format!("{path}.{k}: Rust {} / TS {}", short(a), short(b))),
                }
            }
        }
        (Value::Array(g), Value::Array(e)) if g.len() == e.len() => {
            for (i, (a, b)) in g.iter().zip(e).enumerate() {
                diff(a, b, &format!("{path}[{i}]"), out);
            }
        }
        _ if got != exp => out.push(format!(
            "{path}: Rust {} / TS {}",
            short(Some(got)),
            short(Some(exp))
        )),
        _ => {}
    }
}

fn short(v: Option<&Value>) -> String {
    v.map_or("–".into(), |v| v.to_string().chars().take(160).collect())
}

#[test]
fn werkzeuge_wie_ts() {
    let f = fixture();
    let ts: Vec<&Value> = f["mcp"].as_array().unwrap().iter().collect();
    let metas = dw_tools::meta::all();
    let rust: Vec<&dw_tools::meta::Meta> = metas
        .iter()
        .filter(|m| m.name != "plan_storyline" && m.name != "ask_user")
        .collect();
    let names = |v: &[&dw_tools::meta::Meta]| v.iter().map(|m| m.name).collect::<Vec<_>>();
    assert_eq!(
        names(&rust),
        ts.iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect::<Vec<_>>()
    );
    let mut out = vec![];
    for (m, t) in rust.iter().zip(&ts) {
        if m.description != t["description"].as_str().unwrap() {
            out.push(format!("{}: Beschreibung weicht ab", m.name));
        }
        let ro = t["annotations"]["readOnlyHint"] == json!(true);
        if m.read_only != ro {
            out.push(format!("{}: readOnly {} / TS {ro}", m.name, m.read_only));
        }
        diff(
            &norm(&(m.schema)()),
            &norm(&t["inputSchema"]),
            m.name,
            &mut out,
        );
    }
    assert!(
        out.is_empty(),
        "{} Abweichungen:\n{}",
        out.len(),
        out.join("\n")
    );
}
