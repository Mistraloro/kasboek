//! A build without the cargo feature `dev-start` (release builds) refuses the development flags.
#![cfg(not(feature = "dev-start"))]
use std::process::Command;

#[test]
fn the_development_flags_exit_2_with_a_message() {
    for flag in ["--fake-device", "--demo-setup"] {
        let dir = tempfile::tempdir().unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_kasboek"))
            .args(["--data-dir"])
            .arg(dir.path().join("data"))
            .arg("--log")
            .arg(dir.path().join("startup.log"))
            .arg(flag)
            .env_remove("KASBOEK_DEMO_PASSWORD")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{flag}");
        let said = String::from_utf8_lossy(&out.stderr);
        assert!(said.contains(flag) && said.contains("dev-start"), "{flag}: {said}");
        // Nothing was created: the refusal comes before any data folder is touched.
        assert!(!dir.path().join("data").exists(), "{flag}");
    }
}
