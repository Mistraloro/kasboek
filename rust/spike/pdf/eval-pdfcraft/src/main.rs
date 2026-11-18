//! Reads a PDF with pdfcraft-render's text extraction and prints the same JSON as kb-spike-pdf.
//! pdfcraft gives one box per glyph in page view space (y down, /Rotate applied) with the writing direction, not
//! text runs: the glyphs are merged into items here, with the same gap rules as pdf.js (see ../README.md).
use pdfcraft_render::text::TextFilter;
use pdfcraft_render::{inspect, PageRenderer, RenderConfig};
use serde::Serialize;
use std::sync::Arc;
use std::time::Instant;

#[derive(Serialize)]
struct Item {
    str: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}
#[derive(Serialize)]
struct Page {
    n: usize,
    width: f64,
    height: f64,
    items: Vec<Item>,
}
#[derive(Serialize)]
struct Out {
    pages: Vec<Page>,
    #[serde(rename = "pageCount")]
    page_count: usize,
}

/// Em box descent as a share of the font size: pdfcraft reports the em box, not the baseline.
const DESCENT: f64 = 0.2;

struct Cur {
    s: String,
    ox: f64,
    oy: f64,
    dir: [f64; 2],
    fs: f64,
    len: f64,
}

fn flush(cur: &mut Option<Cur>, height: f64, items: &mut Vec<Item>) {
    if let Some(c) = cur.take() {
        let x = if c.dir[0] < -1e-6 { c.ox - c.len } else { c.ox };
        items.push(Item {
            str: c.s,
            x,
            y: height - c.oy,
            w: c.len,
            h: c.fs,
        });
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let t = Instant::now();
    let bytes = Arc::new(std::fs::read(args.last().unwrap()).unwrap());
    let info = match inspect(bytes.clone(), None) {
        Ok(i) => i,
        Err(e) => {
            println!(
                "{{\"error\":\"{}\"}}",
                if e.to_string().contains("password") {
                    "import.pdf_password"
                } else {
                    "import.pdf_broken"
                }
            );
            return;
        }
    };
    let mut r = PageRenderer::new(bytes, RenderConfig::default());
    let mut pages = vec![];
    for (p, pi) in info.pages.iter().enumerate() {
        let (w, h) = (pi.width as f64, pi.height as f64);
        let mut items = vec![];
        if let Ok(t) = r.filtered_text(p, TextFilter::default()) {
            let mut cur: Option<Cur> = None;
            for g in &t.glyphs {
                if g.text.trim().is_empty() {
                    continue;
                }
                let d = [g.direction[0] as f64, g.direction[1] as f64];
                let q = g.quad;
                let up = [(q[3][0] - q[0][0]) as f64, (q[3][1] - q[0][1]) as f64];
                let fs = up[0].hypot(up[1]);
                let o = [
                    q[0][0] as f64 + DESCENT * up[0],
                    q[0][1] as f64 + DESCENT * up[1],
                ];
                let adv = ((q[1][0] - q[0][0]) as f64).hypot((q[1][1] - q[0][1]) as f64);
                if let Some(c) = cur.as_mut() {
                    let end = [c.ox + c.dir[0] * c.len, c.oy + c.dir[1] * c.len];
                    let gap = (o[0] - end[0]) * c.dir[0] + (o[1] - end[1]) * c.dir[1];
                    let off = -(o[0] - end[0]) * c.dir[1] + (o[1] - end[1]) * c.dir[0];
                    let same = (d[0] * c.dir[0] + d[1] * c.dir[1]) > 0.99
                        && off.abs() <= 0.25 * c.fs
                        && gap >= -0.2 * c.fs
                        && gap <= 0.6 * c.fs;
                    if same {
                        if gap >= 0.102 * c.fs {
                            c.s.push(' ');
                        }
                        c.s.push_str(&g.text);
                        c.len += gap + adv;
                        continue;
                    }
                }
                flush(&mut cur, h, &mut items);
                cur = Some(Cur {
                    s: g.text.clone(),
                    ox: o[0],
                    oy: o[1],
                    dir: d,
                    fs,
                    len: adv,
                });
            }
            flush(&mut cur, h, &mut items);
        }
        pages.push(Page {
            n: p + 1,
            width: w,
            height: h,
            items,
        });
    }
    let n = pages.len();
    eprintln!(
        "{{\"ms\":{},\"rssMb\":{}}}",
        t.elapsed().as_secs_f64() * 1000.0,
        rss_mb()
    );
    println!(
        "{}",
        serde_json::to_string(&Out {
            pages,
            page_count: n
        })
        .unwrap()
    );
}

fn rss_mb() -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok())
        })
        .unwrap_or(0.0)
        / 1024.0
}
