//! Einstellungen: Cloud-Zugang, Bild-KI-Schlüssel, Brand-Kit + Hausstil (settings/*Section.tsx)
use crate::{AppWindow, SettingsData};
use dw_model::BrandKit;
use dw_store::{write_atomic, Store};
use serde_json::{json, Value};
use slint::ComponentHandle;
use std::path::PathBuf;

// ponytail: Klartext-JSON mit 0600 statt safeStorage, Schlüsselbund (Secret Service/Keychain) später
fn secret(store: &Store, name: &str) -> Option<PathBuf> {
    store.app_data().map(|d| d.join(name))
}

fn read(store: &Store, name: &str) -> Value {
    secret(store, name)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

fn write(store: &Store, name: &str, v: &Value) -> Result<(), String> {
    let f = secret(store, name).ok_or("kein appData-Ordner")?;
    std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
    write_atomic(&f, v.to_string().as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn s(v: &Value, k: &str) -> slint::SharedString {
    v[k].as_str().unwrap_or("").into()
}

fn opt(t: slint::SharedString) -> Option<String> {
    let t = t.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Felder aus Dateien laden
pub fn load(ui: &AppWindow, store: &Store) {
    let g = ui.global::<SettingsData>();
    let c = read(store, "sync.json");
    g.set_cloud_url(s(&c, "url"));
    g.set_cloud_user(s(&c, "user"));
    g.set_cloud_pass(s(&c, "pass"));
    let i = read(store, "image-settings.json");
    g.set_image_provider(i32::from(i["provider"] == "openai"));
    g.set_image_key(s(&i, "key"));
    let b = store.brand();
    let f = |x: Option<&String>| slint::SharedString::from(x.map(String::as_str).unwrap_or(""));
    g.set_brand_primary(f(b.as_ref().map(|b| &b.primary)));
    g.set_brand_secondary(f(b.as_ref().and_then(|b| b.secondary.as_ref())));
    g.set_brand_head_font(f(b.as_ref().and_then(|b| b.head_font.as_ref())));
    g.set_brand_body_font(f(b.as_ref().and_then(|b| b.body_font.as_ref())));
    g.set_house_style(store.house_style().into());
    g.set_note("".into());
}

pub fn save_cloud(ui: &AppWindow, store: &Store) {
    let g = ui.global::<SettingsData>();
    let url = g.get_cloud_url().trim().to_string();
    let r = if !url.is_empty() && !url.starts_with("https://") {
        Err("Die Adresse muss mit https:// beginnen.".into())
    } else {
        write(store, "sync.json", &json!({ "url": url, "user": g.get_cloud_user().trim(), "pass": g.get_cloud_pass().as_str() }))
    };
    note(&g, r);
}

pub fn save_image(ui: &AppWindow, store: &Store) {
    let g = ui.global::<SettingsData>();
    let p = if g.get_image_provider() == 1 { "openai" } else { "mammouth" };
    note(&g, write(store, "image-settings.json", &json!({ "provider": p, "key": g.get_image_key().trim() })));
}

pub fn save_brand(ui: &AppWindow, store: &Store) {
    let g = ui.global::<SettingsData>();
    let r = (|| -> Result<(), String> {
        store.set_house_style(&g.get_house_style()).map_err(|e| e.to_string())?;
        let Some(primary) = opt(g.get_brand_primary()) else { return Ok(()) };
        // Logo und Zusatzfelder des alten Kits behalten
        let mut b = store.brand().unwrap_or_else(|| serde_json::from_value::<BrandKit>(json!({ "primary": "" })).unwrap());
        b.primary = primary;
        b.secondary = opt(g.get_brand_secondary());
        b.head_font = opt(g.get_brand_head_font());
        b.body_font = opt(g.get_brand_body_font());
        store.set_brand(&b).map_err(|e| e.to_string())
    })();
    note(&g, r);
}

fn note(g: &SettingsData, r: Result<(), String>) {
    g.set_note(match r {
        Ok(()) => "Gespeichert.".into(),
        Err(e) => format!("Nicht gespeichert: {e}").into(),
    });
}
