//! Kasboek UI spike: Lock screen and Overview in Slint.
//!
//!   kasboek-ui shot <screen> <light|dark> <out.png> [scroll-px]   offscreen render with the software renderer
//!   kasboek-ui [--screen S] [--theme T] [--exit-after-first-frame] [--log FILE]   real window
//! Screens: lock-password, lock-hello, overview.
mod fixtures;
mod shot;
mod startup;
mod strings;

slint::include_modules!();

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("shot") {
        if let [_, screen, theme, out, rest @ ..] = args.as_slice() {
            let scroll = rest.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            shot::render(screen, theme == "dark", out, scroll);
            return;
        }
        eprintln!("usage: kasboek-ui shot <screen> <light|dark> <out.png> [scroll-px]");
        std::process::exit(2);
    }
    startup::run(&args);
}
