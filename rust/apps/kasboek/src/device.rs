//! The OS device prompt behind the "Unlock with ..." button: Windows Hello (WinRT UserConsentVerifier) on Windows, Touch ID
//! (LocalAuthentication) on macOS. It only asks and reports; nothing is unlocked. Other systems answer "unavailable".
//! The Windows and macOS code is written to be tolerant (every failure becomes a reported `Failed`), but it could not
//! be compiled where it was written (copied from the UI spike): the CI workflow rust-app.yml is its first real build.
use std::sync::Arc;

// Linux never gets a prompt, so most variants are only built on Windows and macOS.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Verified,
    Cancelled,
    Unavailable,
    Failed,
}

impl Outcome {
    /// The word used in startup.log: `device answered (verified|cancelled|unavailable|failed)`.
    pub fn word(self) -> &'static str {
        match self {
            Outcome::Verified => "verified",
            Outcome::Cancelled => "cancelled",
            Outcome::Unavailable => "unavailable",
            Outcome::Failed => "failed",
        }
    }
}

// `Info` is only sent by the Windows code.
#[cfg_attr(not(windows), allow(dead_code))]
pub enum Event {
    /// A fact worth a log line (which call was used, how long it took to return).
    Info(String),
    /// The prompt is on screen, as far as this can be told. Sent at most once.
    Shown(String),
    Answered(Outcome, String),
}

/// Events may arrive on any thread.
pub type Report = Arc<dyn Fn(Event) + Send + Sync>;

pub use imp::{request, window_id};

#[cfg(windows)]
mod imp {
    use super::{Event, Outcome, Report};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::{IUserConsentVerifierInterop, RoInitialize, RO_INIT_MULTITHREADED};
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    use windows_future::IAsyncOperation;

    /// The HWND of the Slint window, as a number (a raw pointer cannot go to another thread).
    pub fn window_id(window: &slint::Window) -> Option<isize> {
        let binding = window.window_handle();
        let handle = binding.window_handle().ok()?;
        match handle.as_raw() {
            RawWindowHandle::Win32(h) => Some(h.hwnd.get()),
            _ => None,
        }
    }

    /// Calls the real API for `RequestVerificationForWindowAsync` and falls back to `RequestVerificationAsync` (which
    /// has no owner window) if the interop route is not possible. Returns the operation and which route was used.
    fn start(
        hwnd: Option<isize>,
        message: &HSTRING,
        report: &Report,
    ) -> windows::core::Result<(IAsyncOperation<UserConsentVerificationResult>, &'static str)> {
        if let Some(h) = hwnd {
            let attempt = windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>().and_then(|interop| {
                // SAFETY: the HWND is the live window of this process; `message` outlives the call.
                unsafe {
                    interop.RequestVerificationForWindowAsync::<IAsyncOperation<UserConsentVerificationResult>>(
                        HWND(h as *mut core::ffi::c_void),
                        message,
                    )
                }
            });
            match attempt {
                Ok(op) => return Ok((op, "RequestVerificationForWindowAsync")),
                Err(e) => report(Event::Info(format!("interop call failed ({e}); trying RequestVerificationAsync"))),
            }
        }
        Ok((UserConsentVerifier::RequestVerificationAsync(message)?, "RequestVerificationAsync"))
    }

    /// Best effort: is the system's verification window on screen? It is a "Credential Dialog Xaml Host" window
    /// (titled "Windows Security"); the class name is not documented, so both are tried.
    fn prompt_window_open() -> bool {
        // SAFETY: both calls only read window names; null means "any".
        unsafe {
            FindWindowW(w!("Credential Dialog Xaml Host"), PCWSTR::null()).is_ok()
                || FindWindowW(PCWSTR::null(), w!("Windows Security")).is_ok()
        }
    }

    pub fn request(hwnd: Option<isize>, reason: &str, report: Report) {
        let reason = reason.to_string();
        let pressed = Instant::now();
        // The whole call runs on its own thread so that the button press returns at once.
        std::thread::spawn(move || {
            // Already initialised on a thread that is not ours is fine (an error is ignored): WinRT works either way.
            // SAFETY: plain COM initialisation of this thread.
            let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
            let (op, route) = match start(hwnd, &HSTRING::from(reason), &report) {
                Ok(v) => v,
                Err(e) => {
                    report(Event::Answered(Outcome::Failed, format!("could not start the request: {e}")));
                    return;
                }
            };
            report(Event::Info(format!("{route} returned (pending) after {} ms", pressed.elapsed().as_millis())));
            let answered = Arc::new(AtomicBool::new(false));
            let shown = Arc::new(AtomicBool::new(false));
            {
                let (answered, shown, report) = (answered.clone(), shown.clone(), report.clone());
                std::thread::spawn(move || {
                    let give_up = Instant::now() + Duration::from_secs(30);
                    while !answered.load(Ordering::Relaxed) && Instant::now() < give_up {
                        if prompt_window_open() {
                            if !shown.swap(true, Ordering::Relaxed) {
                                report(Event::Shown("window found".into()));
                            }
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                });
            }
            let result = op.join();
            answered.store(true, Ordering::Relaxed);
            if !shown.swap(true, Ordering::Relaxed) {
                report(Event::Shown("window not detected; the call had returned pending".into()));
            }
            let (outcome, detail) = match result {
                Ok(r) if r == UserConsentVerificationResult::Verified => (Outcome::Verified, "Verified".to_string()),
                Ok(r) if r == UserConsentVerificationResult::Canceled => (Outcome::Cancelled, "Canceled".to_string()),
                Ok(r) if r == UserConsentVerificationResult::DeviceNotPresent => (Outcome::Unavailable, "DeviceNotPresent".to_string()),
                Ok(r) if r == UserConsentVerificationResult::NotConfiguredForUser => {
                    (Outcome::Unavailable, "NotConfiguredForUser".to_string())
                }
                Ok(r) if r == UserConsentVerificationResult::DisabledByPolicy => (Outcome::Unavailable, "DisabledByPolicy".to_string()),
                Ok(r) if r == UserConsentVerificationResult::DeviceBusy => (Outcome::Failed, "DeviceBusy".to_string()),
                Ok(r) if r == UserConsentVerificationResult::RetriesExhausted => (Outcome::Failed, "RetriesExhausted".to_string()),
                Ok(r) => (Outcome::Failed, format!("unknown result {}", r.0)),
                Err(e) => (Outcome::Failed, format!("{e}")),
            };
            report(Event::Answered(outcome, detail));
        });
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Event, Outcome, Report};
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};

    pub fn window_id(_window: &slint::Window) -> Option<isize> {
        None
    }

    /// LAError codes (LocalAuthentication/LAError.h) grouped for the log.
    fn classify(code: isize) -> Outcome {
        match code {
            -2 | -4 | -9 => Outcome::Cancelled, // user cancel, system cancel, app cancel
            -8..=-5 => Outcome::Unavailable,    // no passcode, no Touch ID, none enrolled, locked out
            _ => Outcome::Failed,
        }
    }

    pub fn request(_window: Option<isize>, reason: &str, report: Report) {
        // SAFETY: LAContext is created and used from this thread; the reply block copies what it needs and the
        // context is kept alive by the block until the system calls it.
        unsafe {
            let context = LAContext::new();
            let keep = context.clone();
            let done = report.clone();
            let reply = RcBlock::new(move |ok: Bool, error: *mut NSError| {
                let _keep = &keep;
                if ok.as_bool() {
                    done(Event::Answered(Outcome::Verified, "success".into()));
                } else if let Some(e) = error.as_ref() {
                    let code = e.code();
                    done(Event::Answered(classify(code), format!("LAError {code}: {}", e.localizedDescription())));
                } else {
                    done(Event::Answered(Outcome::Failed, "no error given".into()));
                }
            });
            let why = NSString::from_str(reason);
            context.evaluatePolicy_localizedReason_reply(LAPolicy::DeviceOwnerAuthenticationWithBiometrics, &why, &reply);
        }
        // The system shows its own sheet right after this returns; there is no window of ours to look for.
        report(Event::Shown("evaluatePolicy returned (sheet is being shown)".into()));
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::{Event, Outcome, Report};

    pub fn window_id(_window: &slint::Window) -> Option<isize> {
        None
    }

    pub fn request(_window: Option<isize>, _reason: &str, report: Report) {
        report(Event::Answered(Outcome::Unavailable, "this system has no device prompt (Windows Hello and Touch ID only)".into()));
    }
}
