//! Leere Folie (layouts-extra.tsx blank): nur Hintergrund, Inhalt als freie Elemente.

use serde_json::{Value, json};

use super::super::Def;
use crate::Error;
use crate::blocks::{Body, Cx};

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: false,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(_: &Cx, _: &Value, _: Option<&str>) -> Result<Body, Error> {
    Ok(Vec::new().into())
}

fn samples() -> [(&'static str, Value); 3] {
    [("min", json!({})), ("typ", json!({})), ("max", json!({}))]
}
