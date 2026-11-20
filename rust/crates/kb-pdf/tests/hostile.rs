//! Hostile and damaged input: hand-made cases (loops, recursion, depth, absurd numbers) and seeded random mutation of valid files (no
//! cargo-fuzz needed). The reader must answer every one with a result or one of the four error codes, never panic (a deadline hit is the one
//! allowed unwind) and never run past its deadline by much. KB_FUZZ_N sets the number of mutants (default 600).
mod support;
use kb_pdf::reader::{read, DeadlineHit};
use kb_pdf::*;
use std::time::{Duration, Instant};
use support::*;

/// Runs `read` like the reader process does (a thread with a big stack), telling an internal panic from the deadline.
fn outcome(bytes: Vec<u8>, timeout: Duration) -> Result<(), ReadError> {
    let deadline = Instant::now() + timeout;
    let h = std::thread::Builder::new()
        .stack_size(kb_pdf::process::STACK_BYTES)
        .spawn(move || std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read(bytes, deadline, &mut |_, _| {}).map(|_| ()))))
        .unwrap();
    match h.join().unwrap() {
        Ok(r) => r,
        Err(p) if p.is::<DeadlineHit>() => Err(ReadError::TooLarge),
        Err(p) => {
            panic!("internal panic: {:?}", p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())))
        }
    }
}

/// xorshift64*: a fixed sequence, no dependency
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn sources() -> Vec<Vec<u8>> {
    let fixture = |n: &str| std::fs::read(format!("{}/tests/fixtures/{n}.pdf", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let turned = PageSpec {
        width: Some(595.0),
        height: Some(842.0),
        rotate: Some(90),
        texts: vec![TextSpec { x: 100.0, y: 30.0, text: "Turned text on a landscape page".into(), size: Some(7.0), turned: true }],
    };
    vec![
        make_pdf(&statement_pages(), &Opts::default()),
        make_pdf(&statement_pages(), &Opts { flate: true, ..Opts::default() }),
        make_pdf(&[turned], &Opts::default()),
        fixture("cid_identity_full_font"),
        fixture("cid_no_cmap_names_only"),
        fixture("truetype_simple_symbolic"),
    ]
}

fn mutate(src: &[u8], rng: &mut Rng) -> Vec<u8> {
    let mut data = src.to_vec();
    for _ in 0..[1, 3, 10, 50][rng.below(4)] {
        let i = rng.below(data.len());
        data[i] = if rng.below(10) < 7 { rng.next() as u8 } else { data[i] ^ (1 << rng.below(8)) };
    }
    match rng.below(10) {
        0 => data.truncate(rng.below(data.len())),
        1 => {
            let a = rng.below(data.len());
            let n = 1 + rng.below(200);
            data.drain(a..(a + n).min(data.len()));
        }
        2 => {
            let a = rng.below(data.len());
            let chunk: Vec<u8> = data[a..(a + 1 + rng.below(300)).min(data.len())].to_vec();
            let at = rng.below(data.len());
            data.splice(at..at, chunk);
        }
        _ => {}
    }
    data
}

#[test]
fn seeded_random_mutants_never_panic_or_hang() {
    let n: usize = std::env::var("KB_FUZZ_N").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
    let sources = sources();
    let mut rng = Rng(0x2026_1120);
    let mut counts = [0usize; 5];
    let started = Instant::now();
    for k in 0..n {
        let src = &sources[k % sources.len()];
        let data = mutate(src, &mut rng);
        let t = Instant::now();
        let r = outcome(data, Duration::from_secs(10));
        assert!(t.elapsed() < Duration::from_secs(12), "mutant {k} took {:?}", t.elapsed());
        counts[match r {
            Ok(()) => 0,
            Err(ReadError::Password) => 1,
            Err(ReadError::Broken) => 2,
            Err(ReadError::TooLarge) => 3,
            Err(ReadError::Scanned) => 4,
        }] += 1;
    }
    eprintln!(
        "{n} mutants in {:?}: ok {}, password {}, broken {}, too large {}, scanned {}",
        started.elapsed(),
        counts[0],
        counts[1],
        counts[2],
        counts[3],
        counts[4]
    );
    // Most single-byte changes leave the text readable: the mutation does something, and the reader copes
    assert!(counts[0] > n / 10, "{counts:?}");
}

fn pdf_with(objs: &[(u32, String)], trailer_extra: &str) -> Vec<u8> {
    let mut out = String::from("%PDF-1.4\n");
    let mut offs = std::collections::BTreeMap::new();
    for (id, body) in objs {
        offs.insert(*id, out.len());
        out += &format!("{id} 0 obj\n{body}\nendobj\n");
    }
    let n = objs.iter().map(|o| o.0).max().unwrap() + 1;
    let xref_at = out.len();
    out += &format!("xref\n0 {n}\n0000000000 65535 f \n");
    for i in 1..n {
        out += &match offs.get(&i) {
            Some(o) => format!("{o:010} 00000 n \n"),
            None => "0000000000 00000 f \n".to_string(),
        };
    }
    out += &format!("trailer\n<< /Size {n} /Root 1 0 R {trailer_extra} >>\nstartxref\n{xref_at}\n%%EOF\n");
    out.into_bytes()
}

fn stream(dict: &str, data: &str) -> String {
    format!("<< {dict} /Length {} >>\nstream\n{data}\nendstream", data.len())
}

const FONT: &str = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
const TEXT: &str = "BT /F1 10 Tf 40 700 Td (Hello hostile world, this is a long enough text for a page) Tj ET\n";

fn page(content: &str, extra: &str) -> Vec<(u32, String)> {
    vec![
        (1, "<< /Type /Catalog /Pages 2 0 R >>".into()),
        (2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>".into()),
        (3, FONT.into()),
        (
            4,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> {extra} >> /Contents 5 0 R >>"
            ),
        ),
        (5, stream("", content)),
    ]
}

#[test]
fn hand_made_hostile_files_get_an_answer() {
    let mut cases: Vec<(&str, Vec<u8>)> = Vec::new();
    cases.push(("empty", Vec::new()));
    cases.push(("header only", b"%PDF-1.4\n".to_vec()));
    cases.push((
        "garbage body",
        [b"%PDF-1.4\n".to_vec(), (0..200_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect()].concat(),
    ));
    let good = pdf_with(&page(TEXT, ""), "");
    cases.push(("truncated half", good[..good.len() / 2].to_vec()));
    cases.push(("truncated no xref", good[..good.windows(4).rposition(|w| w == b"xref").unwrap()].to_vec()));
    cases.push(("wrong stream length", String::from_utf8(good.clone()).unwrap().replace("/Length ", "/Length 9").into_bytes()));
    // loops and recursion
    let mut o = page(TEXT, "");
    o[1].1 = "<< /Type /Pages /Kids [2 0 R 4 0 R] /Count 2 >>".into();
    cases.push(("page that is its own kid", pdf_with(&o, "")));
    let mut o = page(TEXT, "");
    o[4].1 = "[5 0 R 5 0 R]".into();
    cases.push(("contents array of itself", pdf_with(&o, "")));
    cases.push(("xref loop", pdf_with(&page(TEXT, ""), "/Prev 9").to_vec()));
    let form = |body: &str| {
        stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> /XObject << /A 6 0 R /B 7 0 R >> >>",
            body,
        )
    };
    let mut o = page(&format!("/A Do\n{TEXT}"), "/XObject << /A 6 0 R >>");
    o.push((6, form("/B Do BT /F1 10 Tf 40 600 Td (Loop A text text text text text) Tj ET")));
    o.push((7, form("/A Do")));
    cases.push(("mutual form recursion", pdf_with(&o, "")));
    let t3 = "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 8 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [500] /Resources << /Font << /T 6 0 R >> >> >>";
    let mut o = page(&format!("BT /T 12 Tf 40 600 Td (aaaa) Tj ET\n{TEXT}"), "");
    o[3].1 = o[3].1.replace("/F1 3 0 R", "/F1 3 0 R /T 6 0 R");
    o.push((6, t3.into()));
    o.push((8, stream("", "500 0 d0 BT /T 1000 Tf (aa) Tj ET")));
    cases.push(("type3 glyph that shows its own font", pdf_with(&o, "")));
    // depth
    cases.push(("500,000 nested q", pdf_with(&page(&format!("{}{TEXT}", "q\n".repeat(500_000)), ""), "")));
    cases.push(("500,000 nested arrays in content", pdf_with(&page(&format!("{} ] TJ\n{TEXT}", "[".repeat(500_000)), ""), "")));
    cases.push((
        "200,000 nested dictionaries in content",
        pdf_with(&page(&format!("/X {}{} BDC\n{TEXT}", "<<".repeat(200_000), ">>".repeat(200_000)), ""), ""),
    ));
    let mut o = page(TEXT, "");
    o[3].1 = format!("{} /Junk {}{} >>", &o[3].1[..o[3].1.len() - 3], "[".repeat(150_000), "]".repeat(150_000));
    cases.push(("150,000 nested arrays in an object", pdf_with(&o, "")));
    let mut chain: Vec<(u32, String)> = vec![(1, "<< /Type /Catalog /Pages 10 0 R >>".into()), (3, FONT.into()), (5, stream("", TEXT))];
    for i in 0..5000u32 {
        chain.push((10 + i, format!("<< /Type /Pages /Kids [{} 0 R] /Count 1 /Parent {} 0 R >>", 11 + i, 9 + i)));
    }
    chain.push((
        5010,
        "<< /Type /Page /Parent 5009 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>".into(),
    ));
    cases.push(("page tree 5,000 deep", pdf_with(&chain, "")));
    // numbers
    cases.push(("absurd font size and matrix", pdf_with(&page(&format!("BT /F1 1e300 Tf 1e300 0 0 1e300 1e300 1e300 Tm (Huge) Tj ET\nBT /F1 0 Tf 40 700 Td (Zero) Tj ET\nBT /F1 10 Tf 0 0 0 0 40 700 Tm (Singular) Tj ET\n{TEXT}"), ""), "")));
    let mut o = page(TEXT, "");
    o[3].1 = o[3].1.replace("[0 0 595 842]", "[0 0 1e30 1e30]");
    cases.push(("media box of 1e30", pdf_with(&o, "")));
    let mut o = page(TEXT, "");
    o[3].1 = o[3].1.replace("[0 0 595 842]", "[0 0 0 0]");
    cases.push(("empty media box", pdf_with(&o, "")));
    cases.push(("1,000,000 operands", pdf_with(&page(&format!("{}Tj\n{TEXT}", "1 2 3 ".repeat(1_000_000)), ""), "")));
    cases.push(("no text on the page", pdf_with(&page("0 0 100 100 re f\n", ""), "")));
    // 100,000 overlapping ToUnicode ranges
    let cm = format!("/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 100000 beginbfrange\n{}endbfrange endcmap end end", "<0000> <FFFF> <0041>\n".repeat(100_000));
    let objs = vec![
        (1, "<< /Type /Catalog /Pages 2 0 R >>".to_string()),
        (2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>".into()),
        (3, "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>".into()),
        (6, "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>".into()),
        (7, stream("", &cm)),
        (4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>".into()),
        (5, stream("", "BT /F1 10 Tf 40 700 Td <00410042004300440045> Tj ET")),
    ];
    cases.push(("100,000 overlapping ToUnicode ranges", pdf_with(&objs, "")));
    for (name, data) in cases {
        let t = Instant::now();
        let r = outcome(data, Duration::from_secs(20));
        assert!(t.elapsed() < Duration::from_secs(25), "{name}: {:?}", t.elapsed());
        eprintln!("{name}: {r:?} in {:?}", t.elapsed());
    }
}
