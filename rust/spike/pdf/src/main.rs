//! `kb-spike-pdf [backend] FILE`: reads a PDF and prints PdfText as JSON on stdout (or {"error": code}); a JSON line with
//! the time and peak memory goes to stderr. Panics and hangs are contained: the work runs on its own thread under
//! catch_unwind with a 60 s deadline, like the reader process in src/main/pdf/run.ts.
mod cap;
mod model;
mod reader;

#[global_allocator]
static ALLOC: cap::Capped = cap::Capped;

use model::*;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn peak_rss_mb() -> f64 {
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

fn main() {
    let path = std::env::args()
        .next_back()
        .expect("usage: kb-spike-pdf [backend] FILE");
    let started = Instant::now();
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return println!("{{\"error\":\"{}\"}}", ReadError::Broken.code()),
    };
    if !(bytes.len() >= 5 && &bytes[..5] == b"%PDF-") {
        return println!("{{\"error\":\"{}\"}}", ReadError::Broken.code());
    }
    let timeout = Duration::from_millis(
        std::env::var("KB_PDF_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(TIMEOUT_MS),
    );
    let deadline = started + timeout;
    // A deadline hit inside the interpreter unwinds with a `reader::DeadlineHit`; nothing else is worth a message.
    if std::env::var_os("KB_PDF_SHOW_PANICS").is_none() {
        std::panic::set_hook(Box::new(|_| {}));
    }
    let (tx, rx) = mpsc::channel();
    // A deep page tree or content stream needs more stack than a default thread has.
    std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(move || {
            let r = std::panic::catch_unwind(|| reader::read(bytes, deadline));
            let _ = tx.send(match r {
                Ok(r) => r,
                Err(p) if p.is::<reader::DeadlineHit>() => Err(ReadError::TooLarge),
                Err(_) => Err(ReadError::Broken),
            });
        })
        .expect("thread");
    let result = match rx.recv_timeout(timeout + Duration::from_millis(500)) {
        Ok(r) => r,
        Err(_) => Err(ReadError::TooLarge),
    };
    eprintln!(
        "{{\"ms\":{},\"rssMb\":{}}}",
        started.elapsed().as_secs_f64() * 1000.0,
        peak_rss_mb()
    );
    match result {
        Ok(t) => println!("{}", serde_json::to_string(&t).unwrap()),
        Err(e) => println!("{{\"error\":\"{}\"}}", e.code()),
    }
    // The worker thread may still be running after a timeout: end the process, do not wait for it.
    std::process::exit(0);
}
