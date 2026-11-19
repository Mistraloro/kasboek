//! The two sources of non-determinism, injected so scenarios can fix them: time and randomness.

pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> i64;
    /// Minutes the person's clock is ahead of UTC (`localToday` in src/shared/month.ts uses the local calendar day).
    fn utc_offset_minutes(&self) -> i32 {
        0
    }

    /// Today as `YYYY-MM-DD` on the person's own clock.
    fn local_today(&self) -> String {
        let days = (self.now_ms() + i64::from(self.utc_offset_minutes()) * 60_000).div_euclid(86_400_000);
        let (y, m, d) = civil_from_days(days);
        format!("{y:04}-{m:02}-{d:02}")
    }
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian (Howard Hinnant's algorithm).
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

/// The real clock, on UTC (the app supplies the local offset).
pub struct SystemClock {
    pub utc_offset_minutes: i32,
}

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
    }

    fn utc_offset_minutes(&self) -> i32 {
        self.utc_offset_minutes
    }
}

/// A clock that stands still (scenarios, tests).
pub struct FixedClock {
    pub ms: i64,
    pub utc_offset_minutes: i32,
}

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.ms
    }

    fn utc_offset_minutes(&self) -> i32 {
        self.utc_offset_minutes
    }
}

/// Randomness for operations that need ids of their own (none of the ported ones do yet; row uids are made by the
/// database triggers). Seeded in scenarios.
pub trait Rng: Send + Sync {
    fn next_u64(&self) -> u64;
}

/// SplitMix64: small, seedable, good enough for ids in tests. Not for secrets (keys come from the OS, in kb-crypto).
pub struct SeededRng(std::sync::atomic::AtomicU64);

impl SeededRng {
    pub fn new(seed: u64) -> Self {
        Self(std::sync::atomic::AtomicU64::new(seed))
    }
}

impl Rng for SeededRng {
    fn next_u64(&self) -> u64 {
        use std::sync::atomic::Ordering::Relaxed;
        let state = self.0.fetch_add(0x9E37_79B9_7F4A_7C15, Relaxed).wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_today_uses_the_offset() {
        // 2026-11-14T23:30:00Z
        let at = 1_794_699_000_000;
        assert_eq!(FixedClock { ms: at, utc_offset_minutes: 0 }.local_today(), "2026-11-14");
        assert_eq!(FixedClock { ms: at, utc_offset_minutes: 60 }.local_today(), "2026-11-15");
        assert_eq!(FixedClock { ms: 0, utc_offset_minutes: 0 }.local_today(), "1970-01-01");
        assert_eq!(FixedClock { ms: 951_782_400_000, utc_offset_minutes: 0 }.local_today(), "2000-02-29");
    }

    #[test]
    fn seeded_rng_repeats() {
        let (a, b) = (SeededRng::new(7), SeededRng::new(7));
        assert_eq!((a.next_u64(), a.next_u64()), (b.next_u64(), b.next_u64()));
    }
}
