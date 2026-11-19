use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir")).join("ui");
    // Crates that use the design system compile their own .slint files with
    // `CompilerConfiguration::new().with_library_paths([("kb-ui".into(), <DEP_KB_UI_DIR>/lib.slint)])`.
    println!("cargo::metadata=dir={}", dir.display());
    println!("cargo::rerun-if-changed=ui");
    println!("cargo::rerun-if-changed=assets");
    slint_build::compile(dir.join("gallery.slint")).expect("slint compile");
}
