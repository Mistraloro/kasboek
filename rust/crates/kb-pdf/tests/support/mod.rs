//! A small PDF writer for the tests, the Rust twin of tests/helpers/make-pdf.ts: a Helvetica font (not embedded) and the given
//! text on each page, optionally Flate-compressed or "encrypted". All text is invented.
#![allow(dead_code)]
use flate2::{write::ZlibEncoder, Compression};
use std::io::Write;

#[derive(Clone, Default)]
pub struct TextSpec {
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub size: Option<f64>,
    /// Written upward instead of to the right.
    pub turned: bool,
}

pub fn t(x: f64, y: f64, text: &str) -> TextSpec {
    TextSpec { x, y, text: text.to_string(), size: None, turned: false }
}

#[derive(Clone, Default)]
pub struct PageSpec {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub rotate: Option<u32>,
    pub texts: Vec<TextSpec>,
}

#[derive(Clone, Default)]
pub struct Opts {
    pub flate: bool,
    pub encrypted: bool,
    /// Replaces the first page's content with this many zero bytes (a decompression bomb with `flate`).
    pub filler: Option<usize>,
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)")
}

fn num(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

pub fn make_pdf(pages: &[PageSpec], opts: &Opts) -> Vec<u8> {
    let mut objects: Vec<Vec<u8>> = vec![Vec::new(); 4 + pages.len() * 2];
    let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", 4 + i * 2)).collect();
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>".to_vec();
    objects[2] = format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages.len()).into_bytes();
    objects[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec();
    for (i, p) in pages.iter().enumerate() {
        let id = 4 + i * 2;
        let body: Vec<u8> = match opts.filler {
            Some(n) if i == 0 => vec![0; n],
            _ => p
                .texts
                .iter()
                .map(|t| {
                    let place =
                        if t.turned { format!("0 1 -1 0 {} {} Tm", num(t.x), num(t.y)) } else { format!("{} {} Td", num(t.x), num(t.y)) };
                    format!("BT /F1 {} Tf {} ({}) Tj ET", num(t.size.unwrap_or(9.0)), place, escape(&t.text))
                })
                .collect::<Vec<_>>()
                .join("\n")
                .chars()
                .map(|c| c as u32 as u8)
                .collect(),
        };
        let data = if opts.flate {
            let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
            e.write_all(&body).unwrap();
            e.finish().unwrap()
        } else {
            body
        };
        objects[id] = format!(
            "<< /Type /PageSpec /Parent 2 0 R /MediaBox [0 0 {} {}]{} /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>",
            num(p.width.unwrap_or(595.0)),
            num(p.height.unwrap_or(842.0)),
            p.rotate.map(|r| format!(" /Rotate {r}")).unwrap_or_default(),
            id + 1
        )
        .into_bytes();
        let mut stream =
            format!("<< /Length {}{} >>\nstream\n", data.len(), if opts.flate { " /Filter /FlateDecode" } else { "" }).into_bytes();
        stream.extend_from_slice(&data);
        stream.extend_from_slice(b"\nendstream");
        objects[id + 1] = stream;
    }
    let encrypt_id = objects.len();
    if opts.encrypted {
        objects.push(format!("<< /Filter /Standard /V 1 /R 2 /O <{}> /U <{}> /P -4 >>", "ab".repeat(32), "cd".repeat(32)).into_bytes());
    }
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![0usize; objects.len()];
    for (id, obj) in objects.iter().enumerate().skip(1) {
        offsets[id] = out.len();
        out.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
        out.extend_from_slice(obj);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref_at = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len()).as_bytes());
    for o in &offsets[1..] {
        out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    let encrypt = if opts.encrypted {
        format!(" /Encrypt {encrypt_id} 0 R /ID [<{}> <{}>]", "01".repeat(16), "01".repeat(16))
    } else {
        String::new()
    };
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R{encrypt} >>\nstartxref\n{xref_at}\n%%EOF\n", objects.len()).as_bytes());
    out
}

/// The three-page statement of tests/helpers/statement-pdf.ts: four transactions with printed opening and closing balances.
pub fn statement_pages() -> Vec<PageSpec> {
    const XS: [f64; 5] = [40.0, 110.0, 300.0, 380.0, 460.0];
    let page = |rows: &[&[&str]]| PageSpec {
        texts: rows
            .iter()
            .enumerate()
            .flat_map(|(r, row)| {
                row.iter().enumerate().filter(|(_, c)| !c.is_empty()).map(move |(i, c)| t(XS[i], 780.0 - r as f64 * 14.0, c))
            })
            .collect(),
        ..PageSpec::default()
    };
    let header: &[&str] = &["Date", "Description", "Debit", "Credit", "Balance"];
    vec![
        page(&[
            &["Statement of account"],
            &["Account BE68539007547034"],
            &["Period 01/11/2026 to 30/11/2026"],
            &["Opening balance", "1,000.00"],
            &["Closing balance", "2,912.00"],
            header,
            &["03/11/2026", "Albert Heijn Brussel", "12.50", "", "987.50"],
        ]),
        page(&[&["05/11/2026", "Salary November", "", "2000.00", "2987.50"], &["07/11/2026", "Proximus", "30.00", "", "2957.50"]]),
        page(&[&["09/11/2026", "Delhaize", "45.50", "", "2912.00"]]),
    ]
}
