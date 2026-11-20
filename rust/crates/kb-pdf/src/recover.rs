//! Text for glyphs of fonts that have no `ToUnicode` map (the main gap found in spike C).
//!
//! hayro only knows Unicode from `ToUnicode` and, for simple fonts, from glyph names; a Type0 font with `Identity-H`
//! and no `ToUnicode` gives nothing, which would be reported as a scan. pdf.js reads such files from the embedded font
//! program, and so does this: the glyph id the interpreter resolved (also through `CIDToGIDMap`) is looked up in the
//! font's own `cmap` (reversed, lowest code point wins so that a space is not a no-break space), then by its name in the
//! `post` table or the CFF charset (`uniXXXX`, `uXXXX`, and the Adobe names of Latin text).
//!
//! What stays unreadable, as in pdf.js: a subset without a usable `cmap` and without glyph names (the text is only glyph
//! numbers), bare CFF programs (`FontFile3` `Type1C`/`CIDFontType0C`, not a font file the parser accepts), and Type3 fonts.
use hayro_interpret::font::OutlineGlyph;
use skrifa::{charmap::Charmap, FontRef, GlyphNames};
use std::collections::HashMap;

/// Reverse maps by font, built on first use (one per font program, not per glyph).
#[derive(Default)]
pub struct Recover {
    fonts: HashMap<u128, Option<HashMap<u32, String>>>,
}

impl Recover {
    /// The text of a glyph the interpreter could not turn into Unicode, or `None`.
    pub fn text(&mut self, glyph: &OutlineGlyph) -> Option<String> {
        let data = glyph.font_data()?;
        let map = self.fonts.entry(data.cache_key).or_insert_with(|| reverse_map(AsRef::<[u8]>::as_ref(&*data.data)));
        map.as_ref()?.get(&glyph.glyph_id().to_u32()).cloned()
    }
}

fn reverse_map(bytes: &[u8]) -> Option<HashMap<u32, String>> {
    let font = FontRef::from_index(bytes, 0).ok()?;
    let mut by_glyph: HashMap<u32, u32> = HashMap::new();
    for (cp, gid) in Charmap::new(&font).mappings() {
        // A symbolic font keeps its characters at 0xF000 + code.
        let cp = if (0xF020..=0xF0FF).contains(&cp) { cp - 0xF000 } else { cp };
        if cp < 0x20 || (0x7F..0xA0).contains(&cp) || (0xE000..=0xF8FF).contains(&cp) {
            continue;
        }
        let at = by_glyph.entry(u32::from(gid)).or_insert(cp);
        *at = (*at).min(cp);
    }
    let mut out: HashMap<u32, String> = by_glyph.into_iter().filter_map(|(g, cp)| Some((g, char::from_u32(cp)?.to_string()))).collect();
    for (gid, name) in GlyphNames::new(&font).iter() {
        if name.is_synthesized() {
            continue;
        }
        let gid = u32::from(gid);
        if let std::collections::hash_map::Entry::Vacant(slot) = out.entry(gid) {
            if let Some(t) = text_of_name(name.as_str()) {
                slot.insert(t);
            }
        }
    }
    (!out.is_empty()).then_some(out)
}

/// `uni0041`, `u0041` and the Adobe glyph names of Latin text and punctuation.
fn text_of_name(name: &str) -> Option<String> {
    let base = name.split('.').next().unwrap_or(name);
    let hex = |h: &str| u32::from_str_radix(h, 16).ok().and_then(char::from_u32);
    if let Some(h) = base.strip_prefix("uni").filter(|h| h.len() >= 4 && h.len() % 4 == 0 && h.chars().all(|c| c.is_ascii_hexdigit())) {
        return h.as_bytes().chunks(4).map(|c| hex(std::str::from_utf8(c).ok()?)).collect::<Option<String>>();
    }
    if let Some(h) = base.strip_prefix('u').filter(|h| (4..=6).contains(&h.len()) && h.chars().all(|c| c.is_ascii_hexdigit())) {
        return hex(h).map(String::from);
    }
    let mut chars = base.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return c.is_ascii_alphabetic().then(|| c.to_string());
    }
    let c = match base {
        "space" | "nbspace" | "nonbreakingspace" => ' ',
        "zero" => '0',
        "one" => '1',
        "two" => '2',
        "three" => '3',
        "four" => '4',
        "five" => '5',
        "six" => '6',
        "seven" => '7',
        "eight" => '8',
        "nine" => '9',
        "period" => '.',
        "comma" => ',',
        "colon" => ':',
        "semicolon" => ';',
        "hyphen" | "sfthyphen" => '-',
        "minus" => '\u{2212}',
        "endash" => '\u{2013}',
        "emdash" => '\u{2014}',
        "plus" => '+',
        "equal" => '=',
        "slash" => '/',
        "backslash" => '\\',
        "parenleft" => '(',
        "parenright" => ')',
        "bracketleft" => '[',
        "bracketright" => ']',
        "braceleft" => '{',
        "braceright" => '}',
        "percent" => '%',
        "ampersand" => '&',
        "asterisk" => '*',
        "at" => '@',
        "dollar" => '$',
        "numbersign" => '#',
        "underscore" => '_',
        "quotesingle" => '\'',
        "quotedbl" => '"',
        "quoteright" => '\u{2019}',
        "quoteleft" => '\u{2018}',
        "exclam" => '!',
        "question" => '?',
        "less" => '<',
        "greater" => '>',
        "bar" => '|',
        "asciitilde" => '~',
        "asciicircum" => '^',
        "grave" => '`',
        "Euro" | "euro" => '\u{20AC}',
        "sterling" => '\u{A3}',
        "yen" => '\u{A5}',
        "cent" => '\u{A2}',
        "section" => '\u{A7}',
        "degree" => '\u{B0}',
        "bullet" => '\u{2022}',
        "periodcentered" => '\u{B7}',
        "ellipsis" => '\u{2026}',
        "Agrave" => 'À',
        "Aacute" => 'Á',
        "Acircumflex" => 'Â',
        "Atilde" => 'Ã',
        "Adieresis" => 'Ä',
        "Aring" => 'Å',
        "AE" => 'Æ',
        "Ccedilla" => 'Ç',
        "Egrave" => 'È',
        "Eacute" => 'É',
        "Ecircumflex" => 'Ê',
        "Edieresis" => 'Ë',
        "Igrave" => 'Ì',
        "Iacute" => 'Í',
        "Icircumflex" => 'Î',
        "Idieresis" => 'Ï',
        "Ntilde" => 'Ñ',
        "Ograve" => 'Ò',
        "Oacute" => 'Ó',
        "Ocircumflex" => 'Ô',
        "Otilde" => 'Õ',
        "Odieresis" => 'Ö',
        "Oslash" => 'Ø',
        "OE" => 'Œ',
        "Ugrave" => 'Ù',
        "Uacute" => 'Ú',
        "Ucircumflex" => 'Û',
        "Udieresis" => 'Ü',
        "germandbls" => 'ß',
        "agrave" => 'à',
        "aacute" => 'á',
        "acircumflex" => 'â',
        "atilde" => 'ã',
        "adieresis" => 'ä',
        "aring" => 'å',
        "ae" => 'æ',
        "ccedilla" => 'ç',
        "egrave" => 'è',
        "eacute" => 'é',
        "ecircumflex" => 'ê',
        "edieresis" => 'ë',
        "igrave" => 'ì',
        "iacute" => 'í',
        "icircumflex" => 'î',
        "idieresis" => 'ï',
        "ntilde" => 'ñ',
        "ograve" => 'ò',
        "oacute" => 'ó',
        "ocircumflex" => 'ô',
        "otilde" => 'õ',
        "odieresis" => 'ö',
        "oslash" => 'ø',
        "oe" => 'œ',
        "ugrave" => 'ù',
        "uacute" => 'ú',
        "ucircumflex" => 'û',
        "udieresis" => 'ü',
        "ydieresis" => 'ÿ',
        _ => return None,
    };
    Some(c.to_string())
}
