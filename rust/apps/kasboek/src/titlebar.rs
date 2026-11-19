//! The title bar follows the theme. Windows 11: caption colour and dark mode through DWM. macOS and Linux keep the standard
//! title bar (a transparent one on macOS needs winit window attributes that Slint 1.19 only offers behind an unstable
//! feature). On every other system, and on Windows 10 where DWM ignores the caption colour, this does nothing.

/// Colours the title bar for the theme. `bg`/`text` are the theme's background and text colours as 0xRRGGBB.
#[cfg(windows)]
pub fn apply(window: &slint::Window, dark: bool, bg: u32, text: u32) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{COLORREF, HWND};
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE};
    let Ok(handle) = window.window_handle().window_handle() else { return };
    let RawWindowHandle::Win32(h) = handle.as_raw() else { return };
    let hwnd = HWND(h.hwnd.get() as *mut core::ffi::c_void);
    // COLORREF is 0x00BBGGRR.
    let colorref = |rgb: u32| COLORREF(((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF));
    let dark_flag = BOOL::from(dark);
    let (caption, text) = (colorref(bg), colorref(text));
    // SAFETY: the HWND is this process's live window; each value is a plain struct that outlives the call, with its size.
    unsafe {
        // Every call may fail on older Windows (the attributes are Windows 11): the title bar then stays as the system draws it.
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &dark_flag as *const _ as *const _,
            std::mem::size_of::<BOOL>() as u32,
        );
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, &caption as *const _ as *const _, std::mem::size_of::<COLORREF>() as u32);
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, &text as *const _ as *const _, std::mem::size_of::<COLORREF>() as u32);
    }
}

#[cfg(not(windows))]
pub fn apply(_window: &slint::Window, _dark: bool, _bg: u32, _text: u32) {}

/// Whether the system is set to dark mode, or None when it cannot be told (then the caller keeps what it had).
#[cfg(windows)]
pub fn system_dark() -> Option<bool> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut value: u32 = 1;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: `value` and `size` are plain locals and `size` is the size of `value`.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    (status.0 == 0).then_some(value == 0)
}

#[cfg(target_os = "macos")]
pub fn system_dark() -> Option<bool> {
    let out = std::process::Command::new("defaults").args(["read", "-g", "AppleInterfaceStyle"]).output().ok()?;
    // The key is absent in light mode (the command then fails).
    Some(out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "Dark")
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn system_dark() -> Option<bool> {
    if let Ok(t) = std::env::var("GTK_THEME") {
        return Some(t.to_lowercase().contains("dark"));
    }
    let out = std::process::Command::new("gsettings").args(["get", "org.gnome.desktop.interface", "color-scheme"]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).contains("prefer-dark"))
}
