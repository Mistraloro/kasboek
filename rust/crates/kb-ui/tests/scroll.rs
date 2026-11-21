//! Scrolling a 500,000-row table: the frame time while the `DataTable` creates the rows in view from a `PagedModel`
//! (software renderer, 760 x 420, one frame = layout + row creation + paint), and the cost of reading a page. The
//! numbers of the last run are in the README. Budgets: 16 ms per frame in a release build (the exit test of page P1);
//! a debug build is only checked to be in the same order of magnitude.
use kb_ui::{shot, DateCheck, Gallery, Rules, TableDemo};
use slint::{ComponentHandle, Model};
use std::time::{Duration, Instant};

const ROWS: usize = 500_000;
const ROW_H: f32 = 41.0;

fn percentile(samples: &mut [Duration], p: f64) -> Duration {
    samples.sort();
    samples[((samples.len() as f64 * p).ceil() as usize).clamp(1, samples.len()) - 1]
}

#[test]
fn scrolling_500k_rows_stays_cheap() {
    let window = shot::install();
    let ui = Gallery::new().unwrap();
    kb_ui::wire_rules!(&ui);
    let demo = kb_ui::demo::wire(&ui, ROWS);
    ui.set_case("datatable-live".into());
    let opened = Instant::now();
    shot::open(&window, &ui, 760, 420, 1.0);
    shot::pixels(&window);
    let first_frame = opened.elapsed();
    let t = ui.global::<TableDemo>();
    // A debug build paints about ten times slower: fewer frames keep the test short.
    let frames = if cfg!(debug_assertions) { 1 } else { 5 };
    let budget = if cfg!(debug_assertions) { Duration::from_millis(250) } else { Duration::from_millis(16) };

    // Wheel-like: one row at a time over a stretch of rows, then 3 rows per frame (a fast wheel or a touchpad fling).
    let mut slow = Vec::new();
    let mut y = 0.0_f32;
    for _ in 0..60 * frames {
        y -= ROW_H;
        let start = Instant::now();
        t.set_scroll_y(y);
        shot::pixels(&window);
        slow.push(start.elapsed());
    }
    let mut fast = Vec::new();
    for _ in 0..100 * frames {
        y -= 3.0 * ROW_H;
        let start = Instant::now();
        t.set_scroll_y(y);
        shot::pixels(&window);
        fast.push(start.elapsed());
    }
    // Scrollbar drags and "End": far jumps, so almost every frame reads a page it does not have.
    let mut jumps = Vec::new();
    let mut seed = 12_345_u64;
    for _ in 0..40 * frames {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let row = (seed >> 33) as usize % (ROWS - 20);
        let start = Instant::now();
        t.set_scroll_y(-(row as f32) * ROW_H);
        shot::pixels(&window);
        jumps.push(start.elapsed());
    }
    // The last rows are reachable and cached after the jump to the end.
    t.set_scroll_y(-(ROWS as f32 * ROW_H - 330.0));
    shot::pixels(&window);
    let fetches = demo.model.fetches();
    assert!(demo.model.row_data(ROWS - 1).is_some());
    assert_eq!(demo.model.fetches(), fetches, "the last page is in memory after scrolling to the end");
    assert!(demo.model.cached_pages() <= kb_ui::paged::MAX_PAGES);

    // Cost of the data side alone: reading and building one page of 200 rows.
    let mut reads = Vec::new();
    for page in 0..50 {
        demo.model.invalidate();
        let start = Instant::now();
        let _ = demo.model.row_data(page * 7919 % 2500 * kb_ui::paged::PAGE_SIZE);
        reads.push(start.elapsed());
    }

    let report = |name: &str, s: &mut Vec<Duration>| {
        let (p50, p95, max) = (percentile(s, 0.5), percentile(s, 0.95), *s.iter().max().unwrap());
        println!("{name:<28} frames {:>4}  p50 {p50:>9.2?}  p95 {p95:>9.2?}  max {max:>9.2?}", s.len());
        p95
    };
    println!("profile: {}; first frame {first_frame:.2?}", if cfg!(debug_assertions) { "debug" } else { "release" });
    let p95_slow = report("1 row per frame", &mut slow);
    let p95_fast = report("3 rows per frame", &mut fast);
    let p95_jump = report("jump to a random place", &mut jumps);
    report("read one page (200 rows)", &mut reads);
    for (name, p95) in [("1 row", p95_slow), ("3 rows", p95_fast), ("jump", p95_jump)] {
        assert!(p95 <= budget, "{name}: p95 {p95:?} over the budget {budget:?}");
    }
}

#[allow(dead_code)]
fn _types(_: DateCheck, _: Rules) {}
