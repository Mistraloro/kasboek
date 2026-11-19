//! Time-based one-time passwords (RFC 6238): HMAC-SHA1, 6 digits, 30-second steps. Port of src/core/totp.ts.
use crate::encoding::{base32_decode, base32_encode, is_js_space};
use crate::error::CryptoError;
use crate::random_bytes;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

const STEP: i64 = 30;
pub const DIGITS: u32 = 6;

pub fn new_totp_secret() -> String {
    base32_encode(&random_bytes::<20>())
}

pub fn hotp(secret: &[u8], counter: u64, digits: u32) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("HMAC takes keys of any length");
    mac.update(&counter.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let offset = (h[h.len() - 1] & 0x0f) as usize;
    let bin =
        (u32::from(h[offset] & 0x7f) << 24) | (u32::from(h[offset + 1]) << 16) | (u32::from(h[offset + 2]) << 8) | u32::from(h[offset + 3]);
    format!("{:0width$}", u64::from(bin) % 10u64.pow(digits), width = digits as usize)
}

pub fn totp_at(secret_base32: &str, unix_seconds: i64, digits: u32) -> Result<String, CryptoError> {
    let key = Zeroizing::new(base32_decode(secret_base32)?);
    Ok(hotp(&key, unix_seconds.div_euclid(STEP) as u64, digits))
}

/// Checks a code, allowing one step of clock drift either way. Returns the matching time step, or `None`.
/// A code at or before `last_step` is rejected, so a code can't be used twice. `now` is unix seconds.
pub fn verify_totp(secret_base32: &str, code: &str, last_step: i64, now: f64) -> Result<Option<i64>, CryptoError> {
    let clean: String = code.chars().filter(|c| !is_js_space(*c)).collect();
    if clean.len() != DIGITS as usize || !clean.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(None);
    }
    let key = Zeroizing::new(base32_decode(secret_base32)?);
    let current = (now / STEP as f64).floor() as i64;
    for step in [current, current - 1, current + 1] {
        if step <= last_step {
            continue;
        }
        if hotp(&key, step as u64, DIGITS).as_bytes().ct_eq(clean.as_bytes()).into() {
            return Ok(Some(step));
        }
    }
    Ok(None)
}

pub fn otpauth_uri(secret_base32: &str, account: &str) -> String {
    let label = encode_uri_component(&format!("Kasboek:{account}"));
    format!("otpauth://totp/{label}?secret={secret_base32}&issuer=Kasboek&algorithm=SHA1&digits=6&period=30")
}

/// JavaScript's `encodeURIComponent`: everything except A-Z a-z 0-9 - _ . ! ~ * ' ( ) is percent-encoded as UTF-8.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 appendix B, SHA-1, secret "12345678901234567890", 8 digits.
    const RFC_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const RFC_VECTORS: [(i64, &str); 6] = [
        (59, "94287082"),
        (1_111_111_109, "07081804"),
        (1_111_111_111, "14050471"),
        (1_234_567_890, "89005924"),
        (2_000_000_000, "69279037"),
        (20_000_000_000, "65353130"),
    ];

    #[test]
    fn rfc6238_vectors_with_eight_digits() {
        for (time, expected) in RFC_VECTORS {
            assert_eq!(totp_at(RFC_SECRET, time, 8).unwrap(), expected, "T={time}");
        }
    }

    #[test]
    fn six_digit_codes_are_the_last_six_digits() {
        for (time, expected) in RFC_VECTORS {
            assert_eq!(totp_at(RFC_SECRET, time, DIGITS).unwrap(), expected[2..], "T={time}");
        }
    }

    #[test]
    fn verify_allows_one_step_of_drift_and_rejects_reuse() {
        let code = totp_at(RFC_SECRET, 1_234_567_890, DIGITS).unwrap();
        let step = 1_234_567_890 / 30;
        assert_eq!(verify_totp(RFC_SECRET, &code, -1, 1_234_567_890.0).unwrap(), Some(step));
        assert_eq!(verify_totp(RFC_SECRET, &code, -1, 1_234_567_890.0 + 30.0).unwrap(), Some(step));
        assert_eq!(verify_totp(RFC_SECRET, &code, -1, 1_234_567_890.0 - 30.0).unwrap(), Some(step));
        assert_eq!(verify_totp(RFC_SECRET, &code, -1, 1_234_567_890.0 + 60.0).unwrap(), None);
        assert_eq!(verify_totp(RFC_SECRET, &code, step, 1_234_567_890.0).unwrap(), None);
        assert_eq!(verify_totp(RFC_SECRET, &format!("{} {}", &code[..3], &code[3..]), -1, 1_234_567_890.0).unwrap(), Some(step));
        assert_eq!(verify_totp(RFC_SECRET, "12345", -1, 0.0).unwrap(), None);
        assert_eq!(verify_totp(RFC_SECRET, "abcdef", -1, 0.0).unwrap(), None);
    }

    #[test]
    fn otpauth_uri_matches_the_app() {
        assert_eq!(
            otpauth_uri("ABC", "Kasboek"),
            "otpauth://totp/Kasboek%3AKasboek?secret=ABC&issuer=Kasboek&algorithm=SHA1&digits=6&period=30"
        );
    }
}
