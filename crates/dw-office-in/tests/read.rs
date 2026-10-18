use std::io::Write;

fn zip(path: &std::path::Path, files: &[(&str, &[u8])]) {
    let mut z = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    for (n, b) in files {
        z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b).unwrap();
    }
    z.finish().unwrap();
}

#[test]
fn liest_docx_und_pptx() {
    let d = std::env::temp_dir().join(format!("dw-office-in-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    let docx = d.join("a.docx");
    zip(&docx, &[
        ("word/document.xml", b"<w:p><w:r><w:t>Hallo</w:t></w:r><w:r><w:t xml:space=\"preserve\"> Welt &amp; mehr</w:t></w:r></w:p><w:p><w:t>Zwei</w:t></w:p>"),
        ("word/_rels/document.xml.rels", br#"<Relationship Id="r1" Target="media/bild.png"/><Relationship Id="r2" Target="media/x.emf"/>"#),
        ("word/media/bild.png", b"png"),
    ]);
    let s = dw_office_in::read_source(&docx).unwrap();
    assert_eq!(s.text, "Hallo Welt & mehr\nZwei\nBild: bild.png");
    assert_eq!(s.images, vec![("bild.png".into(), b"png".to_vec())]);

    let pptx = d.join("b.pptx");
    zip(&pptx, &[
        ("ppt/slides/slide10.xml", b"<a:p><a:t>Zehn</a:t></a:p>"),
        ("ppt/slides/slide2.xml", b"<a:p><a:t>Zwei</a:t></a:p>"),
    ]);
    assert_eq!(dw_office_in::read_source(&pptx).unwrap().text, "--- Folie 1 ---\nZwei\n\n--- Folie 2 ---\nZehn");
    assert!(dw_office_in::read_source(d.join("x.exe")).is_err());
    std::fs::remove_dir_all(&d).ok();
}
