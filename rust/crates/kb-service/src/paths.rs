//! The data folder: the same as Electron's `userData`, so that the native app opens the data of the Electron app.
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// `--data-dir`, else `KASBOEK_DATA_DIR`, else the folder Electron uses for the app named "Kasboek". When the system
/// does not say where that is, the answer is an error: the account never goes to a temporary folder by accident.
pub fn resolve_data_dir(arg: Option<&str>) -> Result<PathBuf, String> {
    resolve(arg, |name| std::env::var_os(name), std::env::consts::OS)
}

fn resolve(arg: Option<&str>, env: impl Fn(&str) -> Option<OsString>, os: &str) -> Result<PathBuf, String> {
    let set = |name: &str| env(name).filter(|v| !v.is_empty());
    if let Some(dir) = arg.filter(|a| !a.is_empty()) {
        return Ok(dir.into());
    }
    if let Some(dir) = set("KASBOEK_DATA_DIR") {
        return Ok(dir.into());
    }
    let home = || set("HOME").map(PathBuf::from);
    let base = match os {
        "windows" => set("APPDATA").map(PathBuf::from),
        "macos" => home().map(|h| h.join("Library").join("Application Support")),
        _ => set("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".config"))),
    };
    base.map(|b| b.join("Kasboek")).ok_or_else(|| {
        "Kasboek could not find its data folder: the system does not say where it is. Give --data-dir or set KASBOEK_DATA_DIR.".to_owned()
    })
}

/// Creates `dir` (and missing parents); folders made here are readable by the owner only on Unix. An existing folder is
/// left as it is.
pub(crate) fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        move |name| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| OsString::from(v))
    }

    #[test]
    fn the_flag_beats_the_variable_beats_the_default() {
        let vars = env(&[("KASBOEK_DATA_DIR", "/from/env"), ("HOME", "/home/a")]);
        assert_eq!(resolve(Some("/from/flag"), &vars, "linux"), Ok(PathBuf::from("/from/flag")));
        assert_eq!(resolve(None, &vars, "linux"), Ok(PathBuf::from("/from/env")));
        assert_eq!(resolve(None, env(&[("HOME", "/home/a")]), "linux"), Ok(PathBuf::from("/home/a/.config/Kasboek")));
    }

    #[test]
    fn each_system_uses_the_folder_of_electron() {
        assert_eq!(
            resolve(None, env(&[("APPDATA", "C:\\Users\\a\\AppData\\Roaming")]), "windows"),
            Ok(PathBuf::from("C:\\Users\\a\\AppData\\Roaming").join("Kasboek"))
        );
        assert_eq!(resolve(None, env(&[("HOME", "/Users/a")]), "macos"), Ok(PathBuf::from("/Users/a/Library/Application Support/Kasboek")));
        assert_eq!(resolve(None, env(&[("XDG_CONFIG_HOME", "/x"), ("HOME", "/home/a")]), "linux"), Ok(PathBuf::from("/x/Kasboek")));
    }

    #[test]
    fn no_home_is_an_error_not_the_temp_folder() {
        assert!(resolve(None, env(&[]), "linux").is_err());
        assert!(resolve(None, env(&[]), "windows").is_err());
        assert!(resolve(None, env(&[]), "macos").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_data_folder_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("a").join("Kasboek");
        create_private_dir(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        create_private_dir(&dir).unwrap();
    }
}
