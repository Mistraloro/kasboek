//! base32 (RFC 4648, no padding), lenient base64 and hex helpers, matching what the TypeScript core accepts.
use crate::error::CryptoError;
use base64::alphabet::STANDARD as STANDARD_ALPHABET;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Like Node's `Buffer.from(text, 'base64')`: padding is optional, the URL-safe alphabet is accepted, whitespace is
/// ignored. Other invalid characters give `None` (Node would skip them; no valid file contains them).
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &STANDARD_ALPHABET,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
    );
    let clean: String = text
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    LENIENT.decode(clean.trim_end_matches('=')).ok()
}

pub fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let (mut bits, mut value) = (0u32, 0u32);
    for &byte in bytes {
        value = (value << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            out.push(char::from(B32[((value >> (bits - 5)) & 31) as usize]));
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(char::from(B32[((value << (5 - bits)) & 31) as usize]));
    }
    out
}

/// Case-insensitive; whitespace, `=` and `-` are ignored (so grouped keys and padded input work).
pub fn base32_decode(text: &str) -> Result<Vec<u8>, CryptoError> {
    let (mut bits, mut value) = (0u32, 0u32);
    let mut out = Vec::new();
    for ch in text.to_uppercase().chars().filter(|c| !is_js_space(*c) && *c != '=' && *c != '-') {
        let index = B32.iter().position(|&b| char::from(b) == ch).ok_or(CryptoError::Base32)?;
        value = (value << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
            value &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// The characters of JavaScript's `\s`.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub use hex::{decode as hex_decode, encode as hex_encode};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_rfc4648_vectors() {
        for (plain, coded) in
            [("", ""), ("f", "MY"), ("fo", "MZXQ"), ("foo", "MZXW6"), ("foob", "MZXW6YQ"), ("fooba", "MZXW6YTB"), ("foobar", "MZXW6YTBOI")]
        {
            assert_eq!(base32_encode(plain.as_bytes()), coded);
            assert_eq!(base32_decode(coded).unwrap(), plain.as_bytes());
        }
    }

    #[test]
    fn base32_decode_is_lenient_like_the_app() {
        assert_eq!(base32_decode("mzxw 6ytb-oi==").unwrap(), b"foobar");
        assert_eq!(base32_decode("MZXW1"), Err(CryptoError::Base32));
    }

    #[test]
    fn base64_accepts_missing_padding_and_url_alphabet() {
        assert_eq!(base64_decode("+/8=").unwrap(), [0xfb, 0xff]);
        assert_eq!(base64_decode("-_8").unwrap(), [0xfb, 0xff]);
        assert!(base64_decode("a*b").is_none());
    }
}
