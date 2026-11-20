//! What is sent to the assistant: the cases of tests/pdf-plan.test.ts ("masked lines"), invented data.
use kb_pdf::*;

const OTHER: &str = "BE71096123456769";

/// A line of cells (x, text); id = position in reading order, one page unless told otherwise.
fn line(id: usize, cells: &[(f64, &str)], page: usize) -> PdfLine {
    PdfLine {
        id,
        page,
        y: 800.0 - id as f64 * 12.0,
        page_height: Some(842.0),
        cells: cells
            .iter()
            .map(|(x, text)| PdfCell { text: text.to_string(), x0: *x, x1: x + text.chars().count() as f64 * 5.0 })
            .collect(),
    }
}

fn ids(m: &[MaskedLine]) -> Vec<usize> {
    m.iter().map(|m| m.id).collect()
}

#[test]
fn writes_id_page_and_every_cell_with_its_position_with_numbers_masked() {
    let lines = vec![
        line(1, &[(60.0, "03/11"), (140.0, "ALBERT HEIJN BRUSSEL"), (510.0, "45,10-")], 1),
        line(2, &[(140.0, &format!("Transfer to Jan Peeters {OTHER}"))], 1),
        line(3, &[(10.0, "Card 4929 1234 5678 9012 shop")], 1),
        line(4, &[(10.0, "BE71 0961"), (200.0, "2345 6769")], 1),
    ];
    let sent = masked_lines(&lines, None);
    assert_eq!(sent[0].text, "L1 p1 | x60 03/11 | x140 ALBERT HEIJN BRUSSEL | x510 45,10-");
    assert_eq!(sent[1].text, "L2 p1 | x140 Transfer to Jan Peeters BE…6769");
    assert_eq!(sent[2].text, "L3 p1 | x10 Card …9012 shop");
    // an account number split over two cells is recognised as a whole and sent as one piece
    assert!(!sent[3].text.contains("2345") && !sent[3].text.contains("0961"));
    assert!(sent[3].text.contains("BE…6769"));
    assert_eq!(sent[1].plain, "Transfer to Jan Peeters BE…6769");
}

#[test]
fn leaves_out_everything_above_the_table_when_its_header_is_known() {
    let lines = vec![
        line(0, &[(40.0, "Jan Jansen")], 1),
        line(1, &[(40.0, "Main Street 1, Springfield")], 1),
        line(2, &[(60.0, "Date"), (140.0, "Description"), (510.0, "Amount")], 1),
        line(3, &[(60.0, "03/11"), (140.0, "Shop"), (510.0, "1,00-")], 1),
    ];
    let start = table_start(&lines);
    assert_eq!(start, Some(2));
    assert_eq!(ids(&masked_lines(&lines, start)), vec![2, 3]);
    // No header known: everything goes, masked.
    assert_eq!(table_start(&lines[..2]), None);
    assert_eq!(ids(&masked_lines(&lines, None)), vec![0, 1, 2, 3]);
}

#[test]
fn without_a_table_header_still_leaves_out_the_name_and_address_above_the_first_transaction() {
    let lines = vec![
        line(0, &[(40.0, "Jan Jansen")], 1),
        line(1, &[(40.0, "Main Street 1, Springfield")], 1),
        line(2, &[(40.0, "Statement 01/11/2026 to 30/11/2026")], 1),
        line(3, &[(60.0, "03/11"), (140.0, "Shop"), (510.0, "1,00-")], 1),
        line(4, &[(140.0, "More about the shop")], 1),
        line(5, &[(60.0, "05/11"), (140.0, "Salary"), (510.0, "2.000,00")], 1),
    ];
    assert_eq!(table_start(&lines), None);
    assert_eq!(first_line_sent(&lines), Some(3));
    let text = masked_lines(&lines, first_line_sent(&lines)).iter().map(|m| m.text.clone()).collect::<Vec<_>>().join("\n");
    assert!(!text.contains("Jansen") && !text.contains("Main Street") && !text.contains("Statement"));
    assert!(text.contains("Shop") && text.contains("More about the shop") && text.contains("Salary"));
    // Nothing that looks like a transaction: nothing is sent.
    let odd: Vec<PdfLine> = (0..12).map(|i| line(i, &[(40.0, &format!("Words {i}"))], 1)).collect();
    assert_eq!(first_line_sent(&odd), None);
    assert!(lines_to_send(&odd).is_empty());
    assert_eq!(first_line_sent(&[line(0, &[(40.0, "Only a name")], 1)]), None);
    assert_eq!(first_line_sent(&[]), None);
}

#[test]
fn the_date_forms_of_a_transaction_line() {
    let at = |text: &str| first_line_sent(&[line(0, &[(40.0, "Name")], 1), line(1, &[(60.0, text), (510.0, "12,50")], 1)]);
    for yes in ["2026-11-03 Shop", "03/11/2026 Shop", "03.11.26 Shop", "03-11-2026 Shop", "03/11 Shop", "03.11. Shop", "Shop 3 NOV"] {
        assert_eq!(at(yes), Some(1), "{yes}");
    }
    // no date, or a number that only looks like one
    for no in ["Shop", "Shop 1234/5678", "Shop 03/11/ x"] {
        assert_eq!(at(no), None, "{no}");
    }
}

#[test]
fn splits_into_parts_of_four_pages_and_repeats_the_last_three_lines_as_context() {
    let many: Vec<PdfLine> = (0..9)
        .flat_map(|p| {
            vec![line(p * 2, &[(60.0, &format!("0{}/11", p + 1)), (510.0, "1,00")], p + 1), line(p * 2 + 1, &[(60.0, "x")], p + 1)]
        })
        .collect();
    let parts = split_parts(&masked_lines(&many, None));
    let pages: Vec<Vec<usize>> = parts
        .iter()
        .map(|p| {
            let mut v: Vec<usize> = p.own.iter().map(|m| m.page).collect();
            v.dedup();
            v
        })
        .collect();
    assert_eq!(pages, vec![vec![1, 2, 3, 4], vec![5, 6, 7, 8], vec![9]]);
    assert!(parts[0].context.is_empty());
    assert_eq!(ids(&parts[1].context), vec![5, 6, 7]);
    assert!(part_text(&parts[1]).contains("(context only) L5 p3"));
    assert!(part_text(&parts[1]).starts_with("Part 2 of 3. Lines marked (context only) end the part before"));
    // The character limit splits too.
    let wide: Vec<PdfLine> = (0..5).map(|i| line(i, &[(10.0, &"x".repeat(900))], 1)).collect();
    assert_eq!(split_parts(&masked_lines(&wide, None)).len(), 1);
    let wider: Vec<PdfLine> = (0..80).map(|i| line(i, &[(10.0, &"y".repeat(900))], 1)).collect();
    assert!(split_parts(&masked_lines(&wider, None)).len() > 1);
}

#[test]
fn a_part_that_did_not_fit_is_cut_at_a_date_near_the_middle() {
    let lines: Vec<PdfLine> = (0..40)
        .map(|i| if i % 4 == 0 { line(i, &[(60.0, "03/11"), (140.0, "Shop")], 1) } else { line(i, &[(140.0, "more")], 1) })
        .collect();
    let part = &split_parts(&masked_lines(&lines, None))[0];
    let (a, b) = split_part(part).unwrap();
    assert_eq!(a.own.len() + b.own.len(), 40);
    assert!(b.own[0].text.contains("x60 03/11"));
    assert_eq!(b.context, a.own[a.own.len() - 3..].to_vec());
    let small = split_parts(&masked_lines(&lines[..10], None));
    assert!(split_part(&small[0]).is_none());
}

#[test]
fn the_preview_is_the_text_that_is_sent_and_long_statements_are_refused() {
    let lines: Vec<PdfLine> = vec![
        line(0, &[(40.0, "Jan Jansen")], 1),
        line(1, &[(60.0, "Date"), (140.0, "Description"), (510.0, "Amount")], 1),
        line(2, &[(60.0, "03/11"), (140.0, "Shop"), (510.0, "1,00-")], 1),
    ];
    let p = preview_text(&lines).unwrap();
    assert_eq!((p.pages, p.parts), (1, 1));
    assert_eq!(p.chars, p.text.chars().count());
    assert_eq!(p.approx_tokens, p.chars.div_ceil(3));
    assert!(!p.text.contains("Jansen"));
    let masked = lines_to_send(&lines);
    let sent = part_text(&split_parts(&masked)[0]);
    assert_eq!(sent.split('\n').skip(2).collect::<Vec<_>>().join("\n"), p.text);
    // 41 pages
    let long: Vec<PdfLine> = (0..41).map(|p| line(p, &[(60.0, "03/11"), (140.0, "Shop"), (510.0, "1,00-")], p + 1)).collect();
    assert_eq!(preview_text(&long).unwrap_err().code, "assistant.pdf_too_long");
    assert_eq!(preview_text(&[]).unwrap_err().code, "assistant.pdf_empty");
    assert_eq!(preview_text(&[line(0, &[(40.0, "Only a name")], 1)]).unwrap_err().code, "assistant.pdf_no_table");
}

/// The statement of tests/pdf-plan.test.ts (HEADER): the holder's name and address repeat at the top of pages 2 and 3.
fn header_statement() -> Vec<PdfLine> {
    let head = [(60.0, "Date"), (140.0, "Description"), (510.0, "Amount")];
    vec![
        line(0, &[(40.0, "Ilse Vermeulen")], 1),
        line(1, &[(40.0, "Kerkstraat 12, 8000 Gent")], 1),
        line(2, &head, 1),
        line(3, &[(60.0, "03/11"), (140.0, "ALBERT HEIJN"), (510.0, "45,10-")], 1),
        line(4, &[(140.0, "continued on next page")], 1),
        line(5, &[(40.0, "Ilse Vermeulen")], 2),
        line(6, &[(40.0, "Kerkstraat 12, 8000 Gent")], 2),
        line(7, &[(40.0, "Customer 4455667")], 2),
        line(8, &head, 2),
        line(9, &[(60.0, "05/11"), (140.0, "SALARY NOVEMBER"), (510.0, "2.000,00")], 2),
        line(10, &[(40.0, "Ilse Vermeulen")], 3),
        line(11, &[(40.0, "Kerkstraat 12, 8000 Gent")], 3),
        line(12, &[(60.0, "07/11"), (140.0, "TRAM TICKET"), (510.0, "2,40-")], 3),
        line(13, &[(140.0, "Thank you for banking with us")], 3),
    ]
}

#[test]
fn sends_only_the_table_rows_not_a_repeated_holder_name_or_address_on_later_pages() {
    let sent = lines_to_send(&header_statement());
    assert_eq!(ids(&sent), vec![2, 3, 4, 9, 12, 13]);
    let text = preview_text_of(&sent);
    for secret in ["Ilse", "Vermeulen", "Kerkstraat", "Gent", "Customer", "4455667"] {
        assert!(!text.contains(secret), "{secret}");
    }
    for row in ["ALBERT HEIJN", "SALARY NOVEMBER", "TRAM TICKET"] {
        assert!(text.contains(row), "{row}");
    }
}

#[test]
fn a_later_page_without_a_transaction_line_is_dropped_and_one_with_only_the_header_is_kept() {
    let all = header_statement();
    let head = [(60.0, "Date"), (140.0, "Description"), (510.0, "Amount")];
    let mut quiet: Vec<PdfLine> = all[..5].to_vec();
    quiet.extend([
        line(5, &[(40.0, "Ilse Vermeulen")], 2),
        line(6, &[(40.0, "Kerkstraat 12")], 2),
        line(7, &head, 3),
        line(8, &[(140.0, "carried over")], 3),
    ]);
    assert_eq!(ids(&lines_to_send(&quiet)), vec![2, 3, 4, 7, 8]);
}

#[test]
fn parts_still_work_over_pages_after_the_header_lines_are_left_out() {
    let parts = split_parts(&lines_to_send(&header_statement()));
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].own.iter().map(|m| m.page).collect::<Vec<_>>(), vec![1, 1, 1, 2, 3, 3]);
}
