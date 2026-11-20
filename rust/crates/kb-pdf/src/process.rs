//! The reader as a process of its own, one file per process (src/main/pdf/run.ts, reader-process.ts, protocol.ts).
//!
//! * `run_reader_process()` is the child side: the app calls it first thing when it is started with `--pdf-reader`. It
//!   reads the PDF bytes from stdin until the end, writes one JSON object per line to stdout (`{"progress":{...}}` per
//!   page, then `{"ok":true,"result":PdfText}` or `{"ok":false,"code":...,"message":...}`) and ends. It turns the memory
//!   cap on (`cap`), keeps a 60 s deadline, and answers a panic, whatever the panic strategy, as `import.pdf_broken`.
//! * `read_pdf_in_child` is the parent side: starts the child, feeds it the bytes, checks every answer like `isPdfText`
//!   does, enforces the timeout and the cancel flag, and kills the child in every case.
use crate::model::*;
use crate::reader::{read, DeadlineHit};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The argument that starts the app as the reader process.
pub const READER_ARG: &str = "--pdf-reader";
/// A deep page tree or content stream needs more stack than a default thread has.
pub const STACK_BYTES: usize = 64 * 1024 * 1024;

fn write_line(line: &[u8]) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

/// Writes the failure answer for `e` and ends the process (also called by the memory cap).
pub fn answer_and_exit(e: ReadError) -> ! {
    let msg = serde_json::json!({ "ok": false, "code": e.code(), "message": e.message() });
    write_line(msg.to_string().as_bytes());
    std::process::exit(0);
}

fn write_result(t: &PdfText) {
    let mut line = br#"{"ok":true,"result":"#.to_vec();
    if serde_json::to_writer(&mut line, t).is_err() {
        answer_and_exit(ReadError::Broken);
    }
    line.push(b'}');
    write_line(&line);
}

/// The memory cap and the deadline. The `parity` build (dev driver, never shipped) may lower them with KB_PDF_CAP_BYTES and
/// KB_PDF_TIMEOUT_MS, so that the tests can reach them quickly.
fn limits() -> (usize, Duration) {
    let (mut cap, mut timeout) = (crate::cap::CAP_BYTES, Duration::from_millis(TIMEOUT_MS));
    if cfg!(feature = "parity") {
        let env = |name: &str| std::env::var(name).ok().and_then(|v| v.parse::<u64>().ok());
        cap = env("KB_PDF_CAP_BYTES").map_or(cap, |v| v as usize);
        timeout = env("KB_PDF_TIMEOUT_MS").map_or(timeout, Duration::from_millis);
    }
    (cap, timeout)
}

/// The child side. Does not return: the process ends with exit code 0 after its answer.
pub fn run_reader_process() {
    let (cap, timeout) = limits();
    crate::cap::enable(cap);
    // The hook runs before the unwind or the abort, so a panic is answered with either strategy.
    std::panic::set_hook(Box::new(|info| {
        answer_and_exit(if info.payload().is::<DeadlineHit>() { ReadError::TooLarge } else { ReadError::Broken });
    }));
    let mut bytes = Vec::new();
    if std::io::stdin().lock().take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).is_err() {
        answer_and_exit(ReadError::Broken);
    }
    // The worker's own clock stands a second behind the watchdog below, which is the one that answers.
    let deadline = Instant::now() + timeout + Duration::from_secs(1);
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new().stack_size(STACK_BYTES).spawn(move || {
        let r = read(bytes, deadline, &mut |page, pages| {
            write_line(format!("{{\"progress\":{{\"page\":{page},\"pages\":{pages}}}}}").as_bytes())
        });
        let _ = tx.send(r.map(|(t, _)| t));
    });
    if spawned.is_err() {
        answer_and_exit(ReadError::Broken);
    }
    match rx.recv_timeout(timeout) {
        Ok(Ok(t)) => write_result(&t),
        Ok(Err(e)) => answer_and_exit(e),
        Err(_) => answer_and_exit(ReadError::TooLarge),
    }
    std::process::exit(0);
}

/// A failed read: the error code of protocol.ts or `import.pdf_cancelled`, and the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfError {
    pub code: String,
    pub message: String,
}

impl PdfError {
    fn new(code: &str, message: &str) -> Self {
        PdfError { code: code.into(), message: message.into() }
    }
}

impl std::fmt::Display for PdfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for PdfError {}

pub struct ChildOptions<'a> {
    /// Wall-clock limit (`READ_TIMEOUT_MS`).
    pub timeout: Duration,
    /// Set from another thread to stop the read (Cancel, or the app locking): answered as `import.pdf_cancelled`.
    pub cancel: Option<&'a AtomicBool>,
    /// Called with (page, pages) as the child reads.
    pub on_page: Option<&'a mut dyn FnMut(usize, usize)>,
}

impl Default for ChildOptions<'_> {
    fn default() -> Self {
        ChildOptions { timeout: Duration::from_millis(TIMEOUT_MS), cancel: None, on_page: None }
    }
}

/// Reads `bytes` in `exe --pdf-reader` (the app's own executable). The environment of the child is empty and its
/// error output is dropped, as in read.ts. The child is killed in every case.
pub fn read_pdf_in_child(exe: &Path, bytes: &[u8], mut opts: ChildOptions<'_>) -> Result<PdfText, PdfError> {
    let crashed = || {
        PdfError::new(
            "import.pdf_broken",
            "The PDF could not be read: the reader stopped unexpectedly. The file may be damaged or too large.",
        )
    };
    let mut child = Command::new(exe)
        .arg(READER_ARG)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| crashed())?;
    let result = std::thread::scope(|scope| {
        let mut stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        // The child may answer (a refusal) before it has read everything: a failed write is not an error by itself.
        scope.spawn(move || {
            let _ = stdin.write_all(bytes);
        });
        let (tx, rx) = mpsc::channel::<Option<String>>();
        scope.spawn(move || {
            let mut lines = BufReader::new(stdout.take(MAX_BYTES as u64 * 2));
            loop {
                let mut line = String::new();
                match lines.read_line(&mut line) {
                    Ok(0) | Err(_) => return drop(tx.send(None)),
                    Ok(_) => {
                        if tx.send(Some(line)).is_err() {
                            return;
                        }
                    }
                }
            }
        });
        let started = Instant::now();
        let outcome = loop {
            if opts.cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                break Err(PdfError::new("import.pdf_cancelled", "Reading the PDF was cancelled."));
            }
            let left = opts.timeout.saturating_sub(started.elapsed());
            if left.is_zero() {
                break Err(PdfError::new("import.pdf_too_large", "Reading this PDF took too long. Try a PDF of one statement."));
            }
            match rx.recv_timeout(left.min(Duration::from_millis(50))) {
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => break Err(crashed()),
                Ok(Some(line)) => match serde_json::from_str::<ReaderMessage>(&line) {
                    Err(_) => {
                        break Err(PdfError::new("import.pdf_broken", "The PDF could not be read: the reader gave an unusable answer."))
                    }
                    Ok(ReaderMessage::Progress { progress }) => {
                        if !(1..=MAX_PAGES).contains(&progress.page) || !(1..=MAX_PAGES).contains(&progress.pages) {
                            break Err(PdfError::new(
                                "import.pdf_broken",
                                "The PDF could not be read: the reader gave an unusable answer.",
                            ));
                        }
                        if let Some(f) = opts.on_page.as_mut() {
                            f(progress.page, progress.pages)
                        }
                    }
                    Ok(ReaderMessage::Ok { result, .. }) if is_valid_pdf_text(&result) => break Ok(result),
                    Ok(ReaderMessage::Ok { .. }) => {
                        break Err(PdfError::new("import.pdf_broken", "The PDF could not be read: the reader gave an unusable answer."))
                    }
                    Ok(ReaderMessage::Failed { code, message, .. }) => match ReadError::from_code(&code) {
                        Some(_) if message.chars().count() <= 500 => break Err(PdfError { code, message }),
                        _ => {
                            break Err(PdfError::new("import.pdf_broken", "The PDF could not be read: the reader gave an unusable answer."))
                        }
                    },
                },
            }
        };
        // Ends the child, which closes its pipes and so lets the two helper threads finish.
        let _ = child.kill();
        let _ = child.wait();
        outcome
    });
    result
}
