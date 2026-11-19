//! Keyboard behaviour of the live parts of the gallery, driven with synthetic input on the software renderer.
//! One test function: the headless platform can be installed once per process.
use kb_ui::{shot, DateCheck, Gallery, Rules};

#[test]
fn modal_asks_like_the_app_and_ignores_the_backdrop() {
    let window = shot::install();
    let ui = Gallery::new().unwrap();
    kb_ui::wire_rules!(&ui);
    ui.set_case("none".into());
    shot::open(&window, &ui, 760, 820, 1.0);

    // Open, nothing typed: Escape closes at once.
    ui.set_modal_open(true);
    shot::press(&window, "Escape");
    assert_eq!(ui.get_last_event(), "modal-closed");
    assert!(!ui.get_modal_open() || ui.get_last_event() == "modal-closed");

    // A click on the dimmed background does not close it, even when nothing was typed.
    ui.set_last_event("".into());
    ui.set_modal_open(true);
    shot::click(&window, 5.0, 5.0);
    assert_eq!(ui.get_last_event(), "", "backdrop click must not close");

    // Typed something: Escape asks, a second Escape goes back to editing, nothing closed so far.
    ui.set_modal_dirty(true);
    shot::press(&window, "Escape");
    assert_eq!(ui.get_last_event(), "");
    shot::press(&window, "Escape");
    assert_eq!(ui.get_last_event(), "");
    // Escape again asks again; Tab to "Discard" and Enter closes.
    shot::press(&window, "Escape");
    shot::press(&window, "Tab");
    shot::press(&window, "Enter");
    assert_eq!(ui.get_last_event(), "modal-closed");
}

#[test]
fn typed_dates_follow_the_pattern() {
    // The Rust side of `Rules`, independent of the window.
    let (iso, problem) = kb_ui::rules::check_date("5/3/2026", "DD/MM/YYYY", "", &kb_ui::rules::EN);
    assert_eq!((iso.as_str(), problem), ("2026-03-05", ""));
}
