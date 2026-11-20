//! The reader: text, geometry, limits, errors (the cases of tests/pdf-reader.test.ts and the layouts of tests/pdf-layouts.test.ts that
//! concern `extractText`), fonts without ToUnicode, and the answers of the reader process.
mod support;
use kb_pdf::*;
use std::time::Duration;
use support::*;

fn read(bytes: Vec<u8>) -> Result<PdfText, ReadError> {
    read_guarded(bytes, Duration::from_secs(60)).map(|(t, _)| t)
}

fn texts(t: &PdfText, page: usize) -> Vec<String> {
    t.pages[page].items.iter().map(|i| i.str.clone()).collect()
}

#[test]
fn reads_a_statement_page_by_page_with_positions() {
    let text = read(make_pdf(&statement_pages(), &Opts::default())).unwrap();
    assert_eq!(text.page_count, 3);
    assert_eq!(text.pages.len(), 3);
    assert_eq!((text.pages[0].width, text.pages[0].height), (595.0, 842.0));
    assert_eq!(texts(&text, 2), vec!["09/11/2026", "Delhaize", "45.50", "2912.00"]);
    let first = &text.pages[0].items[0];
    assert_eq!(first.str, "Statement of account");
    // x as written, y upward from the bottom of the page, h the font size
    assert!((first.x - 40.0).abs() < 1e-6 && (first.y - 780.0).abs() < 1e-6 && (first.h - 9.0).abs() < 1e-6);
    // Helvetica 9 pt: "Statement of account" is about 85 points wide
    assert!((first.w - 85.05).abs() < 0.1, "{}", first.w);
}

#[test]
fn flate_compressed_content_reads_the_same() {
    let plain = read(make_pdf(&statement_pages(), &Opts::default())).unwrap();
    let flate = read(make_pdf(&statement_pages(), &Opts { flate: true, ..Opts::default() })).unwrap();
    assert_eq!(plain, flate);
}

#[test]
fn keeps_pages_without_text_and_reports_a_scan_for_a_file_without_any() {
    let pages = vec![
        PageSpec { texts: vec![t(40.0, 700.0, "A letter from the bank that is not a statement at all")], ..PageSpec::default() },
        PageSpec::default(),
    ];
    let text = read(make_pdf(&pages, &Opts::default())).unwrap();
    assert_eq!(text.page_count, 2);
    assert!(text.pages[1].items.is_empty());
    assert_eq!(read(make_pdf(&[PageSpec::default()], &Opts::default())).unwrap_err(), ReadError::Scanned);
    // fewer than 20 characters per page on average
    assert_eq!(
        read(make_pdf(&[PageSpec { texts: vec![t(40.0, 700.0, "page 1")], ..PageSpec::default() }], &Opts::default())).unwrap_err(),
        ReadError::Scanned
    );
}

#[test]
fn error_codes_are_those_of_the_reader_protocol() {
    assert_eq!(read(make_pdf(&statement_pages(), &Opts { encrypted: true, ..Opts::default() })).unwrap_err().code(), "import.pdf_password");
    assert_eq!(read(b"a,b\n1,2\n".to_vec()).unwrap_err().code(), "import.pdf_broken");
    assert_eq!(read(Vec::new()).unwrap_err().code(), "import.pdf_broken");
    let whole = make_pdf(&statement_pages(), &Opts::default());
    // a file cut in half is repaired as far as it goes, or is called broken or empty; never anything else
    assert!(matches!(read(whole[..whole.len() / 2].to_vec()), Ok(_) | Err(ReadError::Broken | ReadError::Scanned)));
    assert_eq!(ReadError::from_code("import.pdf_scanned"), Some(ReadError::Scanned));
    assert_eq!(ReadError::from_code("auth.locked"), None);
}

#[test]
fn limits_of_pages_and_of_a_decompression_bomb() {
    let page = PageSpec { texts: vec![t(40.0, 700.0, "Hello limits, this is a long enough text for a page")], ..PageSpec::default() };
    assert_eq!(read(make_pdf(&vec![page.clone(); MAX_PAGES], &Opts::default())).unwrap().page_count, MAX_PAGES);
    assert_eq!(read(make_pdf(&vec![page; MAX_PAGES + 1], &Opts::default())).unwrap_err(), ReadError::TooLarge);
    // 4 MB of zeros as the first page's content: read as an empty page, not refused
    let filler = make_pdf(&[PageSpec::default()], &Opts { flate: true, filler: Some(4 * 1024 * 1024), ..Opts::default() });
    assert_eq!(read(filler).unwrap_err(), ReadError::Scanned);
}

#[test]
fn too_many_pieces_or_characters_are_refused() {
    // Pieces: 100,001 lines of text one line apart (each its own piece)
    let many = |n: usize, text: &str| PageSpec {
        texts: (0..n).map(|i| t(10.0, 800.0 - (i % 700) as f64, &format!("{text}{i}"))).collect(),
        ..PageSpec::default()
    };
    assert_eq!(read(make_pdf(&[many(MAX_ITEMS + 1, "Line ")], &Opts::default())).unwrap_err(), ReadError::TooLarge);
    // Characters: 10,001 pieces of 100 characters (a piece can not be longer than the page is wide)
    let long =
        PageSpec { texts: (0..10_001).map(|i| t(10.0, 800.0 - (i % 700) as f64, &"a".repeat(100))).collect(), ..PageSpec::default() };
    assert_eq!(read(make_pdf(&[long], &Opts::default())).unwrap_err(), ReadError::TooLarge);
}

#[test]
fn a_turned_page_and_turned_text_read_upright() {
    // A landscape page stored as a portrait page with /Rotate 90, the text drawn upward, as tests/pdf-layouts.test.ts makes it.
    let shown = |x: f64, y: f64, text: &str| TextSpec { x: 595.0 - y, y: x, text: text.to_string(), size: Some(7.0), turned: true };
    let page = PageSpec {
        width: Some(595.0),
        height: Some(842.0),
        rotate: Some(90),
        texts: vec![shown(34.0, 476.0, "Rekeningnummer"), shown(34.0, 449.0, "BE71 0961 2345 6769 and some more text")],
    };
    let text = read(make_pdf(&[page], &Opts::default())).unwrap();
    assert_eq!((text.pages[0].width, text.pages[0].height), (842.0, 595.0));
    let a = &text.pages[0].items[0];
    assert_eq!(a.str, "Rekeningnummer");
    assert!((a.x - 34.0).abs() < 1e-3 && (a.y - 476.0).abs() < 1e-3, "{a:?}");
    // the rotation-free reading of 180 and 270
    for (rotate, (w, h)) in [(180, (595.0, 842.0)), (270, (842.0, 595.0))] {
        let p = PageSpec {
            rotate: Some(rotate),
            texts: vec![t(100.0, 700.0, "Some upright text on a turned page, long enough")],
            ..PageSpec::default()
        };
        let r = read(make_pdf(&[p], &Opts::default())).unwrap();
        assert_eq!((r.pages[0].width, r.pages[0].height), (w, h));
        assert_eq!(r.pages[0].items[0].str, "Some upright text on a turned page, long enough");
    }
}

#[test]
fn glyphs_become_pieces_by_the_gap_rules_of_pdf_js() {
    // Two pieces side by side: a gap of 0.3 em or more starts a new piece, a small gap is a space, no gap joins.
    let page = PageSpec {
        texts: vec![
            t(40.0, 700.0, "Hello"),
            t(40.0 + 5.0 * 5.0, 700.0, "World, and then enough text to pass"),
            t(300.0, 700.0, "far away piece"),
        ],
        ..PageSpec::default()
    };
    let text = read(make_pdf(&[page], &Opts::default())).unwrap();
    assert!(text.pages[0].items.len() >= 2);
    assert_eq!(text.pages[0].items.last().unwrap().str, "far away piece");
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/fixtures/{name}.pdf", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn cells(t: &PdfText) -> Vec<Vec<String>> {
    to_lines(t).iter().map(|l| l.cells.iter().map(|c| c.text.clone()).collect()).collect()
}

#[test]
fn fonts_without_to_unicode_are_read_from_the_font_program() {
    // The same invented table in six files (made by rust/parity/pdf/gen_cid_matrix.py): with a ToUnicode map, and without one in
    // an Identity-H CID font, with a CIDToGIDMap stream, with a font that has glyph names but no cmap, and without names too.
    let (reference, stats) = read_guarded(fixture("ref_with_tounicode"), Duration::from_secs(60)).unwrap();
    assert_eq!(stats.recovered_glyphs, 0);
    assert_eq!(cells(&reference)[0], vec!["Statement of account"]);
    assert_eq!(cells(&reference).len(), 6);
    for name in ["cid_identity_full_font", "cid_cidtogid_stream", "cid_no_cmap_names_only"] {
        let (text, stats) = read_guarded(fixture(name), Duration::from_secs(60)).unwrap();
        assert!(stats.recovered_glyphs > 100, "{name}: {}", stats.recovered_glyphs);
        assert_eq!(cells(&text), cells(&reference), "{name}");
    }
    // Nothing in the font to say which character a glyph is: the text cannot be read, which is a scan as far as anyone can tell.
    assert_eq!(read(fixture("cid_no_cmap_no_names")).unwrap_err(), ReadError::Scanned);
    // A symbolic simple font without Encoding: the ASCII lines are right.
    let simple = read(fixture("truetype_simple_symbolic")).unwrap();
    let (got, want) = (cells(&simple), cells(&reference));
    assert_eq!(got.len(), want.len());
    for (g, w) in got.iter().zip(&want) {
        if !w.iter().any(|c| c.contains("Caf")) {
            assert_eq!(g, w);
        }
    }
}

#[test]
fn the_reader_answer_checks_of_the_protocol() {
    let item = Item { str: "a".into(), x: 1.0, y: 2.0, w: 3.0, h: 4.0 };
    let text = |items: Vec<Item>| PdfText { page_count: 1, pages: vec![Page { n: 1, width: 595.0, height: 842.0, items }] };
    assert!(is_valid_pdf_text(&text(vec![item.clone()])));
    // numbers that are not finite or out of range
    for bad in [Item { x: f64::NAN, ..item.clone() }, Item { y: f64::INFINITY, ..item.clone() }, Item { w: 1e12, ..item.clone() }] {
        assert!(!is_valid_pdf_text(&text(vec![bad])));
    }
    assert!(!is_valid_pdf_text(&PdfText { page_count: MAX_PAGES + 1, pages: vec![] }));
    assert!(!is_valid_pdf_text(&PdfText { page_count: 0, pages: vec![] }));
    // too much text
    assert!(is_valid_pdf_text(&text(vec![item.clone(); MAX_ITEMS])));
    assert!(!is_valid_pdf_text(&text(vec![item.clone(); MAX_ITEMS + 1])));
    let long = |n: usize| Item { str: "a".repeat(n), ..item.clone() };
    assert!(!is_valid_pdf_text(&text(vec![long(MAX_CHARS + 1)])));
    assert!(!is_valid_pdf_text(&text(vec![long(600_000), long(600_000)])));
    // JSON: extra fields, missing fields and mistyped ones are not accepted
    let parse = |s: &str| serde_json::from_str::<ReaderMessage>(s);
    assert!(parse(r#"{"progress":{"page":1,"pages":3}}"#).is_ok());
    assert!(parse(r#"{"ok":false,"code":"import.pdf_scanned","message":"No text."}"#).is_ok());
    assert!(parse(
        r#"{"ok":true,"result":{"pageCount":1,"pages":[{"n":1,"width":1,"height":1,"items":[{"str":"a","x":1,"y":2,"w":3,"h":4}]}]}}"#
    )
    .is_ok());
    assert!(parse(
        r#"{"ok":true,"result":{"pageCount":1,"pages":[{"n":1,"width":1,"height":1,"items":[{"str":"a","x":1,"y":2,"w":3,"h":4,"z":5}]}]}}"#
    )
    .is_err());
    assert!(parse(
        r#"{"ok":true,"result":{"pageCount":1,"pages":[{"n":1,"width":1,"height":1,"items":[{"str":5,"x":1,"y":2,"w":3,"h":4}]}]}}"#
    )
    .is_err());
    assert!(parse(r#"{"ok":true,"result":{"pageCount":1,"extra":1,"pages":[]}}"#).is_err());
    assert!(parse(r#""hello""#).is_err());
}
