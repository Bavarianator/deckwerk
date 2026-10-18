//! JavaScript-Semantik, die die Befund-Texte prägen: Zahlen als Text (`String(x)`, `toFixed`), `Math.round`,
//! Leerraum wie `\s` und `trim()`, UTF-16-Längen. Ohne das wichen Meldungen in Rust um Ziffern oder Leerzeichen ab.

/// `\s` in JS (WhiteSpace + LineTerminator); Rusts `is_whitespace` kennt zusätzlich U+0085, aber nicht U+FEFF.
pub fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `\s` als Zeichenklasse für `regex` (ohne Klammern), z. B. `format!("[{WS}]")`.
pub const WS: &str = r"\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// `s.trim()`
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

/// `s.split(/\s+/).filter(Boolean)`
pub fn words(s: &str) -> Vec<&str> {
    s.split(is_ws).filter(|w| !w.is_empty()).collect()
}

/// `String(x)` für Zahlen.
pub fn num(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let a = x.abs();
    if (1e-6..1e21).contains(&a) {
        return format!("{x}");
    }
    // Exponentialform: Rust 1.5e-7 / 1e21, JS 1.5e-7 / 1e+21
    let e = format!("{x:e}");
    match e.split_once('e') {
        Some((m, exp)) if !exp.starts_with('-') => format!("{m}e+{exp}"),
        _ => e,
    }
}

/// `x.toFixed(d)`: JS rundet echte Gleichstände (0,25 → 0,3) vom Betrag weg, Rust zur geraden Ziffer.
pub fn to_fixed(x: f64, d: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return num(x);
    }
    let neg = x < 0.0;
    let a = x.abs();
    // Rusts Formatierung mit Präzision ist exakt; ein Gleichstand hat nach Stelle d+1 nur Nullen
    let long = format!("{a:.prec$}", prec = d + 40);
    let dot = long.find('.').unwrap_or(long.len());
    let frac = &long[dot + 1..];
    let tie = frac.as_bytes().get(d) == Some(&b'5') && frac[d + 1..].bytes().all(|b| b == b'0');
    let mut s = if tie {
        // abschneiden und eine Einheit der letzten Stelle addieren
        let mut digits: Vec<u8> = long[..dot].bytes().chain(frac[..d].bytes()).collect();
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits[i] == b'9' {
                digits[i] = b'0';
            } else {
                digits[i] += 1;
                break;
            }
        }
        let int_len = digits.len() - d;
        let (ip, fp) = digits.split_at(int_len);
        let ip = String::from_utf8(ip.to_vec()).unwrap();
        if d == 0 { ip } else { format!("{ip}.{}", String::from_utf8(fp.to_vec()).unwrap()) }
    } else {
        format!("{a:.d$}")
    };
    if neg {
        s.insert(0, '-');
    }
    s
}

/// `Math.round`: halbe Werte nach oben (−2,5 → −2).
pub fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `String(+x.toFixed(d)).replace('.', ',')` – Zahl deutsch, ohne unnötige Nullen.
pub fn de(x: f64, d: usize) -> String {
    num(to_fixed(x, d).parse::<f64>().unwrap_or(f64::NAN)).replacen('.', ",", 1)
}

/// Länge in UTF-16-Einheiten (`s.length`).
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed() {
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(9.95, 1), "9.9"); // 9.95 liegt binär darunter
        assert_eq!(to_fixed(9.75, 1), "9.8");
        assert_eq!(to_fixed(99.5, 0), "100");
        assert_eq!(to_fixed(-1.25, 1), "-1.3");
        assert_eq!(to_fixed(-0.0, 1), "0.0");
        assert_eq!(to_fixed(4.5, 1), "4.5");
        assert_eq!(to_fixed(1.005, 2), "1.00");
    }

    #[test]
    fn numbers() {
        assert_eq!(num(5.0), "5");
        assert_eq!(num(-0.0), "0");
        assert_eq!(num(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(num(1e21), "1e+21");
        assert_eq!(num(1.5e-7), "1.5e-7");
        assert_eq!(de(3.25, 1), "3,3");
        assert_eq!(de(120.0, 1), "120");
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(2.5), 3.0);
    }
}
