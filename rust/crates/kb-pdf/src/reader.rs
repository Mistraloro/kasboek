//! Reads the text of a PDF into `PdfText` with hayro (a pure-Rust PDF parser and content-stream interpreter): one
//! glyph at a time through a `Device`, then glyphs are merged into text pieces by the rules pdf.js uses, so the
//! pieces are about the ones src/core/pdf/extract.ts gets from pdf.js. Limits, error codes and page geometry (turned
//! pages, crop box) are those of extract.ts.
use crate::model::*;
use crate::recover::Recover;
use hayro_interpret::font::{Glyph, GlyphRun};
use hayro_interpret::hayro_cmap::BfString;
use hayro_interpret::hayro_syntax::object::Dict;
use hayro_interpret::{
    interpret_page, BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageDrawProps, InterpreterCache,
    InterpreterSettings, SoftMask,
};
use hayro_syntax::{LoadPdfError, Pdf};
use kurbo::{Affine, BezPath, Point};
use std::time::Instant;

/// pdf.js thresholds, as a share of the font size (see `buildTextContentItem` in pdf.js).
const TRACKING_SPACE: f64 = 0.102;
const NEGATIVE_SPACE: f64 = -0.2;
const SPACE_IN_FLOW_MAX: f64 = 0.6;
const VERTICAL_SHIFT_RATIO: f64 = 0.25;

/// Panic payload that ends a page that takes too long (caught by `read_guarded`; the reader process has its own watchdog).
pub struct DeadlineHit;

struct Run {
    s: String,
    ox: f64,
    oy: f64,
    dx: f64,
    dy: f64,
    fs: f64,
    len: f64,
}

/// Collects glyphs in view space (y down, rotation applied) into text pieces.
struct TextDevice {
    cur: Option<Run>,
    out: Vec<Run>,
    width: f64,
    height: f64,
    chars: usize,
    over_limit: bool,
    deadline: Instant,
    calls: u32,
    recover: Recover,
    recovered: usize,
}

impl TextDevice {
    fn flush(&mut self) {
        if let Some(r) = self.cur.take() {
            self.chars += kb_rules::utf16_len(&r.s);
            if self.out.len() >= MAX_ITEMS || self.chars > MAX_CHARS {
                self.over_limit = true;
                return;
            }
            self.out.push(r);
        }
    }

    fn glyph(&mut self, text: &str, t: Affine, advance: f64) {
        if self.over_limit || text.trim().is_empty() {
            return;
        }
        let [a, b, c, d, e, f] = t.as_coeffs();
        // Glyph space has 1000 units to the em.
        let x_scale = a.hypot(b);
        let (adx, ady) = (x_scale * 1000.0, c.hypot(d) * 1000.0);
        if !(adx.is_finite() && ady.is_finite() && e.is_finite() && f.is_finite()) || adx == 0.0 || ady == 0.0 {
            return;
        }
        let (dx, dy) = (a / x_scale, b / x_scale);
        let fs = ady;
        // Glyphs outside the page are not text of the page (pdf.js drops them too).
        if e + fs < 0.0 || e - fs > self.width || f + fs < 0.0 || f - fs > self.height {
            return;
        }
        let len = advance * adx / 1000.0;
        if let Some(r) = self.cur.as_mut() {
            let (ex, ey) = (r.ox + r.dx * r.len, r.oy + r.dy * r.len);
            let along = (e - ex) * r.dx + (f - ey) * r.dy;
            let across = -(e - ex) * r.dy + (f - ey) * r.dx;
            let same_dir = dx * r.dx + dy * r.dy > 0.99;
            if same_dir
                && across.abs() <= VERTICAL_SHIFT_RATIO * r.fs.max(fs)
                && along >= NEGATIVE_SPACE * r.fs
                && along <= SPACE_IN_FLOW_MAX * r.fs
            {
                if along > TRACKING_SPACE * r.fs {
                    r.s.push(' ');
                }
                r.s.push_str(text);
                r.len += along + len;
                return;
            }
        }
        self.flush();
        self.cur = Some(Run { s: text.to_string(), ox: e, oy: f, dx, dy, fs, len });
    }

    /// The interpreter cannot be stopped from here except by unwinding: check the clock now and then.
    fn tick(&mut self) {
        self.calls = self.calls.wrapping_add(1);
        if self.calls.is_multiple_of(256) && Instant::now() > self.deadline {
            std::panic::panic_any(DeadlineHit);
        }
    }
}

/// A ligature written as its letters, as pdf.js normalises it.
fn letters(s: String) -> String {
    if s.chars().any(|c| ('\u{FB00}'..='\u{FB06}').contains(&c)) {
        s.chars()
            .map(|c| match c {
                '\u{FB00}' => "ff".to_string(),
                '\u{FB01}' => "fi".to_string(),
                '\u{FB02}' => "fl".to_string(),
                '\u{FB03}' => "ffi".to_string(),
                '\u{FB04}' => "ffl".to_string(),
                '\u{FB05}' | '\u{FB06}' => "st".to_string(),
                c => c.to_string(),
            })
            .collect()
    } else {
        s
    }
}

impl<'a> Device<'a> for TextDevice {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {
        self.tick()
    }
    fn push_clip_path(&mut self, _: &ClipPath) {
        self.tick()
    }
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_image(&mut self, _: Image<'a, '_>, _: ImageDrawProps<'a>) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}
    fn begin_marked_content(&mut self, _: &[u8], _: Option<&Dict<'_>>) {}
    fn end_marked_content(&mut self) {}

    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, _: &DrawMode) {
        self.tick();
        for g in run.glyphs() {
            let text = match g.as_unicode() {
                Some(BfString::Char(c)) => c.to_string(),
                Some(BfString::String(s)) => s,
                None => match &**g {
                    Glyph::Outline(o) => match self.recover.text(o) {
                        Some(s) => {
                            self.recovered += 1;
                            s
                        }
                        None => continue,
                    },
                    Glyph::Type3(_) => continue,
                },
            };
            let advance = match &**g {
                Glyph::Outline(o) => o.advance_width().map(f64::from).filter(|a| a.is_finite() && *a > 0.0).unwrap_or(500.0),
                Glyph::Type3(t) => t.advance_width().map(f64::from).filter(|a| a.is_finite() && *a >= 0.0).unwrap_or(500.0),
            };
            let t = props.transform * g.transform();
            let o = t * Point::ORIGIN;
            let mut m = t.as_coeffs();
            m[4] = o.x;
            m[5] = o.y;
            self.glyph(&letters(text), Affine::new(m), advance);
        }
    }
}

/// What the reader found besides the text: how many glyphs came from the font program (no `ToUnicode`).
#[derive(Debug, Default, Clone, Copy)]
pub struct ReadStats {
    pub recovered_glyphs: usize,
}

/// Reads a PDF. `on_page(n, pages)` is called after every page. May panic when `deadline` passes (see `read_guarded`).
pub fn read(bytes: Vec<u8>, deadline: Instant, on_page: &mut dyn FnMut(usize, usize)) -> Result<(PdfText, ReadStats), ReadError> {
    if bytes.len() > MAX_BYTES {
        return Err(ReadError::TooLarge);
    }
    let pdf = Pdf::new(bytes).map_err(|e| match e {
        LoadPdfError::Decryption(_) => ReadError::Password,
        LoadPdfError::Invalid => ReadError::Broken,
    })?;
    let pages = pdf.pages();
    if pages.len() > MAX_PAGES {
        return Err(ReadError::TooLarge);
    }
    let total = pages.len();
    let cache = InterpreterCache::new();
    let mut out = Vec::new();
    let (mut items, mut chars) = (0usize, 0usize);
    let mut stats = ReadStats::default();
    let mut recover = Recover::default();
    for (i, page) in pages.iter().enumerate() {
        if Instant::now() > deadline {
            return Err(ReadError::TooLarge);
        }
        let (w, h) = page.render_dimensions();
        let (w, h) = (f64::from(w), f64::from(h));
        let initial = Affine::new(page.initial_transform(true).as_coeffs());
        let mut ctx = Context::new(initial, kurbo::Rect::new(0.0, 0.0, w, h), &cache, page.xref(), InterpreterSettings::default());
        let mut dev = TextDevice {
            cur: None,
            out: Vec::new(),
            width: w,
            height: h,
            chars,
            over_limit: false,
            deadline,
            calls: 0,
            recover: std::mem::take(&mut recover),
            recovered: 0,
        };
        interpret_page(page, &mut ctx, &mut dev);
        dev.flush();
        if dev.over_limit {
            return Err(ReadError::TooLarge);
        }
        chars = dev.chars;
        items += dev.out.len();
        stats.recovered_glyphs += dev.recovered;
        if items > MAX_ITEMS || chars > MAX_CHARS {
            return Err(ReadError::TooLarge);
        }
        recover = dev.recover;
        let list = dev
            .out
            .into_iter()
            .map(|r| {
                // As in extract.ts: x is where the text starts as shown; text running leftwards starts at its far end.
                let x = if r.dx < 0.0 { r.ox - r.len } else { r.ox };
                Item { str: r.s, x, y: h - r.oy, w: r.len, h: r.fs }
            })
            .collect();
        out.push(Page { n: i + 1, width: w, height: h, items: list });
        on_page(i + 1, total);
    }
    if chars == 0 || chars / out.len().max(1) < MIN_CHARS_PER_PAGE {
        return Err(ReadError::Scanned);
    }
    let page_count = out.len();
    Ok((PdfText { pages: out, page_count }, stats))
}

/// `read` on a thread of its own (a deep page tree needs a bigger stack than a default thread has), with panics caught
/// and a deadline: a panic is `Broken`, a deadline hit `TooLarge`. Only for tests and the dev CLI (`parity`), which run with
/// `panic = "unwind"`; the reader process of the app uses `process::run_reader_process`, which also works with `panic = "abort"`.
#[cfg(any(test, feature = "parity"))]
pub fn read_guarded(bytes: Vec<u8>, timeout: std::time::Duration) -> Result<(PdfText, ReadStats), ReadError> {
    let deadline = Instant::now() + timeout;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .stack_size(crate::process::STACK_BYTES)
        .spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read(bytes, deadline, &mut |_, _| {})));
            let _ = tx.send(match r {
                Ok(r) => r,
                Err(p) if p.is::<DeadlineHit>() => Err(ReadError::TooLarge),
                Err(_) => Err(ReadError::Broken),
            });
        })
        .map_err(|_| ReadError::Broken)?;
    rx.recv_timeout(timeout + std::time::Duration::from_millis(500)).unwrap_or(Err(ReadError::TooLarge))
}
