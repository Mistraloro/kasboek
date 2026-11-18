# Spike C: a pure-Rust PDF text reader instead of pdf.js / pdfium

Question: can a reader in pure Rust (no pdfium, no C or C++ in the build) replace pdf.js for the statement import,
giving the same `PdfText` (pieces of text with `x`, `y`, `w`, `h` per page) to `src/core/pdf/lines.ts` and
`src/core/pdf/statement.ts`?

Answer in short: yes, with `hayro-interpret` + `hayro-syntax` 0.9 (published crates, MIT OR Apache-2.0) and about 200
lines of our own on top (`src/reader.rs`). On 33 invented statement PDFs the lines and cells that `toLines` builds match
pdf.js in 99.9 % of the cases and `readStatement` gives the same grid, balances, period and notes for every file that has
a table. It is 20 to 40 times faster than pdf.js on small files (4 to 6 times on 70 pages), uses 6 to 10 MB instead
of 110 to 170 MB, and survived 3,338 hostile and mutated files without a crash or a hang. Two things have to be added
around it (memory cap, clock) and one gap remains (fonts without ToUnicode). Details below.

Nothing here is wired into the app. Everything is invented data; no real bank PDF was read.

## Layout

| Path | What |
| --- | --- |
| `src/main.rs` | CLI: `kb-spike-pdf [ignored] FILE` prints `PdfText` as JSON (or `{"error": code}`) on stdout and `{"ms","rssMb"}` on stderr. Runs the work on a thread under `catch_unwind` with a deadline. |
| `src/reader.rs` | hayro `Device` that records glyphs, then merges them into pieces with pdf.js's gap rules. Limits, errors and page geometry as in `extract.ts`. |
| `src/model.rs` | Output types, the limits of `src/core/pdf/limits.ts` (150 pages, 100,000 items, 1,000,000 characters), 60 s, error codes of `protocol.ts`. |
| `src/cap.rs` | Global allocator that ends the process with `import.pdf_too_large` past 1 GiB of live heap. |
| `tools/gen_py.py` | Invented statements with reportlab and by hand (see Corpus). |
| `tools/corpus.run.ts`, `tools/layouts.ts` | Statements made with the repo helpers (`tests/helpers/make-pdf.ts`, `statement-pdf.ts`) and the layouts of `tests/pdf-layouts.test.ts`. Run under vitest only to reuse the TS helpers. |
| `tools/ref-entry.ts` | Bundles the app's own `extractText`, `toLines`, `readStatement` for node (rolldown), so the reference is exactly the app's pdf.js path. |
| `tools/compare.mjs`, `tools/diff.mjs` | Compare pdf.js and Rust per file; show the differing lines. |
| `tools/gen_hostile.py`, `tools/run_hostile.py` | Hostile and mutated inputs; run any reader over a directory and report crashes, hangs, memory. |
| `tools/run-all.sh` | Everything for the comparison in one go. |
| `eval-pdfcraft/` | Separate cargo project: the same corpus through `pdfcraft-render` (git dependency), for the comparison. |

Generated PDFs are written under `$WORK` (outside the repo). Nothing generated is kept in the repo.

## Rerun

```sh
cd rust/spike/pdf
cargo build --release                       # about 1 minute, 5.4 MB binary
WORK=/tmp/kbpdf tools/run-all.sh            # corpus + pdf.js + Rust + comparison table
WORK=/tmp/kbpdf PDF_DIR=/some/dir tools/run-all.sh   # the same on your own PDFs (the text of those is written to $WORK/ref and $WORK/rust-hayro: delete it afterwards)

# robustness
python3 tools/gen_hostile.py /tmp/kbpdf/corpus /tmp/kbpdf/hostile     # FUZZ=3000 for more mutated files
KB_PDF_TIMEOUT_MS=10000 python3 tools/run_hostile.py /tmp/kbpdf/hostile -- target/release/kb-spike-pdf hayro
NOLIMIT=1 python3 tools/run_hostile.py /tmp/kbpdf/hostile -- sh -c 'node --max-old-space-size=3072 /tmp/kbpdf/ref.mjs "$0" /dev/null'   # pdf.js, for comparison

# the pdfcraft variant (git dependency, 2.5 minutes to build)
(cd eval-pdfcraft && cargo build --release)
WORK=/tmp/kbpdf BIN=$PWD/eval-pdfcraft/target/release/kb-eval-pdfcraft BACKEND=pdfcraft tools/run-all.sh
```

Needs node (the repo's `node_modules`), python3 with reportlab, cargo 1.97.

## What pdf.js hands the TS side, and what the Rust side reproduces

`extractText` (`src/core/pdf/extract.ts`) calls `getDocument({disableFontFace, useSystemFonts: false, enableXfa: false,
stopAtErrors: false})`, then per page `getViewport({scale: 1})` and `streamTextContent()`. Items without text are dropped.
Each item becomes `{str, x, y, w, h}`:

* `x`, `y`: the item's transform (user space) mapped through the viewport transform, `y` upward from the bottom of the page as
  shown, so `/Rotate` and text matrices that turn the text are already applied; text running leftwards starts at `x - width`.
* `w`: item width; `h`: item height (the font size scaled by the text matrix).
* page `width` / `height` as shown (after `/Rotate`, crop box).
* Limits: 150 pages, 100,000 items, 1,000,000 characters, 60 s for the whole read in a separate process, errors
  `import.pdf_password`, `_broken`, `_too_large`, `_scanned` (fewer than 20 characters per page).

pdf.js does not give one item per `Tj`: it merges glyphs on a line into one item, putting a space in where the gap is
between 0.102 and 0.6 of the font size and starting a new item for a larger gap, a gap below -0.2, or a line shift of
more than 0.25 of the height. That decides what `toLines` sees as a cell, so the Rust side applies the same rules
(`reader.rs`, thresholds from `buildTextContentItem` in pdf.js). hayro gives one box per glyph in page view space (y
down, rotation applied), the baseline origin and the writing direction come from its glyph transform, so no rotation code
of our own is needed.

## Candidates

| Candidate | Result |
| --- | --- |
| **hayro-interpret / hayro-syntax 0.9.0** (LaurenzV/hayro; the interpreter behind the hayro renderer and, bootstrapped, behind pdfcraft) | **Chosen.** Published crates, Apache-2.0 OR MIT, updated 2026-11-02, 5 to 7 million downloads each. Parser with repair, content-stream interpreter with text state, Type1/TrueType/CFF/Type3/CID fonts, ToUnicode, encodings, standard-14 metrics and CMaps embedded. The `Device` trait hands over each glyph with its transform and Unicode. 64 crates in the tree, all permissive (MIT, Apache-2.0, BSD, Zlib, Unicode), none with a build script that needs C, no `links`. |
| lopdf 0.47 (+ own interpreter) | **Not written.** It parses well and has `get_page_content_with_limit`, but fonts, ToUnicode/CMaps, widths of the standard 14 and the interpreter would all be ours (several hundred lines plus tests). hayro already is that layer. Kept as the fallback plan if hayro proves unfit. |
| pdf_oxide 0.3.78 (MIT OR Apache-2.0) | Tried (positions of `extract_spans`). Worked for plain tables but merges spans across columns (cells matched 77.3 %, statements equal only 24 of 31, 13 of the 19 with a table), no clean page-rotation story (turned and rotated pages wrong without our own handling), 38 direct dependencies including image, office and layout crates, 5 m 50 s release build, 9 MB. Not pursued. |
| pdf-extract 0.12.1 (+ lopdf 0.42) | Read, not run: char-level `OutputDev` callback gives the text matrix per character, but no `/Rotate`, no limits, and `expect("MediaBox")` style panics in the page walker. Would need the same merge layer as hayro and more. |
| pdf 0.10 (pdf-rs) | Not tried: parser and object model; text with positions would have to be built on top like with lopdf, and its font/encoding handling for text is thin. |
| pdfcraft (storytold, MIT OR Apache-2.0, alpha, 0.21.1) | Tried as a git dependency (`eval-pdfcraft/`). `pdfcraft-render` is **not on crates.io** (only `pdfcraft-cos/-content/-model/-fonts/-filters/-crypt` 0.7.1 are, without text extraction) and it needs the project's vendored, patched copies of hayro, lopdf and vello (repeated as `[patch]` in our Cargo.toml). It gives one box per glyph in view space with direction (the em box, not the baseline; 0.2 em descent assumed here). After the same merge: cells 99.2 %, 31 of 31 statements equal, 2 to 5 ms, 9 MB RSS, 8.9 MB binary, 2.5 minutes to build, 190 packages in the lock file (65 for ours). It decodes streams with a limit (the 2 GiB bomb costs 9 MB) but its layout step is not linear (150,000 lines: no answer in 90 s) and its own README says fuzzing still finds crashes. Same engine and results as hayro with more weight; nothing from it was copied into this repo. |

No code of any other project is vendored or copied here, so there is no NOTICE entry to add; the dependencies are
listed by `cargo tree` and are permissive. (If hayro or pdfcraft parts were ever vendored, their licence headers and
a THIRD_PARTY_NOTICES.md entry with version and commit are needed.)

## Corpus (all invented)

33 files in `$WORK/corpus`: the repo helpers (`ts_statement`, `ts_statement_flate`, `ts_blocks` = block layout with
page-break records, `ts_turned3` and `ts_turned71` = landscape tables on `/Rotate 90` pages with upward text,
`ts_table_4260rows` = 71 pages by 60 rows, `ts_encrypted`, `ts_filler_bomb`), reportlab statements (Helvetica, Helvetica
Bold, Times, Courier, MacRomanEncoding Helvetica and Times, embedded TrueType subsets with ToUnicode, A4 landscape, US
Letter, `/Rotate` 90, 180, 270, uncompressed, 71 long pages, character/word spacing, horizontal scaling, `T*`),
and hand-written PDFs (Type0 / CIDFontType2 Identity-H with embedded TrueType and ToUnicode, with TJ kerning, with
`/Rotate 90`, with object streams and an xref stream; `'` and `"` operators, `cm` scaling, text matrices turned and
mirrored, `/Differences`, a Form XObject, a CropBox offset, a CID font without ToUnicode). Accents and symbols: é ü ø Æ Œ € ñ.

## Comparison pdf.js against Rust (hayro)

Per file, both through the app's `toLines`, then `readStatement`. "cells" = cells (text and x0 within 1.5 pt, y within
1.5 pt, same line index) equal. "statement" = the whole `readStatement` result equal (grid, balances, period, notes,
dropped lines).

| Layout | Files | Cells equal | Statement equal |
| --- | --- | --- | --- |
| Repo helpers: plain/flate statement, block layout, 71x60 table | 4 | 100 % | 4 of 4 |
| Landscape table on `/Rotate 90` page, text turned (3 and 71 pages) | 2 | 100 % | 2 of 2 |
| reportlab: Helvetica, Bold, Times, Letter, landscape, uncompressed, long 71 pages | 7 | 100 % | 7 of 7 |
| reportlab: MacRoman Helvetica and Times (é ü ø € via encoding) | 2 | 100 % (items 99.7 %) | 2 of 2 |
| reportlab: embedded TrueType subset with ToUnicode | 1 | 100 % | 1 of 1 |
| `/Rotate` 90, 180, 270 | 3 | 100 % | 3 of 3 |
| Char and word spacing, `Tz`, `T*` | 1 | 100 % | 1 of 1 |
| Courier (0.6 em space, pdf.js itself splits at about half the spaces by float rounding) | 1 | 92 % (310/336) | 1 of 1 |
| Type0 Identity-H + ToUnicode (plain, TJ kerning, objstm/xref stream, `/Rotate 90`) | 4 | 100 % | 4 of 4 |
| Raw operators (`'`, `"`, cm, Tz, Ts, turned and mirrored text, octal escapes, MacRoman), objstm variant | 2 | 100 % | 2 of 2 |
| Form XObject, CropBox offset | 2 | 100 % | 2 of 2 |
| Non-embedded TrueType with own `/Widths` | 1 | 50 % | 1 of 1 (no table) |
| CID font without ToUnicode | 1 | not read (pdf.js reads it) | - |
| Encrypted, 4 MB zero filler | 2 | same error code as pdf.js | - |

Totals (31 files read by both): cells 99.9 %, lines 99.9 %, whole statements equal 31 of 31 (20 of them with a table
found), page counts and sizes equal in all 31, `rl_courier` is the only file whose cell texts differ in the way pdf.js
splits words.
Item counts are not equal on purpose: pdf.js also emits items that are only a space (about 1.7 times as many items).
Item positions (an item of the other reader that contains the text, start within 1.5 pt) match 100 % for upright pages;
on rotated pages the item metric reads 83 to 87 % because pieces are cut at different places, while the cells that
`toLines` builds from them are equal.

### Differences and likely causes

1. Courier: a space is exactly 0.6 em, pdf.js's limit for "space in the flow". pdf.js lands on either side of it by
   rounding, so it splits some gaps into separate items and not others. We split always (f32 widths). Cells differ
   (words versus phrases) but the statement was the same. Any real monospaced statement is the place to look.
2. Non-embedded font with its own `/Widths`: pdf.js uses the widths in the PDF, hayro the widths of its substitute font,
   so the glyph advance is off and a word is split ("W idths"). Matters for PDFs from Windows tools with non-embedded Arial.
   Embedded fonts, the standard 14 and Type3 are fine.
3. A CID font with Identity-H and no ToUnicode: pdf.js recovers the characters from the embedded font's cmap; hayro
   reports no Unicode, so the page is "scanned". Real banks mostly ship a ToUnicode; some old generators do not.
4. Gaps near the thresholds (0.102 and 0.6 em, the 0.25 line-shift rule) were ported, not copied: a different font
   metrics rounding can flip a space in or out. None showed in the corpus except Courier.

## Speed and memory (one process per file, `ms` = read inside the process)

| File | pdf.js ms / MB | Rust ms / MB |
| --- | --- | --- |
| ts_statement (3 pages) | 29 / 113 | 1 / 6 |
| rl_helvetica (2 pages, 128 items) | 60 / 119 | 2 / 6 |
| rl_ttf_liberation (embedded TTF) | 79 / 121 | 2 / 6 |
| raw_cid_identityH (Type0 + 95 KB font) | 65 / 122 | 2 / 7 |
| ts_turned71 (71 pages, rotated) | 197 / 141 | 67 / 8 |
| rl_long_71p | 416 / 166 | 98 / 10 |
| ts_table_4260rows (71 pages, 21,797 items) | 333 / 157 | 59 / 9 |

pdf.js MB is the peak RSS of a node process (the runtime alone is about 110 MB; the app's utility process has the same
baseline). Binary: 5.4 MB stripped (4.9 MB without the embedded CJK CMaps: `hayro-interpret` `default-features =
false, features = ["embed-fonts"]`), against 3.5 MB of pdf.js bundles in `node_modules` and a pdfium library of
several MB per platform. Release build: 1 minute from scratch, 64 crates.

## Hostile and broken input (3,338 files)

338 files (38 written by hand, 300 mutated from the corpus) plus 3,000 more mutants (1 to 50 random byte changes, some
with a cut, seed fixed): `tools/gen_hostile.py`. Rust reader, address space capped at 8 GiB, 10 s deadline in the run (60 s
in the app):

* Crashes, aborts, hangs, internal panics: **0** (panics were shown with `KB_PDF_SHOW_PANICS=1`; the only one is our own
  deadline unwind). 0 of 3,000 mutants and 0 of 338.
* Truncated, empty, garbage, wrong stream length, xref loop, `/Parent` loop, page that is its own kid, Contents that is
  itself, self-referencing font, form recursion (self and mutual), Type3 glyph that shows its own font, 20,000-deep page tree,
  2,000,000 nested `q`, 1,000,000 nested `[`, 500,000 nested `<<`, 1e300 font size and matrices, 1e30 MediaBox, 100,000
  overlapping ToUnicode ranges, 150 and 151 and 5,000 pages, 150,000 items, 2,000,000-character string: all answered with
  a normal result or one of the four error codes, in under 1.5 s.
* Gaps, now closed in `main.rs` / `cap.rs` / `reader.rs`:
  * Decompression bomb: hayro decodes a stream completely and has no size limit. 2 GiB of zeros took 2.1 GB of memory;
    10 GiB died with `memory allocation failed` (an abort). Fixed by the 1 GiB allocator cap (answers `import.pdf_too_large`
    in 0.5 s). Without a cap or an rlimit this is the one real risk. (A stream that deflates to small and holds text
    within 300 MB is read, 371 MB peak: below the cap.)
  * Time: the interpreter has no clock. A form that draws two forms 30 levels deep (2^30 draws) ran until the 60 s.
    Now the device checks the clock every 256 callbacks and unwinds, and `main` also stops waiting after the deadline
    and ends the process. Work that never reaches the device (no glyph, path or clip) is only stopped by the process
    deadline; the app should keep its kill timer as today.
  * The stack: a 64 MB thread stack is used for deep structures; none overflowed.
* pdf.js on the same set (no address-space cap; node refuses to start with one): `deep_q` (2,000,000 nested `q`) ran
  past 90 s without an answer, the 2 GiB bomb took 21 s and 4.3 GB, 3 files over 5 s in all. So the app depends on its
  60 s kill today; the Rust reader is safer even without it.
* Behaviour differences with pdf.js on the hostile set: 273 of 338 give the same ok/error class, 239 the same code. Rust
  is more tolerant on mutants (23 mutants that pdf.js calls broken are read) and loses the text on 27 where pdf.js reads
  it (corrupt objects hayro does not recover). Codes differ mostly between `broken` and `scanned` (a page whose content
  stream cannot be read looks empty). The app only shows a different message.
* pdfcraft: no crash on the 338, bounded memory on bombs, but `items_150k` did not finish in 90 s (quadratic layout).
  pdf_oxide was not put through the hostile set.

## What real bank PDFs may still break

* Fonts with no ToUnicode (see 3): the text is silently missing, which `extract.ts` would report as a scan. A fallback
  could keep pdf.js for the files where Rust finds no text, or the glyph-to-Unicode step could be added (hayro exposes the
  font program).
* Non-embedded fonts with their own widths (see 2).
* Embedded Type1 and CFF subsets and CIDFontType0 were not in the corpus (no generator at hand); hayro renders them,
  so glyphs and advance are expected to be right, but Unicode comes only from ToUnicode and glyph names.
* Right-to-left text: pdf.js reorders by bidi; hayro gives glyphs in drawing order. Vertical writing: only the basics.
* Scanned statements (image only) and password-protected files stay unsupported, as today: both give the same error
  codes as pdf.js (`import.pdf_scanned`, `import.pdf_password`; an encrypted file with an empty user password is opened).
* The API of hayro changed between 0.7 and 0.9 (the `Device` trait); pin the version and budget for upgrades.
* Annotations/form field text: hayro draws page content here; text only in widget appearances is not read (pdf.js reads
  page text only too, so no change).
* The invented corpus cannot show how a given bank lays out its PDF; the `PDF_DIR` mode of `run-all.sh` is there to run the
  comparison on real files locally.

## Recommendation

Replace the pdfium plan with this reader: it is pure Rust, small, fast, and equal to pdf.js on every layout that
`tests/pdf-layouts.test.ts` and `pdf-reader.test.ts` use (cells 99.9 %, statements 31 of 31). Before it replaces pdf.js
it needs: (1) a run of `tools/run-all.sh` with `PDF_DIR` over the real statements of each supported bank (the one thing
this spike could not do), looking at the files whose statement differs; (2) the memory cap and deadline kept (they are in
this spike) plus the existing separate process and 60 s kill; (3) a decision about fonts without ToUnicode (keep pdf.js
as a fallback for "no text found" until the real files show how common it is); (4) port the TS tests that call
`extractText` to the Rust reader's JSON as a conformance suite. Verdict: **viable, needs moderate hardening and real-file
validation**, not "needs a new parser".
