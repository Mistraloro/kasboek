//! The reader process (`--pdf-reader` of the dev driver, which installs the memory cap like the app does) and the parent side that talks to
//! it: answers, progress, errors, timeout, cancel, the memory cap on a decompression bomb and the deadline on work that never ends.
//! Run with `cargo test -p kb-pdf --features parity`.
mod support;
use kb_pdf::*;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use support::*;

const EXE: &str = env!("CARGO_BIN_EXE_kb-pdf-cli");

fn exe() -> &'static std::path::Path {
    std::path::Path::new(EXE)
}

fn in_child(bytes: &[u8]) -> Result<PdfText, PdfError> {
    read_pdf_in_child(exe(), bytes, ChildOptions::default())
}

/// Runs the reader process by hand with the given environment; returns its stdout lines and the exit code.
fn raw(bytes: &[u8], env: &[(&str, &str)]) -> (Vec<String>, i32, Duration) {
    let started = Instant::now();
    let mut child = Command::new(EXE)
        .arg("--pdf-reader")
        .env_clear()
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let data = bytes.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&data);
    });
    let out = child.wait_with_output().unwrap();
    let _ = writer.join();
    let lines = String::from_utf8_lossy(&out.stdout).lines().map(String::from).collect();
    (lines, out.status.code().unwrap_or(-1), started.elapsed())
}

#[test]
fn reads_a_statement_in_a_process_of_its_own_and_reports_progress() {
    let bytes = make_pdf(&statement_pages(), &Opts::default());
    let mut seen: Vec<(usize, usize)> = Vec::new();
    let mut on_page = |page: usize, pages: usize| seen.push((page, pages));
    let text = read_pdf_in_child(exe(), &bytes, ChildOptions { on_page: Some(&mut on_page), ..ChildOptions::default() }).unwrap();
    assert_eq!(seen, vec![(1, 3), (2, 3), (3, 3)]);
    let (direct, _) = read_guarded(bytes, Duration::from_secs(60)).unwrap();
    assert_eq!(text, direct);
}

#[test]
fn failures_come_back_as_the_error_codes_of_the_protocol() {
    assert_eq!(
        in_child(&make_pdf(&statement_pages(), &Opts { encrypted: true, ..Opts::default() })).unwrap_err().code,
        "import.pdf_password"
    );
    assert_eq!(in_child(b"a,b\n1,2\n").unwrap_err().code, "import.pdf_broken");
    assert_eq!(in_child(&make_pdf(&[PageSpec::default()], &Opts::default())).unwrap_err().code, "import.pdf_scanned");
    let e = in_child(&make_pdf(&[PageSpec::default()], &Opts::default())).unwrap_err();
    assert_eq!(e.message, ReadError::Scanned.message());
    let page = PageSpec { texts: vec![t(40.0, 700.0, "Hello limits, this is a long enough text for a page")], ..PageSpec::default() };
    assert_eq!(in_child(&make_pdf(&vec![page; MAX_PAGES + 1], &Opts::default())).unwrap_err().code, "import.pdf_too_large");
}

#[test]
fn the_process_ends_after_its_answer_with_exit_code_zero_and_one_json_object_per_line() {
    let (lines, code, _) = raw(&make_pdf(&statement_pages(), &Opts::default()), &[]);
    assert_eq!(code, 0);
    assert_eq!(lines.len(), 4, "{lines:?}");
    for l in &lines[..3] {
        assert!(l.starts_with("{\"progress\":{\"page\":"), "{l}");
    }
    assert!(lines[3].starts_with("{\"ok\":true,\"result\":{\"pages\":["));
    let (lines, code, _) = raw(b"not a pdf", &[]);
    assert_eq!((code, lines.len()), (0, 1));
    assert!(lines[0].starts_with("{\"ok\":false,\"code\":\"import.pdf_broken\""));
    let (lines, code, _) = raw(b"", &[]);
    assert_eq!((code, lines.len()), (0, 1));
}

#[test]
fn a_zero_timeout_and_a_cancel_flag_stop_the_read_and_end_the_child() {
    let bytes = make_pdf(&statement_pages(), &Opts::default());
    let e = read_pdf_in_child(exe(), &bytes, ChildOptions { timeout: Duration::ZERO, ..ChildOptions::default() }).unwrap_err();
    assert_eq!(e.code, "import.pdf_too_large");
    let cancel = AtomicBool::new(true);
    let e = read_pdf_in_child(exe(), &bytes, ChildOptions { cancel: Some(&cancel), ..ChildOptions::default() }).unwrap_err();
    assert_eq!(e.code, "import.pdf_cancelled");
    cancel.store(false, Ordering::Relaxed);
    assert!(read_pdf_in_child(exe(), &bytes, ChildOptions { cancel: Some(&cancel), ..ChildOptions::default() }).is_ok());
}

#[test]
fn a_decompression_bomb_hits_the_memory_cap() {
    // 256 MiB of zeros in one content stream, a few hundred KB deflated; the cap is lowered to 64 MiB for the test (1 GiB in the app).
    let bomb = make_pdf(&[PageSpec::default()], &Opts { flate: true, filler: Some(256 * 1024 * 1024), ..Opts::default() });
    assert!(bomb.len() < 2 * 1024 * 1024, "{}", bomb.len());
    let (lines, code, took) = raw(&bomb, &[("KB_PDF_CAP_BYTES", &(64 * 1024 * 1024).to_string())]);
    assert_eq!(code, 0);
    assert_eq!(
        lines.last().map(String::as_str),
        Some(format!("{{\"ok\":false,\"code\":\"import.pdf_too_large\",\"message\":{:?}}}", ReadError::TooLarge.message()).as_str())
    );
    assert!(took < Duration::from_secs(20), "{took:?}");
}

/// A page whose form draws two forms that draw two forms ... 30 levels deep: 2^30 draws unless the work is stopped.
fn exponential_forms() -> Vec<u8> {
    let mut objs: Vec<String> = Vec::new();
    for i in 0..30 {
        let body = "/N Do /N Do BT /F1 8 Tf 40 600 Td (x) Tj ET";
        objs.push(format!(
            "{} 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> /XObject << /N {} 0 R >> >> /Length {} >>\nstream\n{}\nendstream\nendobj\n",
            20 + i,
            21 + i,
            body.len(),
            body
        ));
    }
    objs.push("50 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 600 800] /Length 0 >>\nstream\n\nendstream\nendobj\n".to_string());
    let content = "/N Do\nBT /F1 10 Tf 40 700 Td (Hello hostile world, this is a long enough text for a page) Tj ET\n";
    let mut out = String::from("%PDF-1.4\n");
    out += "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
    out += "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> /XObject << /N 20 0 R >> >> /Contents 5 0 R >>\nendobj\n";
    out += &format!("5 0 obj\n<< /Length {} >>\nstream\n{}endstream\nendobj\n", content.len(), content);
    for o in objs {
        out += &o;
    }
    out += "trailer\n<< /Root 1 0 R /Size 60 >>\n%%EOF\n";
    out.into_bytes()
}

#[test]
fn work_that_never_ends_is_stopped_at_the_deadline() {
    let (lines, code, took) = raw(&exponential_forms(), &[("KB_PDF_TIMEOUT_MS", "1500")]);
    assert_eq!(code, 0);
    assert!(lines.last().unwrap().contains("\"code\":\"import.pdf_too_large\""), "{lines:?}");
    assert!(took < Duration::from_secs(10), "{took:?}");
}
