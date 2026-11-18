//! Offscreen rendering with Slint's software renderer, no windowing system needed.
use crate::{App, fixtures, strings::En};
use slint::platform::software_renderer::{MinimalSoftwareWindow, RepaintBufferType};
use slint::platform::{Platform, WindowAdapter, WindowEvent};
use slint::{ComponentHandle, PhysicalSize, Rgb8Pixel};
use std::rc::Rc;

struct Headless(Rc<MinimalSoftwareWindow>);

impl Platform for Headless {
    fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, slint::PlatformError> {
        Ok(self.0.clone())
    }
}

pub const W: u32 = 1280;
pub const H: u32 = 820;

pub fn render(screen: &str, dark: bool, out: &str, scroll: f32) {
    let window = MinimalSoftwareWindow::new(RepaintBufferType::NewBuffer);
    slint::platform::set_platform(Box::new(Headless(window.clone()))).expect("platform");
    let ui = App::new().expect("ui");
    window.set_size(PhysicalSize::new(W, H));
    window.dispatch_event(WindowEvent::ScaleFactorChanged { scale_factor: 1.0 });
    fixtures::apply(&ui, &En::load(), screen, dark);
    ui.set_scroll(scroll);
    ui.show().expect("show");
    slint::platform::update_timers_and_animations();

    let mut buf = vec![Rgb8Pixel::default(); (W * H) as usize];
    let drawn = window.draw_if_needed(|renderer| {
        renderer.render(&mut buf, W as usize);
    });
    assert!(drawn, "nothing was drawn");

    let file = std::io::BufWriter::new(std::fs::File::create(out).expect("create png"));
    let mut enc = png::Encoder::new(file, W, H);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    let bytes: Vec<u8> = buf.iter().flat_map(|p| [p.r, p.g, p.b]).collect();
    enc.write_header()
        .expect("png header")
        .write_image_data(&bytes)
        .expect("png data");
}
