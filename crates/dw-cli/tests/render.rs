use std::path::Path;
use std::process::Command;

#[test]
fn render_all_formats() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/spike.json");
    let out = Path::new(env!("CARGO_TARGET_TMPDIR")).join("render");
    let _ = std::fs::remove_dir_all(&out);
    let run = Command::new(env!("CARGO_BIN_EXE_deckwerk"))
        .args([
            "render",
            fixture.to_str().unwrap(),
            "--out",
            out.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr),
    );
    assert!(run.status.success(), "{stdout}\n{stderr}");
    assert!(stdout.contains("Folie 1 (cover): OK"), "{stdout}");
    assert!(stderr.contains("Folie 3 (quote) übersprungen"), "{stderr}");

    // Folie 3 fehlt, die Nummern bleiben an der Folienposition
    let mut pngs: Vec<String> = std::fs::read_dir(out.join("ueberblick-wachstum"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    pngs.sort();
    assert_eq!(pngs, ["01.png", "02.png", "04.png"]);

    let info = Command::new("pdfinfo")
        .arg(out.join("ueberblick-wachstum.pdf"))
        .output()
        .expect("pdfinfo");
    assert!(
        String::from_utf8_lossy(&info.stdout).contains("Pages:           3"),
        "{}",
        String::from_utf8_lossy(&info.stdout)
    );

    let list = Command::new("unzip")
        .args([
            "-Z1",
            out.join("ueberblick-wachstum.pptx").to_str().unwrap(),
        ])
        .output()
        .expect("unzip");
    let list = String::from_utf8_lossy(&list.stdout);
    let slides = list
        .lines()
        .filter(|l| l.starts_with("ppt/slides/slide") && l.ends_with(".xml"))
        .count();
    assert_eq!(slides, 3, "{list}");
}

#[test]
fn nothing_renderable_exits_1() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("leer");
    std::fs::create_dir_all(&dir).unwrap();
    let deck = dir.join("deck.json");
    std::fs::write(
        &deck,
        r#"{"title":"Leer","theme":{"id":"beratung"},"slides":[{"id":"a","layout":"quote","content":{}}]}"#,
    )
    .unwrap();
    let run = Command::new(env!("CARGO_BIN_EXE_deckwerk"))
        .args([
            "render",
            deck.to_str().unwrap(),
            "--out",
            dir.join("out").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(run.status.code(), Some(1));
}

#[test]
fn all_hidden_only_pptx() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("versteckt");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let deck = dir.join("deck.json");
    std::fs::write(
        &deck,
        r#"{"title":"Versteckt","theme":{"id":"beratung"},"slides":[{"id":"a","layout":"cover","hidden":true,"content":{"title":"Hallo"}}]}"#,
    )
    .unwrap();
    let render = |formats: &str| {
        Command::new(env!("CARGO_BIN_EXE_deckwerk"))
            .args(["render", deck.to_str().unwrap(), "--out"])
            .arg(dir.join("out"))
            .args(["--formats", formats])
            .output()
            .unwrap()
    };
    let run = render("png,pdf");
    assert_eq!(run.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&run.stderr).contains("Alle Folien sind ausgeblendet"));
    assert!(!dir.join("out/versteckt.pdf").exists());
    let run = render("png,pdf,pptx");
    assert!(run.status.success());
    assert!(dir.join("out/versteckt.pptx").exists());
    assert!(!dir.join("out/versteckt").exists());
}
