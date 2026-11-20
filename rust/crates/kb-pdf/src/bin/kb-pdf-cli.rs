//! Dev-only driver of the parity suite (rust/parity/pdf.spec.ts); built with `--features parity`, never shipped.
//!
//! * `kb-pdf-cli read FILE`: reads a PDF in this process (like the spike did) and prints `PdfText` as JSON, or
//!   `{"error": code}`; `{"ms","rssMb"}` goes to stderr. `KB_PDF_TIMEOUT_MS` shortens the deadline.
//! * `kb-pdf-cli child FILE`: the same through the reader process (`--pdf-reader` of this binary), the way the app does it.
//! * `kb-pdf-cli --pdf-reader`: the reader process itself (stdin PDF bytes, stdout JSON lines), with the memory cap.
//! * `kb-pdf-cli logic [OWN_IBAN]`: stdin is a `PdfText` JSON; prints `{lines, statement, analysis, send}`: the lines and cells,
//!   the statement read, the import input and the text that would go to the assistant (or the refusal).
//! * `kb-pdf-cli send`: stdin is a `PdfLine[]` JSON; prints the assistant preview and the text of each part, or the refusal.
//! * `kb-pdf-cli reconcile`: stdin `{"rows":[{"amountCents","balanceCents"}],"balances":{"opening","closing"}}`; prints the
//!   reconciliation and its banner.
use kb_pdf::ReadError;
use serde_json::json;
use std::io::Read;
use std::time::{Duration, Instant};

#[global_allocator]
static ALLOC: kb_pdf::cap::CappedAlloc = kb_pdf::cap::CappedAlloc;

fn peak_rss_mb() -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok()))
        .unwrap_or(0.0)
        / 1024.0
}

fn stdin_text() -> String {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).expect("stdin");
    s
}

fn error_json(e: ReadError) -> String {
    json!({ "error": e.code() }).to_string()
}

/// The preview and the text of every part that would be sent for these lines, or the refusal.
fn send_json(lines: &[kb_pdf::PdfLine]) -> serde_json::Value {
    match kb_pdf::preview_text(lines) {
        Ok(p) => {
            let masked = kb_pdf::lines_to_send(lines);
            let parts: Vec<String> = kb_pdf::split_parts(&masked).iter().map(kb_pdf::part_text).collect();
            json!({ "preview": p, "parts": parts })
        }
        Err(e) => json!({ "error": { "code": e.code, "message": e.message } }),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some(kb_pdf::process::READER_ARG) => kb_pdf::run_reader_process(),
        Some("read") => {
            let started = Instant::now();
            let timeout =
                Duration::from_millis(std::env::var("KB_PDF_TIMEOUT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(kb_pdf::TIMEOUT_MS));
            // A panic (a deadline hit or a bug) is answered here, so the result is the same with `panic = "abort"` (release).
            let show = std::env::var_os("KB_PDF_SHOW_PANICS").is_some();
            std::panic::set_hook(Box::new(move |info| {
                if show {
                    eprintln!("{info}");
                }
                println!(
                    "{}",
                    error_json(if info.payload().is::<kb_pdf::reader::DeadlineHit>() { ReadError::TooLarge } else { ReadError::Broken })
                );
                std::process::exit(0);
            }));
            let out = match std::fs::read(&args[1]) {
                Ok(b) if kb_pdf::is_pdf(&b) => match kb_pdf::read_guarded(b, timeout) {
                    Ok((t, stats)) => {
                        eprintln!("{}", json!({ "recoveredGlyphs": stats.recovered_glyphs }));
                        serde_json::to_string(&t).expect("json")
                    }
                    Err(e) => error_json(e),
                },
                _ => error_json(ReadError::Broken),
            };
            eprintln!("{}", json!({ "ms": started.elapsed().as_secs_f64() * 1000.0, "rssMb": peak_rss_mb() }));
            println!("{out}");
            // A worker thread that is past its deadline may still be running: end the process, do not wait for it.
            std::process::exit(0);
        }
        Some("child") => {
            let started = Instant::now();
            let bytes = std::fs::read(&args[1]).expect("file");
            let exe = std::env::current_exe().expect("exe");
            let out = match kb_pdf::read_pdf_in_child(&exe, &bytes, kb_pdf::ChildOptions::default()) {
                Ok(t) => serde_json::to_string(&t).expect("json"),
                Err(e) => json!({ "error": e.code }).to_string(),
            };
            eprintln!("{}", json!({ "ms": started.elapsed().as_secs_f64() * 1000.0 }));
            println!("{out}");
        }
        Some("logic") => {
            let text: kb_pdf::PdfText = serde_json::from_str(&stdin_text()).expect("PdfText json");
            let own = args.get(1).map(String::as_str);
            let lines = kb_pdf::to_lines(&text);
            let statement = kb_pdf::read_statement(&lines, own);
            let analysis = kb_pdf::analyze_pdf(&text, own);
            let send = send_json(&lines);
            println!("{}", json!({ "lines": lines, "statement": statement, "analysis": analysis, "send": send }));
        }
        Some("send") => {
            let lines: Vec<kb_pdf::PdfLine> = serde_json::from_str(&stdin_text()).expect("lines json");
            println!("{}", send_json(&lines));
        }
        Some("reconcile") => {
            #[derive(serde::Deserialize)]
            struct Row {
                #[serde(rename = "amountCents")]
                amount: Option<i64>,
                #[serde(rename = "balanceCents")]
                balance: Option<i64>,
            }
            #[derive(serde::Deserialize)]
            struct Input {
                rows: Vec<Row>,
                balances: kb_pdf::statement::StatementBalances,
            }
            let input: Input = serde_json::from_str(&stdin_text()).expect("input json");
            let rows: Vec<_> =
                input.rows.iter().map(|r| kb_import::statement::Amounts { amount_cents: r.amount, balance_cents: r.balance }).collect();
            let r = kb_import::statement::reconcile(&rows, input.balances);
            let banner = kb_pdf::reconciliation_banner(Some(&r));
            println!("{}", json!({ "reconciliation": r, "banner": banner }));
        }
        _ => {
            eprintln!("usage: kb-pdf-cli read|child FILE | --pdf-reader | logic [OWN_IBAN] | reconcile");
            std::process::exit(2);
        }
    }
}
