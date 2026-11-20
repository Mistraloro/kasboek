//! Turning bytes into rows: encoding, delimiter, quoting, and the header names (src/core/csv/read.ts).
use crate::jsstr::js_trim;
use unicode_normalization::UnicodeNormalization;

/// UTF-8 (with or without BOM), UTF-16 with BOM, otherwise Windows-1252 (common in Belgian bank exports). The decoders are
/// the WHATWG ones `TextDecoder` uses: bad bytes become U+FFFD, and a BOM of the chosen encoding is dropped.
pub fn decode(bytes: &[u8]) -> (String, &'static str) {
    let lossy = |encoding: &'static encoding_rs::Encoding, bytes: &[u8]| encoding.decode_with_bom_removal(bytes).0.into_owned();
    match bytes {
        [0xef, 0xbb, 0xbf, rest @ ..] => (lossy(encoding_rs::UTF_8, rest), "utf-8"),
        [0xff, 0xfe, rest @ ..] => (lossy(encoding_rs::UTF_16LE, rest), "utf-16le"),
        [0xfe, 0xff, rest @ ..] => (lossy(encoding_rs::UTF_16BE, rest), "utf-16be"),
        _ => match std::str::from_utf8(bytes) {
            Ok(text) => (text.to_owned(), "utf-8"),
            Err(_) => (lossy(encoding_rs::WINDOWS_1252, bytes), "windows-1252"),
        },
    }
}

/// RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes, CRLF/LF. Cells are trimmed and rows without
/// content are dropped.
pub fn parse_csv(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(ch);
            }
        } else if ch == '"' && js_trim(&field).is_empty() {
            quoted = true;
            field.clear();
        } else if ch == delimiter {
            row.push(std::mem::take(&mut field));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(ch);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows.into_iter()
        .map(|r| r.into_iter().map(|c| js_trim(&c).to_owned()).collect::<Vec<_>>())
        .filter(|r| r.iter().any(|c| !c.is_empty()))
        .collect()
}

/// Picks the delimiter that gives the most columns, consistently, over the first lines.
pub fn detect_delimiter(text: &str) -> char {
    // `text.split(/\r?\n/)`, the lines with something in them, the first 30.
    let sample: Vec<&str> =
        text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !js_trim(l).is_empty()).take(30).collect();
    let sample = sample.join("\n");
    let mut best = ';';
    let mut best_score: i64 = -1;
    for d in [';', ',', '\t', '|'] {
        let counts: Vec<usize> = parse_csv(&sample, d).iter().map(Vec::len).collect();
        if counts.is_empty() {
            continue;
        }
        // The most frequent column count, the larger one when two are equally frequent.
        let mut freq: Vec<(usize, usize)> = Vec::new();
        for c in counts {
            match freq.iter_mut().find(|(k, _)| *k == c) {
                Some(entry) => entry.1 += 1,
                None => freq.push((c, 1)),
            }
        }
        let (mode, n) = freq.iter().copied().max_by_key(|&(k, n)| (n, k)).unwrap_or((0, 0));
        if mode < 2 {
            continue;
        }
        let score = (n * 10 + mode) as i64;
        if score > best_score {
            best = d;
            best_score = score;
        }
    }
    best
}

/// A header name as the synonym lists write it: lower case, no accents, punctuation as spaces.
pub fn norm_header(h: &str) -> String {
    // NFD, drop U+0300 to U+036F, lower case; then everything but `a-z0-9/ ()` becomes a space and spaces collapse.
    let lowered: String = h.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut pending_space = false;
    for c in lowered.chars() {
        let kept = matches!(c, 'a'..='z' | '0'..='9' | '/' | '(' | ')');
        if kept {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(c);
        } else {
            // A space, a quote or anything else outside the set separates words.
            pending_space = true;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_quotes_doubled_quotes_and_delimiters_inside_fields() {
        assert_eq!(parse_csv("a;\"b;c\";\"d \"\"e\"\"\"\n", ';'), vec![vec!["a", "b;c", "d \"e\""]]);
    }

    #[test]
    fn rows_of_every_line_ending_and_empty_lines() {
        assert_eq!(parse_csv("a,b\r\n\r\nc,d\re,f\n,\n", ','), vec![vec!["a", "b"], vec!["c", "d"], vec!["e", "f"]]);
        assert_eq!(parse_csv("\"x\ny\",z", ','), vec![vec!["x\ny", "z"]]);
        assert_eq!(parse_csv("  \"q\"tail,x", ','), vec![vec!["qtail", "x"]]);
    }

    #[test]
    fn decodes_like_text_decoder() {
        assert_eq!(decode(b"\xef\xbb\xbfab"), ("ab".to_owned(), "utf-8"));
        assert_eq!(decode(b"\xef\xbb\xbf\xef\xbb\xbfab"), ("ab".to_owned(), "utf-8"), "the decoder drops a second mark too");
        assert_eq!(decode(b"\xff\xfea\x00b\x00"), ("ab".to_owned(), "utf-16le"));
        assert_eq!(decode(b"\xfe\xff\x00a\x00b"), ("ab".to_owned(), "utf-16be"));
        assert_eq!(decode(b"caf\xe9 \x80"), ("caf\u{e9} \u{20ac}".to_owned(), "windows-1252"));
        assert_eq!(decode("caf\u{e9}".as_bytes()).1, "utf-8");
        assert_eq!(decode(b"\xff\xfea\x00b").0, "a\u{fffd}", "an odd byte is replaced");
    }

    #[test]
    fn picks_the_delimiter_with_the_most_consistent_columns() {
        assert_eq!(detect_delimiter("a;b;c\n1;2;3\n"), ';');
        assert_eq!(detect_delimiter("a,b,c\n1,2,3\n"), ',');
        assert_eq!(detect_delimiter("a\tb\n1\t2\n"), '\t');
        assert_eq!(detect_delimiter("a|b\n1|2\n"), '|');
        assert_eq!(detect_delimiter("just text"), ';');
        assert_eq!(detect_delimiter("a;b,c\n1;2,3\n"), ';', "equal scores: the earlier delimiter stays");
    }

    #[test]
    fn header_names_lose_accents_and_punctuation() {
        assert_eq!(norm_header("  Naam / Omschrijving "), "naam / omschrijving");
        assert_eq!(norm_header("Begünstigter/Zahlungspflichtiger"), "begunstigter/zahlungspflichtiger");
        assert_eq!(norm_header("Date d'exécution"), "date d execution");
        assert_eq!(norm_header("Betrag ( )"), "betrag ( )");
        assert_eq!(norm_header("Gläubiger ID"), "glaubiger id");
        assert_eq!(norm_header("Währung"), "wahrung");
        assert_eq!(norm_header("Rekening-nr."), "rekening nr");
    }
}
