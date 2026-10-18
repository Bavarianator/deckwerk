// Fälle aus scripts/check-sync.ts über den Ordner-Sync-Pfad (dieselbe Abgleich-Logik wie WebDAV)
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use dw_sync::{Settings, SyncResult, dav_base, is_folder, parse_multistatus, sync};

fn put(home: &Path, rel: &str, text: &str) {
    let f = home.join(rel);
    fs::create_dir_all(f.parent().unwrap()).unwrap();
    fs::write(f, text).unwrap();
}
fn get(home: &Path, rel: &str) -> String {
    fs::read_to_string(home.join(rel)).unwrap()
}
fn older(home: &Path, rel: &str) {
    let f = fs::File::options()
        .write(true)
        .open(home.join(rel))
        .unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
}
fn none() -> SyncResult {
    SyncResult::default()
}
async fn run(home: &Path, s: &Settings) -> Result<SyncResult, String> {
    sync(home, s, &mut |_| {}).await
}

#[test]
fn adresse() {
    let s = |url: &str, user: &str| Settings {
        url: url.into(),
        user: user.into(),
        pass: String::new(),
    };
    assert_eq!(
        dav_base(&s("cloud.example.org", "a b")).unwrap().as_str(),
        "https://cloud.example.org/remote.php/dav/files/a%20b/Deckwerk/"
    );
    assert_eq!(
        dav_base(&s("https://dav.box.com/dav", "x"))
            .unwrap()
            .as_str(),
        "https://dav.box.com/dav/Deckwerk/"
    );
    assert_eq!(
        dav_base(&s("file:///C:/Users/a%20b/Dropbox", ""))
            .unwrap()
            .as_str(),
        "file:///C:/Users/a%20b/Dropbox/Deckwerk/"
    );
    assert!(is_folder("FILE:///x") && !is_folder("cloud.example.org") && !is_folder("https://x/"));
}

#[test]
fn multistatus() {
    let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>/dav/Deckwerk</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<D:response><D:href>/dav/Deckwerk/f-%26-e/deck.json</D:href><D:getetag>W/&quot;7&quot;</D:getetag><D:getcontentlength>9</D:getcontentlength><D:getlastmodified>Sun, 06 Nov 1994 08:49:37 GMT</D:getlastmodified><D:resourcetype/></D:response>
<response><href>/dav/Deckwerk/a&amp;b.png</href><resourcetype/></response>
<d:response><d:href>/fremd/x</d:href></d:response></d:multistatus>"#;
    let e = parse_multistatus(xml, "/dav/Deckwerk/");
    assert_eq!(e.len(), 3);
    assert_eq!((e[0].0.as_str(), e[0].1), ("", true));
    assert_eq!(
        e[1],
        (
            "f-&-e/deck.json".into(),
            false,
            784_111_777_000,
            9,
            "7".into()
        )
    );
    assert_eq!(e[2].0, "a&b.png");
}

#[tokio::test(flavor = "current_thread")]
async fn ordner_sync() {
    let root = std::env::temp_dir().join(format!("dw-sync-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let (box_, a, b) = (root.join("Dropbox"), root.join("pc"), root.join("handy"));
    fs::create_dir_all(&box_).unwrap();
    let s = Settings {
        url: reqwest_url(&box_),
        user: String::new(),
        pass: String::new(),
    };
    let cloud = box_.join("Deckwerk");

    // 1) PC lädt hoch (Versionen, Schriften, Punktdateien bleiben lokal), Handy lädt herunter
    put(&a, "pitch/deck.json", r#"{"v":1}"#);
    put(&a, "pitch/versions/alt.json", "x");
    put(&a, "assets/foto.png", "PNG");
    put(&a, ".setup-done", "");
    put(&a, "fonts/N/N.ttf", "TTF");
    older(&a, "pitch/deck.json");
    assert_eq!(run(&a, &s).await.unwrap(), SyncResult { up: 2, ..none() });
    assert!(!cloud.join("pitch/versions").exists() && !cloud.join("fonts").exists());
    // X-OC-Mtime-Entsprechung: Bearbeitungszeit bleibt
    let mt = |p: PathBuf| {
        fs::metadata(p)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    };
    assert_eq!(
        mt(cloud.join("pitch/deck.json")),
        mt(a.join("pitch/deck.json"))
    );
    assert_eq!(
        run(&b, &s).await.unwrap().changed,
        vec![b.join("assets/foto.png"), b.join("pitch/deck.json")]
    );
    assert_eq!(get(&b, "pitch/deck.json"), r#"{"v":1}"#);
    assert_eq!(run(&a, &s).await.unwrap(), none());

    // 2) Handy ändert, PC holt ab
    put(&b, "pitch/deck.json", r#"{"v":22}"#);
    assert_eq!(run(&b, &s).await.unwrap().up, 1);
    assert_eq!(run(&a, &s).await.unwrap().down, 1);
    assert_eq!(get(&a, "pitch/deck.json"), r#"{"v":22}"#);

    // 3) Konflikt: beide ändern, Handy neuer → PC bekommt Handy-Fassung, eigene landet in versions/
    put(&a, "pitch/deck.json", r#"{"v":"pc"}"#);
    older(&a, "pitch/deck.json");
    put(&b, "pitch/deck.json", r#"{"v":"handy"}"#);
    run(&b, &s).await.unwrap();
    assert_eq!(run(&a, &s).await.unwrap().conflicts, 1);
    assert_eq!(get(&a, "pitch/deck.json"), r#"{"v":"handy"}"#);
    let versions = |h: &Path, tag: &str| -> Vec<String> {
        fs::read_dir(h.join("pitch/versions"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(tag))
            .map(|e| fs::read_to_string(e.path()).unwrap())
            .collect()
    };
    assert_eq!(
        versions(&a, "-lokal.json"),
        vec![r#"{"v":"pc"}"#.to_string()]
    );

    // 3b) neues Gerät, gleich große andere deck.json: Inhaltsvergleich → Konflikt, keine Fassung geht verloren
    let c = root.join("tablet");
    put(&c, "pitch/deck.json", r#"{"v":"hendy"}"#);
    let mut texte = vec![];
    assert_eq!(
        sync(&c, &s, &mut |t| texte.push(t.to_string()))
            .await
            .unwrap()
            .conflicts,
        1
    );
    assert_eq!(fs::read_dir(c.join("pitch/versions")).unwrap().count(), 1);
    assert_eq!(
        texte,
        [
            "Vergleicht 1 von 1 Dateien",
            "Überträgt 0 von 2 Dateien",
            "Überträgt 1 von 2 Dateien",
            "Überträgt 2 von 2 Dateien"
        ]
    );
    assert_eq!(
        versions(&c, "-cloud.json"),
        vec![r#"{"v":"handy"}"#.to_string()]
    );
    run(&a, &s).await.unwrap();
    run(&b, &s).await.unwrap();

    // 3d) Name mit `\` (unter Windows Ordnertrenner) nie herunterladen; Systemdateien bleiben, wo sie sind
    put(&cloud, r"x\..\..\evil.cmd", "BOOM");
    put(&cloud, "desktop.ini", "[x]");
    put(&cloud, "pitch/Icon\r", "");
    put(&a, "Desktop.ini", "[y]");
    assert_eq!(run(&a, &s).await.unwrap(), none());
    assert!(
        !fs::read_dir(&a)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains('\\'))
    );
    assert!(
        !a.join("desktop.ini").exists()
            && !a.join("pitch/Icon\r").exists()
            && get(&a, "Desktop.ini") == "[y]"
    );

    // 3e) geteiltes Deck (mitarbeit.json): nur Fehlendes holen, nie hochladen oder löschen
    let (e, f) = (root.join("besitzer"), root.join("zweit"));
    put(&e, "team/deck.json", r#"{"v":1}"#);
    assert_eq!(run(&e, &s).await.unwrap().up, 1);
    put(&e, "team/mitarbeit.json", "{}");
    put(&cloud, "team/mitarbeit.json", "{}");
    put(&cloud, "team/deck.json", r#"{"v":"gast"}"#);
    put(&e, "team/deck.json", r#"{"v":"besitzer"}"#);
    assert_eq!(run(&e, &s).await.unwrap(), none());
    assert_eq!(get(&cloud, "team/deck.json"), r#"{"v":"gast"}"#);
    assert_eq!(get(&e, "team/deck.json"), r#"{"v":"besitzer"}"#);
    let got = run(&f, &s).await.unwrap().changed;
    assert!(
        got.contains(&f.join("team/deck.json")) && got.contains(&f.join("team/mitarbeit.json"))
    );
    put(&f, "team/deck.json", r#"{"v":"zweit"}"#);
    fs::remove_file(e.join("team/deck.json")).unwrap();
    assert_eq!(run(&f, &s).await.unwrap(), none());
    assert_eq!(run(&e, &s).await.unwrap(), none());
    assert_eq!(get(&cloud, "team/deck.json"), r#"{"v":"gast"}"#);
    fs::remove_dir_all(cloud.join("team")).unwrap();
    run(&e, &s).await.unwrap(); // vergisst team/ (nur Forget/Keep)

    // 4) Löschen wandert mit
    fs::remove_file(b.join("assets/foto.png")).unwrap();
    run(&b, &s).await.unwrap(); // holt evtl. Neues aus 3b
    assert!(!cloud.join("assets/foto.png").exists());
    assert_eq!(run(&a, &s).await.unwrap().deleted, 1);
    assert!(!a.join("assets/foto.png").exists());

    // 5) Sonderzeichen im Namen: bleibt eine Datei, kein Dauer-Abgleich
    put(&a, "f-&-e ü/deck.json", "{}");
    assert_eq!(run(&a, &s).await.unwrap().up, 1);
    assert_eq!(run(&a, &s).await.unwrap(), none());

    // 6) Löschbremse: lokaler Ordner fast leer → nichts auf dem Server löschen
    for i in 0..12 {
        put(
            &a,
            &format!("deck{i}/deck.json"),
            &format!(r#"{{"i":{i}}}"#),
        );
    }
    run(&a, &s).await.unwrap();
    for i in 0..12 {
        fs::remove_dir_all(a.join(format!("deck{i}"))).unwrap();
    }
    assert!(run(&a, &s).await.unwrap_err().contains("angehalten"));
    assert!(cloud.join("deck0/deck.json").exists());
    for i in 0..12 {
        put(
            &a,
            &format!("deck{i}/deck.json"),
            &format!(r#"{{"i":{i}}}"#),
        );
    }

    // 7) Ordner Deckwerk auf der Gegenseite gelöscht → lokal nichts löschen, alles neu hochladen
    fs::remove_dir_all(&cloud).unwrap();
    assert_eq!(run(&b, &s).await.unwrap().deleted, 0);
    assert!(b.join("pitch/deck.json").exists() && cloud.join("pitch/deck.json").exists());

    // 9) iCloud hat eine Datei ausgelagert → abbrechen statt lokal löschen
    put(&cloud, "pitch/.deck.json.icloud", "");
    fs::remove_file(cloud.join("pitch/deck.json")).unwrap();
    assert!(run(&b, &s).await.unwrap_err().contains("iCloud"));
    assert!(b.join("pitch/deck.json").exists());

    // Sync-Ordner zeigt per Link auf den Datenordner → verweigert
    let evil = root.join("evil");
    fs::create_dir_all(&evil).unwrap();
    std::os::unix::fs::symlink(&b, evil.join("Deckwerk")).unwrap();
    let es = Settings {
        url: reqwest_url(&evil),
        ..s
    };
    assert!(run(&b, &es).await.unwrap_err().contains("selbst"));
    // fehlender Sync-Ordner
    let gone = Settings {
        url: reqwest_url(&root.join("fehlt")),
        user: String::new(),
        pass: String::new(),
    };
    assert!(run(&b, &gone).await.unwrap_err().contains("gibt es nicht"));

    fs::remove_dir_all(&root).unwrap();
}

fn reqwest_url(p: &Path) -> String {
    format!("file://{}", p.display()) // Testpfade ohne Sonderzeichen
}
