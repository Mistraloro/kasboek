//! Injected time and randomness, and the date format of `Date.prototype.toISOString`.
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use zeroize::Zeroizing;

pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
    }
}

impl<T: Clock + ?Sized> Clock for std::sync::Arc<T> {
    fn now_ms(&self) -> i64 {
        (**self).now_ms()
    }
}

/// A clock the test moves by hand.
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn new(ms: i64) -> Self {
        Self(AtomicI64::new(ms))
    }

    pub fn now_ms_value(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }

    pub fn set(&self, ms: i64) {
        self.0.store(ms, Ordering::SeqCst);
    }

    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// Source of secret randomness (master key, database key, recovery key, TOTP secret).
pub trait Rng: Send + Sync {
    fn fill(&self, buf: &mut [u8]);
}

/// The operating system's randomness.
pub struct OsRng;

impl Rng for OsRng {
    fn fill(&self, buf: &mut [u8]) {
        for chunk in buf.chunks_mut(32) {
            let bytes = kb_crypto::random_bytes::<32>();
            chunk.copy_from_slice(&bytes[..chunk.len()]);
        }
    }
}

/// SplitMix64 for tests. Never for real secrets.
pub struct SeededRng(Mutex<u64>);

impl SeededRng {
    pub fn new(seed: u64) -> Self {
        Self(Mutex::new(seed))
    }
}

impl Rng for SeededRng {
    fn fill(&self, buf: &mut [u8]) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for chunk in buf.chunks_mut(8) {
            *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = *state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            chunk.copy_from_slice(&z.to_le_bytes()[..chunk.len()]);
        }
    }
}

pub fn random_array<const N: usize>(rng: &dyn Rng) -> Zeroizing<[u8; N]> {
    let mut out = Zeroizing::new([0u8; N]);
    rng.fill(&mut *out);
    out
}

/// `new Date(ms).toISOString()`: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// `Date.parse` for the one format the app writes. Anything else is `None` (JavaScript's NaN).
pub fn parse_iso(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() != 24 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'.' || b[23] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = &text[from..to];
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok()).flatten()
    };
    let (y, mo, d, h, mi, s, ms) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?, num(20, 23)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    // Reject days that do not exist (JavaScript does too for this format).
    if civil_from_days(days) != (y, mo, d) {
        return None;
    }
    Some(days * 86_400_000 + h * 3_600_000 + mi * 60_000 + s * 1000 + ms)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_794_699_000_123), "2026-11-14T23:30:00.123Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn parse_roundtrips_and_refuses_other_formats() {
        for ms in [0, 1_794_699_000_123, 951_782_400_000, 4_102_444_799_999] {
            assert_eq!(parse_iso(&iso(ms)), Some(ms));
        }
        assert_eq!(parse_iso("2026-02-30T00:00:00.000Z"), None);
        assert_eq!(parse_iso("2026-11-14"), None);
        assert_eq!(parse_iso("garbage"), None);
    }
}
