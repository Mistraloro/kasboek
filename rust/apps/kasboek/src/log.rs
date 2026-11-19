//! startup.log in the style of the app's (src/main/startup-plan.ts), moved here from the UI spike (rust/spike/ui/src/log.rs): `{ms} ms  {text}`, at most 200 lines per run,
//! the log of the previous run kept as startup.prev.log. Times count from the OS creation time of the process where
//! the OS tells it (Windows, Linux, macOS), otherwise from `main`. Safe to call from any thread.
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const MAX_LINES: usize = 200;

struct Log {
    t0: Instant,
    /// Milliseconds between the creation of the process and `main`, when the OS knows it.
    before_main_ms: Option<f64>,
    lines: Vec<String>,
    written: usize,
    file: Option<PathBuf>,
}

static LOG: OnceLock<Mutex<Log>> = OnceLock::new();

/// Starts the log. `file` is where lines go: None keeps them in memory only. When `rotate` is set the previous
/// log is moved to startup.prev.log first.
pub fn init(t0: Instant, before_main_ms: Option<f64>, file: Option<PathBuf>, rotate: bool) {
    if let Some(f) = &file {
        // Never fails the start: the log is a convenience.
        if rotate && f.exists() {
            let _ = std::fs::rename(f, f.with_file_name("startup.prev.log"));
        }
        let _ = std::fs::write(f, "");
    }
    let _ = LOG.set(Mutex::new(Log { t0, before_main_ms, lines: vec![], written: 0, file }));
}

/// Milliseconds since the process started (or since `main` when the OS does not tell).
pub fn now_ms() -> f64 {
    let Some(m) = LOG.get() else { return 0.0 };
    let l = m.lock().unwrap_or_else(|e| e.into_inner());
    l.t0.elapsed().as_secs_f64() * 1000.0 + l.before_main_ms.unwrap_or(0.0)
}

pub fn mark(what: &str) {
    let Some(m) = LOG.get() else { return };
    let mut l = m.lock().unwrap_or_else(|e| e.into_inner());
    if l.lines.len() >= MAX_LINES {
        return;
    }
    let ms = l.t0.elapsed().as_secs_f64() * 1000.0 + l.before_main_ms.unwrap_or(0.0);
    let line = format!("{ms:6.0} ms  {what}");
    // KASBOEK_STARTUP_TRACE=1: print each milestone as it happens (also shows where a start hangs).
    if std::env::var_os("KASBOEK_STARTUP_TRACE").is_some() {
        eprintln!("{line}");
    }
    l.lines.push(line);
}

/// Appends the lines that are not in the file yet. Called after the first frame, after a device answer and at the end.
pub fn flush() {
    let Some(m) = LOG.get() else { return };
    let mut l = m.lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = l.file.clone() else { return };
    if l.written >= l.lines.len() {
        return;
    }
    let text = l.lines[l.written..].join("\n") + "\n";
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(path) {
        if f.write_all(text.as_bytes()).is_ok() {
            l.written = l.lines.len();
        }
    }
}

/// The path of startup.log next to the running binary.
pub fn default_path() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.join("startup.log"))
}

/// Milliseconds since the OS created this process, if the OS tells.
#[cfg(windows)]
pub fn ms_since_process_creation() -> Option<f64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let ticks = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    let (mut created, mut a, mut b, mut c) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: plain out-parameters on our own stack; the pseudo handle of the current process needs no closing.
    unsafe {
        GetProcessTimes(GetCurrentProcess(), &mut created, &mut a, &mut b, &mut c).ok()?;
        let now = ticks(GetSystemTimePreciseAsFileTime());
        // FILETIME counts 100 ns steps.
        Some(now.checked_sub(ticks(created))? as f64 / 10_000.0)
    }
}

#[cfg(target_os = "linux")]
pub fn ms_since_process_creation() -> Option<f64> {
    // Field 22 of /proc/self/stat is the start time in clock ticks since boot (100 per second on every common kernel).
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let after_name = stat.rsplit_once(')')?.1;
    let start_ticks: f64 = after_name.split_whitespace().nth(19)?.parse().ok()?;
    let uptime: f64 = std::fs::read_to_string("/proc/uptime").ok()?.split_whitespace().next()?.parse().ok()?;
    Some((uptime - start_ticks / 100.0) * 1000.0)
}

#[cfg(target_os = "macos")]
pub fn ms_since_process_creation() -> Option<f64> {
    // proc_pidinfo(PROC_PIDTBSDINFO) has the start time of the process as seconds and microseconds since the epoch.
    // SAFETY: `info` is a plain C struct that the call fills; the size passed is its size.
    let info = unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let got = libc::proc_pidinfo(libc::getpid(), libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size);
        if got != size {
            return None;
        }
        info
    };
    let started = info.pbi_start_tvsec as f64 * 1000.0 + info.pbi_start_tvusec as f64 / 1000.0;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0;
    Some((now - started).max(0.0))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn ms_since_process_creation() -> Option<f64> {
    None
}
