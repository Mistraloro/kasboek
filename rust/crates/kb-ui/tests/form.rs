//! FormDialog (Enter, Ctrl+Enter, Escape, Cancel), AmountInput (written in the format on blur) and the toast with an
//! action, with synthetic input. One test function per process.
use kb_ui::{shot, DateCheck, Gallery, Rules, ToastActionItem};
use slint::{ModelRc, VecModel};

#[test]
fn form_dialog_amount_and_toast_action() {
    let window = shot::install();
    let ui = Gallery::new().unwrap();
    kb_ui::wire_rules!(&ui);
    ui.set_case("none".into());
    shot::open(&window, &ui, 760, 820, 1.0);

    // English format as the gallery's default: "1234.5" becomes "1,234.50" when the field is left.
    ui.set_form_open(true);
    shot::type_text(&window, "Rent");
    assert_eq!(ui.get_form_name(), "Rent", "the first field has the focus");
    shot::press(&window, "Enter");
    assert_eq!(ui.get_last_event(), "form-submitted", "Enter in a field submits");
    shot::press(&window, "Tab");
    shot::type_text(&window, "1234.5");
    shot::press(&window, "Tab");
    assert_eq!(ui.get_form_amount(), "1,234.50");

    // In the multi-line field Enter is a new line; Ctrl+Enter submits.
    ui.set_last_event("".into());
    shot::type_text(&window, "a");
    shot::press(&window, "Enter");
    shot::type_text(&window, "b");
    assert_eq!(ui.get_form_note(), "a\nb");
    assert_eq!(ui.get_last_event(), "");
    shot::key_down(&window, "Control");
    shot::press(&window, "Enter");
    shot::key_up(&window, "Control");
    assert_eq!(ui.get_last_event(), "form-submitted");

    // Tab leaves the field; Enter on Cancel presses Cancel (it asks, as the form is dirty) and does not submit.
    ui.set_last_event("".into());
    shot::press(&window, "Tab");
    shot::press(&window, "Enter");
    assert_eq!(ui.get_last_event(), "");
    // Escape goes back to editing, a second Escape asks again; Discard closes.
    shot::press(&window, "Escape");
    shot::press(&window, "Escape");
    assert_eq!(ui.get_last_event(), "");
    shot::press(&window, "Tab");
    shot::press(&window, "Enter");
    assert_eq!(ui.get_last_event(), "form-closed");
    assert!(!ui.get_form_open());

    // A clean form closes on Escape at once.
    ui.set_form_name("".into());
    ui.set_form_note("".into());
    ui.set_form_open(true);
    shot::press(&window, "Escape");
    assert_eq!(ui.get_last_event(), "form-closed");

    // The button of a toast with an action is reached by Tab and pressed with Enter.
    ui.set_last_event("".into());
    ui.set_action_toasts(ModelRc::new(VecModel::from(vec![ToastActionItem {
        id: 7,
        tone: "success".into(),
        message: "3 transactions deleted.".into(),
        action: "Undo".into(),
    }])));
    shot::press(&window, "Tab");
    shot::press(&window, "Enter");
    assert_eq!(ui.get_last_event(), "toast-action");
}

#[allow(dead_code)]
fn _types(_: DateCheck, _: Rules) {}
