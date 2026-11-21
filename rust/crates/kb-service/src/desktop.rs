//! What the operations need from the desktop: file dialogs and opening things with the system. A trait, so that the
//! operations run in tests and scenarios without a window ([`FakeDesktop`] answers from a queue, [`NoDesktop`] refuses), and
//! the app can run the real dialogs on its main thread (macOS needs that) while the operation waits on its job thread.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A file type filter of a dialog: a label and the extensions without the dot.
pub type Filter<'a> = (&'a str, &'a [&'a str]);

pub trait Desktop: Send + Sync {
    /// The "save as" dialog; `None` when the person cancelled.
    fn save_file(&self, title: &str, default_name: &str, filters: &[Filter<'_>]) -> Option<PathBuf>;
    /// The "open file" dialog; `None` when the person cancelled.
    fn open_file(&self, title: &str, filters: &[Filter<'_>]) -> Option<PathBuf>;
    /// The folder picker; `None` when the person cancelled.
    fn pick_folder(&self, title: &str) -> Option<PathBuf>;
    /// Opens a file or folder with the system's default program (`shell.openPath`); `true` when it worked.
    fn open_path(&self, path: &Path) -> bool;
    /// Opens a web address in the default browser (`shell.openExternal`); `true` when it worked.
    fn open_url(&self, url: &str) -> bool;
}

/// No desktop: every dialog is cancelled and nothing opens. The default of a service whose app gave it no desktop.
pub struct NoDesktop;

impl Desktop for NoDesktop {
    fn save_file(&self, _title: &str, _default_name: &str, _filters: &[Filter<'_>]) -> Option<PathBuf> {
        None
    }

    fn open_file(&self, _title: &str, _filters: &[Filter<'_>]) -> Option<PathBuf> {
        None
    }

    fn pick_folder(&self, _title: &str) -> Option<PathBuf> {
        None
    }

    fn open_path(&self, _path: &Path) -> bool {
        false
    }

    fn open_url(&self, _url: &str) -> bool {
        false
    }
}

/// What a [`FakeDesktop`] was asked, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopCall {
    SaveFile { title: String, default_name: String },
    OpenFile { title: String },
    PickFolder { title: String },
    OpenPath(PathBuf),
    OpenUrl(String),
}

/// Answers the dialogs from a queue, one entry per dialog in the order they are asked (`None` is "cancelled"); an empty queue
/// cancels. Opening a path or an address works and is only recorded.
#[derive(Default)]
pub struct FakeDesktop {
    answers: Mutex<std::collections::VecDeque<Option<PathBuf>>>,
    calls: Mutex<Vec<DesktopCall>>,
}

impl FakeDesktop {
    pub fn new(answers: Vec<Option<PathBuf>>) -> Self {
        Self { answers: Mutex::new(answers.into()), calls: Mutex::new(Vec::new()) }
    }

    /// Every call so far, in order.
    pub fn calls(&self) -> Vec<DesktopCall> {
        self.calls.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn dialog(&self, call: DesktopCall) -> Option<PathBuf> {
        self.calls.lock().unwrap_or_else(|e| e.into_inner()).push(call);
        self.answers.lock().unwrap_or_else(|e| e.into_inner()).pop_front().flatten()
    }
}

impl Desktop for FakeDesktop {
    fn save_file(&self, title: &str, default_name: &str, _filters: &[Filter<'_>]) -> Option<PathBuf> {
        self.dialog(DesktopCall::SaveFile { title: title.to_owned(), default_name: default_name.to_owned() })
    }

    fn open_file(&self, title: &str, _filters: &[Filter<'_>]) -> Option<PathBuf> {
        self.dialog(DesktopCall::OpenFile { title: title.to_owned() })
    }

    fn pick_folder(&self, title: &str) -> Option<PathBuf> {
        self.dialog(DesktopCall::PickFolder { title: title.to_owned() })
    }

    fn open_path(&self, path: &Path) -> bool {
        self.calls.lock().unwrap_or_else(|e| e.into_inner()).push(DesktopCall::OpenPath(path.to_owned()));
        true
    }

    fn open_url(&self, url: &str) -> bool {
        self.calls.lock().unwrap_or_else(|e| e.into_inner()).push(DesktopCall::OpenUrl(url.to_owned()));
        true
    }
}
