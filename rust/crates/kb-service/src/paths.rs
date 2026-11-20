//! The data folder: the same as Electron's `userData`, so that the native app opens the data of the Electron app.
use std::ffi::OsString;
use std::path::PathBuf;

/// `--data-dir`, else `KASBOEK_DATA_DIR`, else the folder Electron uses for the app named "Kasboek".
pub fn resolve_data_dir(arg: Option<&str>) -> PathBuf {
    resolve(arg, |name| std::env::var_os(name), std::env::consts::OS)
}

fn resolve(arg: Option<&str>, env: impl Fn(&str) -> Option<OsString>, os: &str) -> PathBuf {
    let set = |name: &str| env(name).filter(|v| !v.is_empty());
    if let Some(dir) = arg.filter(|a| !a.is_empty()) {
        return dir.into();
    }
    if let Some(dir) = set("KASBOEK_DATA_DIR") {
        return dir.into();
    }
    let home = || set("HOME").map(PathBuf::from);
    let base = match os {
        "windows" => set("APPDATA").map(PathBuf::from),
        "macos" => home().map(|h| h.join("Library").join("Application Support")),
        _ => set("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".config"))),
    };
    base.unwrap_or_else(std::env::temp_dir).join("Kasboek")
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
        assert_eq!(resolve(Some("/from/flag"), &vars, "linux"), PathBuf::from("/from/flag"));
        assert_eq!(resolve(None, &vars, "linux"), PathBuf::from("/from/env"));
        assert_eq!(resolve(None, env(&[("HOME", "/home/a")]), "linux"), PathBuf::from("/home/a/.config/Kasboek"));
    }

    #[test]
    fn each_system_uses_the_folder_of_electron() {
        assert_eq!(
            resolve(None, env(&[("APPDATA", "C:\\Users\\a\\AppData\\Roaming")]), "windows"),
            PathBuf::from("C:\\Users\\a\\AppData\\Roaming").join("Kasboek")
        );
        assert_eq!(resolve(None, env(&[("HOME", "/Users/a")]), "macos"), PathBuf::from("/Users/a/Library/Application Support/Kasboek"));
        assert_eq!(resolve(None, env(&[("XDG_CONFIG_HOME", "/x"), ("HOME", "/home/a")]), "linux"), PathBuf::from("/x/Kasboek"));
    }
}
