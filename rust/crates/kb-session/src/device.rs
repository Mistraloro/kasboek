//! Windows Hello / Touch ID, behind a trait. The real prompts come with the platform code.
use crate::error::SessionError;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKind {
    WindowsHello,
    TouchId,
}

impl DeviceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WindowsHello => "windows-hello",
            Self::TouchId => "touch-id",
        }
    }
}

pub trait DeviceAuth: Send + Sync {
    /// The answer of the availability check if it has finished: `Some(None)` is "not available", `None` is "still
    /// checking" (`peekDeviceAuthKind`).
    fn peek(&self) -> Option<Option<DeviceKind>>;
    /// Waits for the availability check (`deviceAuthKind`).
    fn kind(&self) -> Option<DeviceKind>;
    /// Shows the OS prompt. `Ok(true)` verified, `Ok(false)` cancelled; other outcomes are `auth.device_*` errors.
    fn verify(&self, reason: &str) -> Result<bool, SessionError>;
}

/// This computer has no device check (the default until the platform code exists).
pub struct NoDevice;

impl DeviceAuth for NoDevice {
    fn peek(&self) -> Option<Option<DeviceKind>> {
        Some(None)
    }

    fn kind(&self) -> Option<DeviceKind> {
        None
    }

    fn verify(&self, _reason: &str) -> Result<bool, SessionError> {
        Err(SessionError::new("auth.device_unavailable", "Windows Hello could not be started."))
    }
}

/// A device check that answers as told, and records the reasons it was asked with. For tests and the parity driver.
pub struct FakeDevice {
    state: Mutex<FakeState>,
}

struct FakeState {
    kind: Option<DeviceKind>,
    verified: bool,
    asked: Vec<String>,
}

impl FakeDevice {
    pub fn new(kind: Option<DeviceKind>, verified: bool) -> Self {
        Self { state: Mutex::new(FakeState { kind, verified, asked: Vec::new() }) }
    }

    pub fn set(&self, kind: Option<DeviceKind>, verified: bool) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.kind = kind;
        s.verified = verified;
    }

    pub fn asked(&self) -> Vec<String> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).asked.clone()
    }
}

impl DeviceAuth for FakeDevice {
    fn peek(&self) -> Option<Option<DeviceKind>> {
        Some(self.kind())
    }

    fn kind(&self) -> Option<DeviceKind> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).kind
    }

    fn verify(&self, reason: &str) -> Result<bool, SessionError> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.asked.push(reason.to_owned());
        Ok(s.verified)
    }
}

impl<T: DeviceAuth + ?Sized> DeviceAuth for std::sync::Arc<T> {
    fn peek(&self) -> Option<Option<DeviceKind>> {
        (**self).peek()
    }

    fn kind(&self) -> Option<DeviceKind> {
        (**self).kind()
    }

    fn verify(&self, reason: &str) -> Result<bool, SessionError> {
        (**self).verify(reason)
    }
}
