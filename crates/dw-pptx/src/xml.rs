//! Dünne Hülle um den quick-xml-Writer: Nutzertexte gehen nur über `text`/Attribute (escaped), `raw` nur für Konstanten.

use quick_xml::Writer;
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};

pub type Attrs<'a> = &'a [(&'a str, String)];
pub const NO: Attrs = &[];

macro_rules! a {
    () => { $crate::xml::NO };
    ($($k:literal => $v:expr),+ $(,)?) => { &[$(($k, ($v).to_string())),+][..] };
}
pub(crate) use a;

pub struct X(Writer<Vec<u8>>);

impl X {
    pub fn new() -> Self {
        let mut w = Writer::new(Vec::new());
        ok(w.write_event(Event::Decl(BytesDecl::new(
            "1.0",
            Some("UTF-8"),
            Some("yes"),
        ))));
        X(w)
    }
    /// Ohne XML-Deklaration, für Bausteine, die in ein anderes Teil kommen.
    pub fn frag() -> Self {
        X(Writer::new(Vec::new()))
    }
    fn start(n: &str, a: Attrs) -> BytesStart<'static> {
        let mut s = BytesStart::new(n.to_string());
        for (k, v) in a {
            s.push_attribute((*k, clean(v).as_str()));
        }
        s
    }
    pub fn open(&mut self, n: &str, a: Attrs) {
        ok(self.0.write_event(Event::Start(Self::start(n, a))));
    }
    pub fn empty(&mut self, n: &str, a: Attrs) {
        ok(self.0.write_event(Event::Empty(Self::start(n, a))));
    }
    pub fn close(&mut self, n: &str) {
        ok(self.0.write_event(Event::End(BytesEnd::new(n))));
    }
    pub fn text(&mut self, s: &str) {
        ok(self.0.write_event(Event::Text(BytesText::new(&clean(s)))));
    }
    pub fn leaf(&mut self, n: &str, a: Attrs, text: &str) {
        self.open(n, a);
        self.text(text);
        self.close(n);
    }
    /// Nur feste Bausteine ohne Nutzerdaten.
    pub fn raw(&mut self, s: &'static str) {
        self.0.get_mut().extend_from_slice(s.as_bytes());
    }
    /// Selbst erzeugtes XML ohne Nutzertext (Zeitleiste, Übergang) oder ein `frag()`-Ergebnis.
    pub fn trusted(&mut self, s: &str) {
        self.0.get_mut().extend_from_slice(s.as_bytes());
    }
    pub fn done(self) -> Vec<u8> {
        self.0.into_inner()
    }
}

// Schreiben in einen Vec kann nicht scheitern
fn ok(r: std::io::Result<()>) {
    r.expect("XML in Vec schreiben");
}

// Steuerzeichen sind in XML 1.0 verboten, auch escaped; sonst wäre die Datei kaputt
fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || matches!(c, '\t' | '\n' | '\r'))
        .collect()
}
