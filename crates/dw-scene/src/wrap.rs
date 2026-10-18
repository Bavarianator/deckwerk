//! Zeilenumbruch wie Blinks `ScoreLineBreaker` (score_line_breaker.cc): `text-wrap: pretty` für .r-body/.r-label/.r-small
//! und `text-wrap: balance` für Titel. Knuth-Plass über die Umbruchstellen eines Absatzes mit Minikins Strafwerten.
//!
//! Blink-Verhalten, das hier nachgebaut ist:
//! - pretty greift nur, wenn die greedy gesetzte letzte Zeile kürzer als ⅓ der Breite ist und aus einem Wort besteht,
//!   und optimiert nur die letzten 4 Zeilen des Absatzes (gleitendes Fenster, kMaxLinesForOptimal).
//! - balance optimiert Absätze bis 6 Zeilen ganz, die letzte Zeile zählt mit.
//! - Ergibt die Optimierung eine andere Zeilenzahl als greedy, bleibt es bei greedy.

/// Umbruchstelle; Positionen relativ zum Fensteranfang.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Cand {
    /// Ende der Zeile, wenn hier nicht umbrochen wird (inkl. Leerraum) = Anfang der nächsten Zeile
    pub no_break: f32,
    /// Ende der Zeile, wenn hier umbrochen wird (ohne Leerraum)
    pub if_break: f32,
    pub penalty: f32,
}

const OVERFULL: f32 = 1e12;
const LAST_LINE_PENALTY: f32 = 4.;
const ORPHANS_PENALTY: f32 = 10000.;
/// LayoutUnit::AddEpsilon (1/64 px)
pub(crate) const LU: f32 = 1. / 64.;

pub(crate) const MAX_LINES_PRETTY: usize = 4;
pub(crate) const MAX_LINES_BALANCE: usize = 6;

/// Blinks ShouldOptimize für pretty: letzte Zeile kurz und ohne Umbruchstelle.
pub(crate) fn should_optimize(last_width: f32, avail: f32, last_has_break: bool) -> bool {
    last_width < avail / 3. && !last_has_break
}

/// Wählt die Umbrüche. `cands` = [Anfang, Umbruchstellen…, Ende]; `avail0` gilt für die erste Zeile (Einzug), `avail`
/// für alle weiteren, `font_size` und `avail` ergeben die Zeilenstrafe. Liefert die Indizes der Zeilenenden
/// (letzter = Ende) oder None, wenn Blink bei greedy bliebe.
pub(crate) fn optimal(
    mut cands: Vec<Cand>,
    avail0: f32,
    avail: f32,
    font_size: f32,
    balanced: bool,
    lines: usize,
) -> Option<Vec<usize>> {
    // Sentinels vorn und hinten: unter 3 Umbruchstellen lohnt es nicht
    if cands.len() < 5 {
        return None;
    }
    let n = cands.len();
    cands[n - 2].penalty += ORPHANS_PENALTY; // Hurenkind vermeiden: letzte Umbruchstelle teurer
    let line_penalty = avail * font_size * 4.; // hyphen_penalty = W·fs·2, line_penalty = 2·hyphen
    let fit = |line: usize| if line == 0 { avail0 } else { avail } + LU;
    // (score, prev, line_index)
    let mut scores: Vec<(f32, usize, usize)> = vec![(0., 0, 0)];
    let mut active = 0;
    for end in 1..n {
        let last = end == n - 1;
        let e = cands[end];
        let mut best = f32::MAX;
        let mut best_prev = 0;
        let from = active; // Blink: neue Untergrenze gilt erst ab dem nächsten Zeilenende
        for start in from..end {
            let (s_score, _, line) = scores[start];
            if s_score >= best {
                continue;
            }
            let s = cands[start];
            let delta = s.no_break - (e.if_break - fit(line));
            let mut width = 0.;
            let mut extra = 0.;
            if delta < 0. {
                width = OVERFULL;
                active = start + 1;
            } else if last && !balanced {
                extra = LAST_LINE_PENALTY * s.penalty;
            } else {
                width = delta * delta;
            }
            let score = s_score + width + extra;
            if score <= best {
                best = score;
                best_prev = start;
            }
        }
        let line = scores[best_prev].2 + 1;
        scores.push((best + e.penalty + line_penalty, best_prev, line));
    }
    let mut ends = Vec::new();
    let mut i = n - 1;
    while i > 0 {
        ends.push(i);
        i = scores[i].1;
    }
    ends.reverse();
    (ends.len() == lines).then_some(ends)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Wörter gleicher Breite 10 mit Leerraum 2: Positionen der Umbruchstellen
    fn words(n: usize) -> Vec<Cand> {
        let mut c = vec![Cand {
            no_break: 0.,
            if_break: 0.,
            penalty: 0.,
        }];
        for i in 1..=n {
            let x = i as f32 * 12.;
            c.push(Cand {
                no_break: x,
                if_break: x - 2.,
                penalty: 0.,
            });
        }
        let last = c.last_mut().unwrap();
        last.no_break = last.if_break;
        c
    }

    #[test]
    fn pretty_avoids_orphan() {
        // 7 Wörter, 3 pro Zeile (34 px): greedy 3/3/1 → pretty zieht ein Wort in die letzte Zeile
        let ends = optimal(words(7), 35., 35., 10., false, 3).unwrap();
        assert_eq!(ends, vec![3, 5, 7]); // 3/2/2 und 2/3/2 gleich gut: Blink nimmt den späteren Anfang (score <= best)
        // Zeilenzahl wäre anders: greedy bleibt
        assert_eq!(optimal(words(7), 35., 35., 10., false, 4), None);
    }

    #[test]
    fn balance_evens_lines() {
        // 4 Wörter, Platz für 3: balance setzt 2/2 statt 3/1
        assert_eq!(
            optimal(words(4), 35., 35., 10., true, 2).unwrap(),
            vec![2, 4]
        );
    }

    #[test]
    fn short_last_line() {
        assert!(should_optimize(30., 100., false));
        assert!(!should_optimize(30., 100., true));
        assert!(!should_optimize(40., 100., false));
    }
}
