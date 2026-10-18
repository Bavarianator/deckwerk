//! Diagramm als Szene (ChartBox in slide.tsx, Chart.js). Platzhalter, bis Gruppe „Daten“ die Diagrammtypen zeichnet:
//! Balken der ersten Reihe in der ersten Diagrammfarbe.

use dw_model::{ChartSpec, Node, NodeMeta, Paint};
use dw_theme::Theme;
use kurbo::Rect;

use crate::tree::color;

/// Knoten des Diagramms in `r` (nativ in der PPTX: export, Slot des Diagramms).
/// ponytail: Platzhalter-Balken; Achsen, Beschriftung und alle ChartTypes kommen mit dem Port von chartConfig
pub fn draw(spec: &ChartSpec, r: Rect, th: &Theme, slot: &str) -> Vec<Node> {
    let values = spec
        .series
        .first()
        .map(|s| s.values.as_slice())
        .unwrap_or(&[]);
    let max = values.iter().fold(0f64, |m, v| m.max(v.abs()));
    if values.is_empty() || max == 0. {
        return Vec::new();
    }
    let fill = th.c.chart.first().copied().unwrap_or(th.c.accent);
    let n = values.len() as f64;
    let slot_w = r.width() / n;
    let bar = (slot_w * 0.6).min(96.);
    values
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let h = r.height() * v.abs() / max;
            let x = r.x0 + slot_w * i as f64 + (slot_w - bar) / 2.;
            Node::Rect {
                meta: NodeMeta {
                    slot: Some(slot.to_string()),
                    export: true,
                },
                rect: Rect::new(x, r.y1 - h, x + bar, r.y1),
                radius: 2.,
                fill: Some(Paint::Solid(color(fill))),
                stroke: None,
                shadow: None,
            }
        })
        .collect()
}
