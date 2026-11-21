//! Offscreen rendering with Slint's software renderer, no windowing system needed, plus synthetic keyboard and mouse
//! input ("Shift" and "Control" with `key_down`/`key_up` hold a modifier). Used by the gallery (`--shot`, `--tab N`) and by the behaviour tests.
use slint::platform::software_renderer::{MinimalSoftwareWindow, RepaintBufferType};
use slint::platform::{Key, Platform, PointerEventButton, WindowAdapter, WindowEvent};
use slint::{ComponentHandle, LogicalPosition, PhysicalSize, Rgb8Pixel, SharedString};
use std::path::Path;
use std::rc::Rc;

struct Headless(Rc<MinimalSoftwareWindow>);

impl Platform for Headless {
    fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, slint::PlatformError> {
        Ok(self.0.clone())
    }
}

/// Installs the headless platform (once per process) and returns its window. Create the component after this.
pub fn install() -> Rc<MinimalSoftwareWindow> {
    let window = MinimalSoftwareWindow::new(RepaintBufferType::NewBuffer);
    slint::platform::set_platform(Box::new(Headless(window.clone()))).expect("platform already set");
    window
}

/// Shows `ui` in a `width` x `height` window (logical pixels) at `scale` and makes the window active, so that focus
/// shows. Pending animations are advanced.
pub fn open<C: ComponentHandle>(window: &MinimalSoftwareWindow, ui: &C, width: u32, height: u32, scale: f32) {
    window.set_size(PhysicalSize::new((width as f32 * scale).round() as u32, (height as f32 * scale).round() as u32));
    window.dispatch_event(WindowEvent::ScaleFactorChanged { scale_factor: scale });
    ui.show().expect("show");
    window.dispatch_event(WindowEvent::WindowActiveChanged(true));
    slint::platform::update_timers_and_animations();
}

fn key_text(name: &str) -> SharedString {
    let key = match name {
        "Tab" => Key::Tab,
        "Backtab" => Key::Backtab,
        "Enter" | "Return" => Key::Return,
        "Escape" | "Esc" => Key::Escape,
        "Up" => Key::UpArrow,
        "Down" => Key::DownArrow,
        "Left" => Key::LeftArrow,
        "Right" => Key::RightArrow,
        "Home" => Key::Home,
        "End" => Key::End,
        "Space" => return " ".into(),
        "Backspace" => Key::Backspace,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "Menu" => Key::Menu,
        "F10" => Key::F10,
        "Shift" => Key::Shift,
        "Control" => Key::Control,
        other => return other.into(),
    };
    key.into()
}

/// Presses and releases a key by name ("Tab", "Space", "Enter", "Escape", "Up", ..., or a single character).
/// "Shift+Tab" sends Backtab.
pub fn press(window: &MinimalSoftwareWindow, name: &str) {
    let name = if name == "Shift+Tab" { "Backtab" } else { name };
    let text = key_text(name);
    window.dispatch_event(WindowEvent::KeyPressed { text: text.clone() });
    window.dispatch_event(WindowEvent::KeyReleased { text });
    slint::platform::update_timers_and_animations();
}

/// Key down without release (hold-to-show tests).
pub fn key_down(window: &MinimalSoftwareWindow, name: &str) {
    window.dispatch_event(WindowEvent::KeyPressed { text: key_text(name) });
    slint::platform::update_timers_and_animations();
}

pub fn key_up(window: &MinimalSoftwareWindow, name: &str) {
    window.dispatch_event(WindowEvent::KeyReleased { text: key_text(name) });
    slint::platform::update_timers_and_animations();
}

pub fn type_text(window: &MinimalSoftwareWindow, text: &str) {
    for c in text.chars() {
        press(window, &c.to_string());
    }
}

pub fn hover(window: &MinimalSoftwareWindow, x: f32, y: f32) {
    window.dispatch_event(WindowEvent::PointerMoved { position: LogicalPosition::new(x, y) });
    slint::platform::update_timers_and_animations();
}

pub fn mouse_down(window: &MinimalSoftwareWindow, x: f32, y: f32) {
    let position = LogicalPosition::new(x, y);
    window.dispatch_event(WindowEvent::PointerMoved { position });
    window.dispatch_event(WindowEvent::PointerPressed { position, button: PointerEventButton::Left });
    slint::platform::update_timers_and_animations();
}

pub fn mouse_up(window: &MinimalSoftwareWindow, x: f32, y: f32) {
    window.dispatch_event(WindowEvent::PointerReleased { position: LogicalPosition::new(x, y), button: PointerEventButton::Left });
    slint::platform::update_timers_and_animations();
}

pub fn click(window: &MinimalSoftwareWindow, x: f32, y: f32) {
    mouse_down(window, x, y);
    mouse_up(window, x, y);
}

/// A click with the right button (opens the row actions of a table).
pub fn right_click(window: &MinimalSoftwareWindow, x: f32, y: f32) {
    let position = LogicalPosition::new(x, y);
    window.dispatch_event(WindowEvent::PointerMoved { position });
    window.dispatch_event(WindowEvent::PointerPressed { position, button: PointerEventButton::Right });
    window.dispatch_event(WindowEvent::PointerReleased { position, button: PointerEventButton::Right });
    slint::platform::update_timers_and_animations();
}

/// Renders the current frame to RGB pixels (physical size of the window).
pub fn pixels(window: &MinimalSoftwareWindow) -> (u32, u32, Vec<Rgb8Pixel>) {
    slint::platform::update_timers_and_animations();
    let size = window.size();
    let mut buf = vec![Rgb8Pixel::default(); (size.width * size.height) as usize];
    let drawn = window.draw_if_needed(|renderer| {
        renderer.render(&mut buf, size.width as usize);
    });
    if !drawn {
        // Nothing changed since the last frame: force a full repaint.
        window.set_size(size);
        window.draw_if_needed(|renderer| {
            renderer.render(&mut buf, size.width as usize);
        });
    }
    (size.width, size.height, buf)
}

/// Renders the current frame to a PNG file.
pub fn write_png(window: &MinimalSoftwareWindow, out: &Path) {
    let (w, h, buf) = pixels(window);
    let file = std::io::BufWriter::new(std::fs::File::create(out).expect("create png"));
    let mut enc = png::Encoder::new(file, w, h);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    let bytes: Vec<u8> = buf.iter().flat_map(|p| [p.r, p.g, p.b]).collect();
    enc.write_header().expect("png header").write_image_data(&bytes).expect("png data");
}
