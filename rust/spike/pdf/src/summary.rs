//! `kb-spike-pdf summary FILE_OR_DIR...`: reads each PDF with this same binary (one child process per file, so a crash
//! or a hang in one file cannot stop the run) and prints one line per file with numbers only: pages, text pieces, pages
//! without text, pages with very little text, characters that are not readable, time. The text of a statement is
//! never printed, written or kept.
use crate::model::MIN_CHARS_PER_PAGE;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

fn pdfs_in(arg: &str) -> Vec<PathBuf> {
    let p = Path::new(arg);
    if p.is_dir() {
        let mut v: Vec<PathBuf> = std::fs::read_dir(p)
            .map(|d| d.filter_map(|e| e.ok().map(|e| e.path())).collect())
            .unwrap_or_default();
        v.retain(|f| f.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")));
        v.sort();
        v
    } else {
        vec![p.to_path_buf()]
    }
}

/// A character that a person would see as a broken glyph: U+FFFD, or a control character other than whitespace.
fn is_unreadable(c: char) -> bool {
    c == '\u{fffd}' || (c.is_control() && !c.is_whitespace())
}

pub fn run(args: &[String]) {
    let exe = std::env::current_exe().expect("own path");
    let files: Vec<PathBuf> = args.iter().flat_map(|a| pdfs_in(a)).collect();
    if files.is_empty() {
        println!("No PDF files found. Usage: kb-spike-pdf summary FOLDER_OR_FILE...");
        return;
    }
    let (mut ok, mut problems) = (0usize, 0usize);
    for f in &files {
        let name = f
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        let out = Command::new(&exe).arg("hayro").arg(f).output();
        let Ok(out) = out else {
            println!("{name}: could not start the reader");
            problems += 1;
            continue;
        };
        let ms = serde_json::from_slice::<Value>(
            out.stderr.split(|b| *b == b'\n').next().unwrap_or(&[]),
        )
        .ok()
        .and_then(|v| v["ms"].as_f64())
        .unwrap_or(0.0);
        let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) else {
            println!(
                "{name}: NO ANSWER (the reader crashed, exit {:?})",
                out.status.code()
            );
            problems += 1;
            continue;
        };
        if let Some(code) = v["error"].as_str() {
            println!("{name}: ERROR {code} ({ms:.0} ms)");
            problems += 1;
            continue;
        }
        let pages = v["pages"].as_array().cloned().unwrap_or_default();
        let (mut pieces, mut empty, mut thin, mut bad) = (0usize, 0usize, 0usize, 0usize);
        for p in &pages {
            let items = p["items"].as_array().cloned().unwrap_or_default();
            let chars: usize = items
                .iter()
                .map(|i| i["str"].as_str().map_or(0, |s| s.chars().count()))
                .sum();
            bad += items
                .iter()
                .map(|i| {
                    i["str"]
                        .as_str()
                        .map_or(0, |s| s.chars().filter(|c| is_unreadable(*c)).count())
                })
                .sum::<usize>();
            pieces += items.len();
            if items.is_empty() {
                empty += 1;
            } else if chars < MIN_CHARS_PER_PAGE {
                thin += 1;
            }
        }
        let verdict = if empty + thin + bad == 0 {
            "ok"
        } else {
            "CHECK"
        };
        if verdict == "ok" {
            ok += 1;
        } else {
            problems += 1;
        }
        println!(
            "{name}: {verdict}  pages={} text_pieces={pieces} pages_without_text={empty} pages_with_little_text={thin} unreadable_chars={bad} ({ms:.0} ms)",
            pages.len()
        );
    }
    println!("{} file(s): {ok} ok, {problems} to look at", files.len());
}
