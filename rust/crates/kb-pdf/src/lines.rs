//! Text of a PDF page as positioned pieces, grouped into lines and cells (src/core/pdf/lines.ts).
use crate::js;
use crate::model::{Item, PdfText};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering::Equal;

/// Text that belongs together on a line, with the horizontal range it occupies.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PdfCell {
    pub text: String,
    pub x0: f64,
    pub x1: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PdfLine {
    /// Position in reading order over the whole document.
    pub id: usize,
    pub page: usize,
    pub y: f64,
    /// Height of the page, to tell margins from the body.
    #[serde(rename = "pageHeight", default, skip_serializing_if = "Option::is_none")]
    pub page_height: Option<f64>,
    pub cells: Vec<PdfCell>,
}

/// Pieces closer than this (times the font height) are one cell.
const CELL_GAP: f64 = 0.3;
/// Baselines closer than this (times the median font height) are one line.
const LINE_TOLERANCE: f64 = 0.5;

/// The upper middle value of the sorted list, 0 when empty (`sorted[floor(len / 2)]`).
fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values.get(values.len() / 2).copied().unwrap_or(0.0)
}

/// Lines in reading order (top of each page first, left to right), each split into cells.
pub fn to_lines(t: &PdfText) -> Vec<PdfLine> {
    let mut lines: Vec<PdfLine> = Vec::new();
    let mut pages: Vec<_> = t.pages.iter().collect();
    pages.sort_by_key(|p| p.n);
    for page in pages {
        let mut items: Vec<&Item> = page.items.iter().filter(|i| !js::trim(&i.str).is_empty()).collect();
        if items.is_empty() {
            continue;
        }
        items.sort_by(|a, b| b.y.partial_cmp(&a.y).unwrap_or(Equal).then(a.x.partial_cmp(&b.x).unwrap_or(Equal)));
        let m = median(items.iter().map(|i| i.h).filter(|h| *h > 0.0).collect());
        let tolerance = (if m == 0.0 { 10.0 } else { m }) * LINE_TOLERANCE;
        let mut groups: Vec<(f64, Vec<&Item>)> = Vec::new();
        for item in items {
            match groups.last_mut() {
                Some((y, members)) if (*y - item.y).abs() <= tolerance => {
                    members.push(item);
                    *y += (item.y - *y) / members.len() as f64;
                }
                _ => groups.push((item.y, vec![item])),
            }
        }
        for (y, mut members) in groups {
            members.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(Equal));
            lines.push(PdfLine { id: lines.len(), page: page.n, y, page_height: Some(page.height), cells: to_cells(&members) });
        }
    }
    lines
}

fn to_cells(items: &[&Item]) -> Vec<PdfCell> {
    let mut cells: Vec<PdfCell> = Vec::new();
    let mut last: Option<&Item> = None;
    for item in items {
        let gap = last.map_or(f64::INFINITY, |l| item.x - (l.x + l.w));
        match (cells.last_mut(), last) {
            (Some(cell), Some(l)) if gap < CELL_GAP * item.h => {
                // Pieces of one word touch; words are a space apart.
                let space = gap > 0.08 * item.h
                    && !l.str.chars().next_back().is_some_and(js::is_ws)
                    && !item.str.chars().next().is_some_and(js::is_ws);
                if space {
                    cell.text.push(' ');
                }
                cell.text.push_str(&item.str);
                cell.x1 = cell.x1.max(item.x + item.w);
            }
            _ => cells.push(PdfCell { text: item.str.clone(), x0: item.x, x1: item.x + item.w }),
        }
        last = Some(item);
    }
    cells.into_iter().map(|c| PdfCell { text: js::squash(&c.text), ..c }).collect()
}
