//! The app ends with exit status 0 and no PANIC in its log, for the fixtures and for the real service (the exit path:
//! the service stops its worker before `main` returns; nothing is joined in a destructor at process exit). Linux only; it
//! needs a display (or `xvfb-run`) and is skipped without one.
#![cfg(target_os = "linux")]
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn have_xvfb() -> bool {
    Command::new("xvfb-run").arg("--help").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok()
}

/// Runs the app with `extra` arguments and returns its exit code and log. Killed after two minutes.
fn run(dir: &Path, name: &str, extra: &[&str]) -> (Option<i32>, String) {
    let log = dir.join(format!("{name}.log"));
    let mut cmd = if std::env::var_os("DISPLAY").is_some() {
        Command::new(env!("CARGO_BIN_EXE_kasboek"))
    } else {
        let mut c = Command::new("xvfb-run");
        c.arg("-a").arg(env!("CARGO_BIN_EXE_kasboek"));
        c
    };
    let mut child = cmd
        .arg("--data-dir")
        .arg(dir.join(format!("{name}-data")))
        .arg("--log")
        .arg(&log)
        .args(["--exit-after-ms", "1500"])
        .args(extra)
        .env_remove("KASBOEK_DATA_DIR")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status.code();
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    (status, std::fs::read_to_string(log).unwrap_or_default())
}

fn check(name: &str, extra: &[&str]) {
    if std::env::var_os("DISPLAY").is_none() && !have_xvfb() {
        eprintln!("skipped {name}: no display and no xvfb-run");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (code, log) = run(dir.path(), name, extra);
    assert_eq!(code, Some(0), "{name}: exit status; log:\n{log}");
    assert!(!log.contains("PANIC"), "{name}: panic in the log:\n{log}");
    for marker in ["event loop ended", "shutdown: stopping service", "shutdown: done"] {
        assert!(log.contains(marker), "{name}: missing {marker:?}; log:\n{log}");
    }
}

#[test]
fn the_fixtures_exit_cleanly() {
    check("fixture", &["--service", "fixture"]);
    check("fixture-unlocked", &["--service", "fixture", "--state", "unlocked"]);
}

#[test]
fn the_real_service_exits_cleanly() {
    check("core", &["--service", "core"]);
    check("core-temp", &["--service", "core-temp", "--state", "unlocked"]);
}
