//! Kasboek UI spike: Lock screen and Overview in Slint.
//!
//!   kasboek-ui shot <screen> <light|dark> <out.png> [scroll-px] [--lang en|de|fr] [--typing]   offscreen render
//!   kasboek-ui [--screen S] [--theme dark|light] [--scale 1|2] [--lang en|de|fr] [--typing] [--renderer R]
//!              [--exit-after-first-frame] [--log FILE]   real window; startup.log is written next to the binary
//! Screens: lock-password, lock-hello, overview.
// A double-clicked Windows binary must not open a console window; its output is startup.log.
#![cfg_attr(windows, windows_subsystem = "windows")]
mod device;
mod fixtures;
mod log;
mod shot;
mod startup;
mod strings;

slint::include_modules!();

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("shot") {
        // Positional: shot <screen> <theme> <out> [scroll-px]; the flags may follow.
        let positional: Vec<&String> = args
            .iter()
            .enumerate()
            .filter(|(i, a)| !a.starts_with("--") && !(*i > 0 && args[i - 1] == "--lang"))
            .map(|(_, a)| a)
            .collect();
        if let [_, screen, theme, out, rest @ ..] = positional.as_slice() {
            let scroll = rest.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let lang = args
                .iter()
                .position(|a| a == "--lang")
                .and_then(|i| args.get(i + 1));
            let typing = args.iter().any(|a| a == "--typing");
            shot::render(
                screen,
                theme.as_str() == "dark",
                out,
                scroll,
                lang.map_or("en", String::as_str),
                typing,
            );
            return;
        }
        eprintln!(
            "usage: kasboek-ui shot <screen> <light|dark> <out.png> [scroll-px] [--lang en|de|fr] [--typing]"
        );
        std::process::exit(2);
    }
    startup::run(&args);
}
