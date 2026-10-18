//! Feinsatz für Folientexte (typo.ts `typeset`): „…“, ’ und – statt Tastatur-Zeichen, geschützte Leerzeichen vor Einheiten.
//! Die Lookarounds der TS-Regexe kann `regex` nicht; jeder Schritt ist ein Scanner über die Zeichen des Eingangs
//! (Lookbehind sieht wie in JS den unveränderten Text des jeweiligen Schritts).

use std::sync::LazyLock;

use regex::Regex;

use crate::js::{WS, is_ws};

const NB: char = '\u{a0}';

pub(crate) fn is_letter(c: char) -> bool {
    static L: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{L}$").unwrap());
    if c.is_ascii() {
        return c.is_ascii_alphabetic();
    }
    L.is_match(c.encode_utf8(&mut [0; 4]))
}

fn digit(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_ascii_digit())
}

/// Ersetzt von links nach rechts nicht überlappend: `f(zeichen, i)` liefert (Länge, Ersatz) für einen Treffer ab i.
fn scan(cs: &[char], f: impl Fn(&[char], usize) -> Option<(usize, String)>) -> Vec<char> {
    let mut out = Vec::with_capacity(cs.len());
    let mut i = 0;
    while i < cs.len() {
        if let Some((n, rep)) = f(cs, i) {
            out.extend(rep.chars());
            i += n;
        } else {
            out.push(cs[i]);
            i += 1;
        }
    }
    out
}

fn starts(cs: &[char], i: usize, lit: &str) -> bool {
    lit.chars().enumerate().all(|(k, c)| cs.get(i + k) == Some(&c))
}

fn clen(s: &str) -> usize {
    s.chars().count()
}

// PROTECT: URLs, Pfade und E-Mail-Adressen; Pfade nur am Anfang oder nach Leerraum
fn protect(s: &str) -> (String, Vec<String>) {
    static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^(?:https?://|www\.|asset:|data:|file:)[^{WS}]*")).unwrap());
    static PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^/[^{WS}]+")).unwrap());
    static MAIL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!(r#"^[^{WS}"„“”]+@[^{WS}"„“”]+\.[^{WS}"„“”]+"#)).unwrap());
    let mut kept = Vec::new();
    let mut out = String::new();
    let mut i = 0;
    let mut prev: Option<char> = None;
    while i < s.len() {
        let rest = &s[i..];
        let m = URL
            .find(rest)
            .or_else(|| prev.is_none_or(is_ws).then(|| PATH.find(rest)).flatten())
            .or_else(|| MAIL.find(rest));
        if let Some(m) = m {
            let t = &rest[..m.end()];
            out.push(char::from_u32(0xe100 + kept.len() as u32).unwrap_or('\u{fffd}'));
            kept.push(t.to_string());
            prev = t.chars().last();
            i += m.end();
        } else {
            let c = rest.chars().next().unwrap();
            out.push(c);
            prev = Some(c);
            i += c.len_utf8();
        }
    }
    (out, kept)
}

// Gerade Anführungszeichen paarweise; Zollzeichen (Ziffer davor, außerhalb eines Paars) und unpaarige Strings bleiben
fn quotes(t: &[char]) -> Option<Vec<char>> {
    let mut open = false;
    let mut out = t.to_vec();
    for i in 0..t.len() {
        if t[i] != '"' {
            continue;
        }
        if open {
            out[i] = '“';
            open = false;
        } else if i > 0 && t[i - 1].is_ascii_digit() {
            continue;
        } else if (i == 0 || is_ws(t[i - 1]) || "([/:;!?–—".contains(t[i - 1]))
            && t.get(i + 1).is_some_and(|&c| c.is_ascii_digit() || (c.len_utf16() == 1 && is_letter(c))) // TS prüft eine UTF-16-Einheit: 𝐀 zählt nicht
        {
            out[i] = '„';
            open = true;
        } else {
            return None;
        }
    }
    (!open).then_some(out)
}

// ID_BEFORE: Ziffer + Leerzeichen oder Kennung (Tel., Nr. …) direkt vor dem Bereich
fn id_before(pre: &[char]) -> bool {
    let n = pre.len();
    if n >= 2 && pre[n - 2].is_ascii_digit() && (pre[n - 1] == ' ' || pre[n - 1] == NB) {
        return true;
    }
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    for sp in [true, false] {
        for dot in [true, false] {
            let mut end = n;
            if sp {
                if end == 0 || !(pre[end - 1] == ' ' || pre[end - 1] == NB) {
                    continue;
                }
                end -= 1;
            }
            if dot {
                if end == 0 || pre[end - 1] != '.' {
                    continue;
                }
                end -= 1;
            }
            for w in ["Tel", "Fax", "Nr", "SKU", "ISO", "IBAN", "Art"] {
                let l = clen(w);
                if end >= l && starts(pre, end - l, w) && (end == l || !word(pre[end - l - 1])) {
                    return true;
                }
            }
        }
    }
    false
}

fn run(cs: &[char], i: usize) -> usize {
    cs[i..].iter().take_while(|c| c.is_ascii_digit()).count()
}

// Bereichsstrich zwischen Jahren: (?<![\d\p{L},.-])((?:19|20)\d\d)-((?:19|20)\d\d)(?![\d-])
fn years(cs: &[char]) -> Vec<char> {
    let year = |i: usize| {
        i + 4 <= cs.len()
            && ((cs[i] == '1' && cs[i + 1] == '9') || (cs[i] == '2' && cs[i + 1] == '0'))
            && cs[i + 2].is_ascii_digit()
            && cs[i + 3].is_ascii_digit()
    };
    scan(cs, |cs, i| {
        if i > 0 && (cs[i - 1].is_ascii_digit() || is_letter(cs[i - 1]) || ",.-".contains(cs[i - 1])) {
            return None;
        }
        if !(year(i) && cs.get(i + 4) == Some(&'-') && year(i + 5)) || cs.get(i + 9).is_some_and(|&c| c.is_ascii_digit() || c == '-') {
            return None;
        }
        let m: String = cs[i..i + 9].iter().collect();
        Some((9, if id_before(&cs[..i]) { m } else { m.replacen('-', "–", 1) }))
    })
}

// COUNT nach einem Zahlbereich, optional ein Leerzeichen davor
fn count_at(cs: &[char], i: usize) -> bool {
    const WORDS: [&str; 19] = [
        "Uhr", "Mal", "Jahre", "Jahren", "Monate", "Monaten", "Wochen", "Tage", "Tagen", "Stunden", "Minuten", "Prozent", "Mio.", "Mrd.", "Seiten",
        "Personen", "Teilnehmer", "Kinder", "Schüler",
    ];
    let at = |k: usize| {
        starts(cs, k, "%")
            || starts(cs, k, "€")
            || starts(cs, k, "°C")
            || WORDS.iter().any(|w| starts(cs, k, w) && !cs.get(k + clen(w)).is_some_and(|&c| is_letter(c)))
    };
    (cs.get(i).is_some_and(|&c| c == ' ' || c == NB) && at(i + 1)) || at(i)
}

// (?<![\d\p{L},.-])(\d{1,3}(?:,\d+)?)-(\d{1,3}(?:,\d+)?)(?=[ NB]?(?:COUNT)), mit dem Zurückgehen der Regex
fn counts(cs: &[char]) -> Vec<char> {
    scan(cs, |cs, i| {
        if i > 0 && (cs[i - 1].is_ascii_digit() || is_letter(cs[i - 1]) || ",.-".contains(cs[i - 1])) {
            return None;
        }
        let r1 = run(cs, i);
        if r1 == 0 || r1 > 3 {
            return None;
        }
        let mut a = i + r1;
        if cs.get(a) == Some(&',') && digit(cs.get(a + 1)) {
            a += 1 + run(cs, a + 1);
        }
        if cs.get(a) != Some(&'-') {
            return None;
        }
        let b0 = a + 1;
        let r2 = run(cs, b0);
        for n2 in (1..=r2.min(3)).rev() {
            let mut ends = Vec::new();
            let e = b0 + n2;
            if cs.get(e) == Some(&',') && digit(cs.get(e + 1)) {
                for k in (1..=run(cs, e + 1)).rev() {
                    ends.push(e + 1 + k);
                }
            }
            ends.push(e);
            for end in ends {
                if count_at(cs, end) {
                    let x: String = cs[i..a].iter().collect();
                    let y: String = cs[b0..end].iter().collect();
                    let m = format!("{x}-{y}");
                    return Some((end - i, if id_before(&cs[..i]) { m } else { format!("{x}–{y}") }));
                }
            }
        }
        None
    })
}

pub fn typeset(s: &str) -> String {
    if s.starts_with('/') {
        return s.into(); // Dateipfad
    }
    let (t, kept) = protect(s);
    let cs: Vec<char> = t.chars().collect();
    let mut cs = quotes(&cs).unwrap_or(cs);
    // Apostroph zwischen Buchstaben
    cs = scan(&cs, |cs, i| (cs[i] == '\'' && i > 0 && is_letter(cs[i - 1]) && cs.get(i + 1).is_some_and(|&c| is_letter(c))).then(|| (1, "’".into())));
    // Gedankenstrich, nicht in Formeln („x - 3“)
    cs = scan(&cs, |cs, i| {
        let before = (i >= 2 && is_letter(cs[i - 1]) && is_letter(cs[i - 2])) || (i >= 1 && ")”“".contains(cs[i - 1]));
        (before && starts(cs, i, " - ") && cs.get(i + 3).is_some_and(|&c| is_letter(c))).then(|| (3, " – ".into()))
    });
    // Gedankenstrich bleibt am Zeilenende
    cs = scan(&cs, |cs, i| (i > 0 && !is_ws(cs[i - 1]) && starts(cs, i, " – ")).then(|| (3, format!("{NB}– "))));
    // Ziffer + %, ‰, €
    cs = scan(&cs, |cs, i| {
        if !cs[i].is_ascii_digit() {
            return None;
        }
        let k = if cs.get(i + 1).is_some_and(|&c| c == ' ' || c == NB) && cs.get(i + 2).is_some_and(|c| "%‰€".contains(*c)) { 2 } else { 1 };
        cs.get(i + k).filter(|c| "%‰€".contains(**c)).map(|u| (k + 1, format!("{}{NB}{u}", cs[i])))
    });
    // Ziffer + Einheit, dahinter kein Buchstabe und keine Ziffer
    const UNITS: [&str; 15] = ["Mio.", "Mio", "Mrd.", "Mrd", "Tsd.", "Tsd", "T€", "km²", "km", "m²", "m³", "kg", "h", "Min.", "Std."];
    cs = scan(&cs, |cs, i| {
        if !(cs[i].is_ascii_digit() && cs.get(i + 1).is_some_and(|&c| c == ' ' || c == NB)) {
            return None;
        }
        UNITS
            .iter()
            .find(|u| starts(cs, i + 2, u) && !cs.get(i + 2 + clen(u)).is_some_and(|&c| is_letter(c) || c.is_ascii_digit()))
            .map(|u| (2 + clen(u), format!("{}{NB}{u}", cs[i])))
    });
    // Mio./Mrd./Tsd. + Währung
    cs = scan(&cs, |cs, i| {
        ["Mio.", "Mio", "Mrd.", "Mrd", "Tsd.", "Tsd"].iter().find_map(|p| {
            let k = i + clen(p);
            if !(starts(cs, i, p) && cs.get(k).is_some_and(|&c| c == ' ' || c == NB)) {
                return None;
            }
            ["€", "$", "£", "Euro"].iter().find(|c| starts(cs, k + 1, c)).map(|c| (clen(p) + 1 + clen(c), format!("{p}{NB}{c}")))
        })
    });
    // z. B., d. h., u. a.
    cs = scan(&cs, |cs, i| {
        if i > 0 && is_letter(cs[i - 1]) {
            return None;
        }
        [("z", 'B'), ("Z", 'B'), ("d", 'h'), ("u", 'a')].iter().find_map(|(a, b)| {
            if !starts(cs, i, a) || cs.get(i + 1) != Some(&'.') {
                return None;
            }
            let sp = cs.get(i + 2).is_some_and(|&c| c == ' ' || c == NB);
            let k = i + 2 + sp as usize;
            (cs.get(k) == Some(b) && cs.get(k + 1) == Some(&'.')).then(|| (k + 2 - i, format!("{a}.{NB}{b}.")))
        })
    });
    // Nr./S. vor Ziffer
    cs = scan(&cs, |cs, i| {
        if i > 0 && is_letter(cs[i - 1]) {
            return None;
        }
        ["Nr", "S"].iter().find_map(|p| {
            let k = i + clen(p);
            if !(starts(cs, i, p) && cs.get(k) == Some(&'.')) {
                return None;
            }
            let sp = cs.get(k + 1).is_some_and(|&c| c == ' ' || c == NB);
            if sp && digit(cs.get(k + 2)) {
                return Some((clen(p) + 2, format!("{p}.{NB}")));
            }
            digit(cs.get(k + 1)).then(|| (clen(p) + 1, format!("{p}.{NB}")))
        })
    });
    cs = years(&cs);
    cs = counts(&cs);
    cs.into_iter()
        .map(|c| match c as u32 {
            n @ 0xe100..=0xe1ff => kept.get((n - 0xe100) as usize).cloned().unwrap_or_else(|| "undefined".into()),
            _ => c.to_string(),
        })
        .collect()
}
