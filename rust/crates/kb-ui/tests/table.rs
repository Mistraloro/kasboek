//! DataTable behaviour with synthetic input on the software renderer: click, Ctrl-click, Shift-click, the box column,
//! the keyboard, select all, and the row actions menu. One test function: the headless platform can be installed once
//! per process.
use kb_ui::{shot, DateCheck, Gallery, Rules, TableDemo};
use slint::{ComponentHandle, Model};

const ROW_Y: f32 = 25.0 + 41.0; // the card at 24 + 1px border, then the 41px header
const ROWS: usize = 1000;

fn row_center(i: usize) -> f32 {
    ROW_Y + 41.0 * i as f32 + 20.0
}

#[test]
fn table_selection_keys_and_actions() {
    let window = shot::install();
    let ui = Gallery::new().unwrap();
    kb_ui::wire_rules!(&ui);
    let demo = kb_ui::demo::wire(&ui, ROWS);
    ui.set_case("datatable-live".into());
    shot::open(&window, &ui, 760, 420, 1.0);
    let t = ui.global::<TableDemo>();
    let event = || t.get_last_event().to_string();
    let selected = || demo.selection.borrow().rows().collect::<Vec<_>>();

    // The table asked for its columns when it was laid out: four, and the flexible ones fill the width.
    assert_eq!(t.get_columns().row_count(), 4);
    let widths: f32 = t.get_columns().iter().map(|c| c.width).sum();
    assert!((widths - (710.0 - 40.0 - 10.0)).abs() < 0.01, "columns fill the table: {widths}");

    // Plain click, Shift-click (range), Ctrl-click (flip).
    shot::click(&window, 300.0, row_center(2));
    assert_eq!((event().as_str(), selected()), ("select 2", vec![2]));
    shot::key_down(&window, "Shift");
    shot::click(&window, 300.0, row_center(5));
    shot::key_up(&window, "Shift");
    assert_eq!((event().as_str(), selected()), ("select 5 shift", vec![2, 3, 4, 5]));
    shot::key_down(&window, "Control");
    shot::click(&window, 300.0, row_center(7));
    shot::key_up(&window, "Control");
    assert_eq!((event().as_str(), selected()), ("select 7 toggle", vec![2, 3, 4, 5, 7]));
    assert_eq!(t.get_selected_count(), 5);
    // The box column flips without a modifier.
    shot::click(&window, 45.0, row_center(0));
    assert_eq!((event().as_str(), selected()), ("select 0 toggle", vec![0, 2, 3, 4, 5, 7]));

    // Keys: Down moves the cursor and selects, Shift+Down extends, Space flips, Enter activates.
    shot::click(&window, 300.0, row_center(3));
    assert_eq!((t.get_cursor(), selected()), (3, vec![3]));
    shot::press(&window, "Down");
    assert_eq!((t.get_cursor(), selected()), (4, vec![4]));
    shot::key_down(&window, "Shift");
    shot::press(&window, "Down");
    shot::key_up(&window, "Shift");
    assert_eq!((t.get_cursor(), selected()), (5, vec![4, 5]));
    shot::press(&window, "Space");
    assert_eq!((event().as_str(), selected()), ("select 5 toggle", vec![4]));
    shot::press(&window, "Enter");
    assert_eq!(event(), "activate 5");
    shot::press(&window, "Up");
    assert_eq!((t.get_cursor(), selected()), (4, vec![4]));
    shot::press(&window, "End");
    assert_eq!((t.get_cursor(), selected()), (ROWS as i32 - 1, vec![ROWS - 1]));
    assert!(t.get_scroll_y() < 0.0, "the list followed the cursor to the end: {}", t.get_scroll_y());
    shot::press(&window, "Home");
    assert_eq!((t.get_cursor(), t.get_scroll_y()), (0, 0.0));
    shot::press(&window, "PageDown");
    assert_eq!(t.get_cursor(), 7, "a page is the visible rows less one");

    // Ctrl+A, Escape; Ctrl+Arrow only moves the cursor.
    shot::key_down(&window, "Control");
    shot::press(&window, "a");
    shot::key_up(&window, "Control");
    assert_eq!((event().as_str(), t.get_selected_count()), ("select-all", ROWS as i32));
    shot::press(&window, "Escape");
    assert_eq!((event().as_str(), t.get_selected_count()), ("clear", 0));
    shot::key_down(&window, "Control");
    shot::press(&window, "Down");
    shot::key_up(&window, "Control");
    assert_eq!((t.get_cursor(), t.get_selected_count()), (8, 0));

    // The select-all box of the header.
    shot::click(&window, 45.0, 45.0);
    assert_eq!((event().as_str(), t.get_selected_count()), ("select-all", ROWS as i32));
    shot::click(&window, 45.0, 45.0);
    assert_eq!((event().as_str(), t.get_selected_count()), ("clear", 0));

    // Back to the top (the earlier Ctrl+Down scrolled the list a little to keep the cursor in view).
    shot::press(&window, "Home");
    // Row actions from the keyboard: the menu key opens the list, Down moves, Enter runs the second command.
    shot::click(&window, 300.0, row_center(3));
    shot::press(&window, "Menu");
    shot::press(&window, "Down");
    shot::press(&window, "Enter");
    assert_eq!(event(), "action 3 1");
    // Shift+F10 and Escape: nothing runs.
    shot::key_down(&window, "Shift");
    shot::press(&window, "F10");
    shot::key_up(&window, "Shift");
    shot::press(&window, "Escape");
    assert_eq!(event(), "action 3 1");
    // Right click selects the row and opens the menu; End then Enter runs the last command ("Delete").
    shot::right_click(&window, 300.0, row_center(1));
    assert_eq!(selected(), vec![1]);
    shot::press(&window, "End");
    shot::press(&window, "Enter");
    assert_eq!(event(), "action 1 2");

    // Cells are numbers and text as the source made them, and the label is the row's sentence.
    let first = demo.model.row_data(0).unwrap();
    assert_eq!(first.cells.row_data(3).unwrap(), "0.00");
    assert_eq!(first.label, "28/12/2026, Supermarket no. 0, Groceries, 0.00");
}

// The test needs these in scope for `wire_rules!`.
#[allow(dead_code)]
fn _types(_: DateCheck, _: Rules) {}
