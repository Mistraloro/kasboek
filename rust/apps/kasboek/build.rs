use std::collections::HashMap;
use std::path::PathBuf;

fn main() {
    // kb-ui publishes the folder of its .slint files (DEP_KB_UI_DIR); `@kb-ui` imports its lib.slint.
    let dir = PathBuf::from(std::env::var("DEP_KB_UI_DIR").expect("kb-ui publishes its ui folder"));
    let config =
        slint_build::CompilerConfiguration::new().with_library_paths(HashMap::from([("kb-ui".to_string(), dir.join("lib.slint"))]));
    slint_build::compile_with_config("ui/app.slint", config).expect("slint compile");
    println!("cargo::rerun-if-changed=ui");
    println!("cargo::rerun-if-changed={}", dir.display());
}
