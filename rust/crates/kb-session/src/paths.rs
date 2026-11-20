//! File names inside the data folder (src/main/paths.ts). The folder itself is the same as Electron's `userData`.
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub db_file: PathBuf,
    pub account_file: PathBuf,
    /// The untouched Electron account.json that `kb-oseal`'s migration keeps; removed once the native seal has worked.
    pub electron_backup_file: PathBuf,
    /// Phase 1 key file: without it the old database can't be opened, so it travels with the database.
    pub legacy_keystore_file: PathBuf,
    pub safety_dir: PathBuf,
}

impl Paths {
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            data_dir: dir.to_path_buf(),
            db_file: dir.join("kasboek.db"),
            account_file: dir.join("account.json"),
            electron_backup_file: dir.join("account.electron.json"),
            legacy_keystore_file: dir.join("keystore.json"),
            safety_dir: dir.join("safety-backups"),
        }
    }
}
