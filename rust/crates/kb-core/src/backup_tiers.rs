//! Which automatic backups to keep, and the names they get (src/core/backup-tiers.ts, `stamp` of
//! src/main/transfer/service.ts): everything from the last 24 hours, the newest one per day for the last 30 days, and the
//! newest one per month for the last 12 months. Each backup is a complete, independent export, so deleting any of them
//! never affects the others.
//!
//! File names carry the LOCAL time of the computer (`new Date()` getters in the app). [`Clock`](crate::Clock) only has one
//! fixed offset, so names go through a [`LocalZone`], which knows the offset at every instant (daylight saving time).
use crate::clock::civil_from_days;

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

/// The person's time zone: the offset from UTC at an instant. The app supplies the operating system's; tests a fixed or a
/// scripted one.
pub trait LocalZone: Send + Sync {
    /// Minutes the local clock is ahead of UTC at `utc_ms`.
    fn offset_minutes_at(&self, utc_ms: i64) -> i32;
}

/// A zone with one offset all year.
pub struct FixedZone(pub i32);

impl LocalZone for FixedZone {
    fn offset_minutes_at(&self, _utc_ms: i64) -> i32 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupEntry {
    pub name: String,
    /// Milliseconds since the epoch.
    pub time: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Recent,
    Daily,
    Monthly,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recent => "recent",
            Self::Daily => "daily",
            Self::Monthly => "monthly",
        }
    }
}

pub struct Retention {
    /// The kept entries with their tier, newest first.
    pub keep: Vec<(String, Tier)>,
    /// What to delete, newest first.
    pub remove: Vec<String>,
}

impl Retention {
    pub fn tier_of(&self, name: &str) -> Option<Tier> {
        self.keep.iter().find(|(n, _)| n == name).map(|(_, t)| *t)
    }
}

/// `YYYY-MM-DD` and `YYYY-MM` of an instant in UTC (`toISOString().slice`).
fn utc_keys(t: i64) -> (String, String) {
    let (y, m, d) = civil_from_days(t.div_euclid(DAY));
    (format!("{y:04}-{m:02}-{d:02}"), format!("{y:04}-{m:02}"))
}

/// `planRetention`. The sort is stable, so entries with one time keep their order.
pub fn plan_retention(entries: &[BackupEntry], now: i64) -> Retention {
    let mut sorted: Vec<&BackupEntry> = entries.iter().collect();
    sorted.sort_by_key(|e| std::cmp::Reverse(e.time));
    let mut keep: Vec<(String, Tier)> = Vec::new();
    let mut remove = Vec::new();
    let mut days = std::collections::HashSet::new();
    let mut months = std::collections::HashSet::new();
    for e in sorted {
        let age = now - e.time;
        let (day, month) = utc_keys(e.time);
        let tier = if age < DAY {
            Some(Tier::Recent)
        } else if age < 30 * DAY {
            days.insert(day).then_some(Tier::Daily)
        } else if age < 365 * DAY {
            months.insert(month).then_some(Tier::Monthly)
        } else {
            None
        };
        match tier {
            Some(t) => keep.push((e.name.clone(), t)),
            None => remove.push(e.name.clone()),
        }
    }
    Retention { keep, remove }
}

/// Days since 1970-01-01 of a civil date, proleptic Gregorian (Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Wall-clock fields as JavaScript's `new Date(y, mo, d, h, mi, s)` reads them: months and days that overflow roll into the
/// next period, and a year of 0 to 99 means 1900 to 1999. Returns the wall time as milliseconds as if it were UTC.
fn wall_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> i64 {
    let y = if (0..100).contains(&y) { 1900 + y } else { y };
    let months = y * 12 + (mo - 1);
    let (y, m0) = (months.div_euclid(12), months.rem_euclid(12));
    let days = days_from_civil(y, m0 + 1, 1) + (d - 1);
    ((days * 24 + h) * 60 + mi) * 60_000 + s * 1000
}

/// The instant at which a local wall time (milliseconds as if it were UTC) shows on the clock: the first one when a clock
/// shows that time twice (the end of daylight saving time), and the offset from before the change for a time the clock
/// skips (its start), the same choices `new Date(...)` makes.
pub fn local_to_utc(wall: i64, zone: &dyn LocalZone) -> i64 {
    let before = i64::from(zone.offset_minutes_at(wall - DAY)) * 60_000;
    let after = i64::from(zone.offset_minutes_at(wall + DAY)) * 60_000;
    let fits = |offset: i64| i64::from(zone.offset_minutes_at(wall - offset)) * 60_000 == offset;
    match (fits(before), fits(after)) {
        (true, true) => (wall - before).min(wall - after),
        (true, false) => wall - before,
        (false, true) => wall - after,
        (false, false) => wall - before,
    }
}

/// `timeFromName`: the time in a name like `kasboek-backup-2026-11-13_092130.kasboek` (local time), or `None`.
pub fn time_from_name(name: &str, zone: &dyn LocalZone) -> Option<i64> {
    let b = name.as_bytes();
    let digits = |at: usize, n: usize| b.get(at..at + n).filter(|p| p.iter().all(u8::is_ascii_digit));
    let num = |at: usize, n: usize| digits(at, n).map(|p| p.iter().fold(0_i64, |v, c| v * 10 + i64::from(c - b'0')));
    // The first place where the pattern `dddd-dd-dd_dddddd` fits, as `String.prototype.match` finds it.
    let at = (0..b.len()).find(|&i| {
        digits(i, 4).is_some()
            && b.get(i + 4) == Some(&b'-')
            && digits(i + 5, 2).is_some()
            && b.get(i + 7) == Some(&b'-')
            && digits(i + 8, 2).is_some()
            && b.get(i + 10) == Some(&b'_')
            && digits(i + 11, 6).is_some()
    })?;
    let wall = wall_ms(num(at, 4)?, num(at + 5, 2)?, num(at + 8, 2)?, num(at + 11, 2)?, num(at + 13, 2)?, num(at + 15, 2)?);
    Some(local_to_utc(wall, zone))
}

/// `stamp`: `YYYY-MM-DD_HHMMSS` of an instant on the local clock.
pub fn stamp(utc_ms: i64, zone: &dyn LocalZone) -> String {
    let local = utc_ms + i64::from(zone.offset_minutes_at(utc_ms)) * 60_000;
    let (y, m, d) = civil_from_days(local.div_euclid(DAY));
    let rem = local.rem_euclid(DAY);
    format!("{y}-{m:02}-{d:02}_{:02}{:02}{:02}", rem / HOUR, rem / 60_000 % 60, rem / 1000 % 60)
}

/// `^kasboek-backup-[0-9_-]+\.kasboek$`: the names of the automatic backups, and nothing else is touched.
pub fn is_auto_backup_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("kasboek-backup-") else { return false };
    let Some(middle) = rest.strip_suffix(".kasboek") else { return false };
    !middle.is_empty() && middle.bytes().all(|c| c.is_ascii_digit() || c == b'_' || c == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: i64 = DAY;
    const H: i64 = HOUR;
    /// 2026-11-13T12:00:00Z
    const NOW: i64 = 1_794_571_200_000;

    fn e(name: &str, ago: i64) -> BackupEntry {
        BackupEntry { name: name.into(), time: NOW - ago }
    }

    #[test]
    fn keeps_a_day_then_one_per_day_then_one_per_month() {
        let entries = [
            e("r1", H),
            e("r2", 5 * H),
            e("r3", 23 * H),
            e("d1-new", 2 * D),
            e("d1-old", 2 * D + 2 * H),
            e("d2", 10 * D),
            e("m-a", 40 * D),
            e("m-a-older", 41 * D),
            e("m-b", 200 * D),
            e("ancient", 400 * D),
        ];
        let plan = plan_retention(&entries, NOW);
        let recent: Vec<&str> = plan.keep.iter().filter(|(_, t)| *t == Tier::Recent).map(|(n, _)| n.as_str()).collect();
        assert_eq!(recent, ["r1", "r2", "r3"]);
        assert_eq!(plan.tier_of("d1-new"), Some(Tier::Daily));
        assert_eq!(plan.tier_of("d1-old"), None);
        assert_eq!(plan.tier_of("d2"), Some(Tier::Daily));
        assert_eq!(plan.tier_of("m-a"), Some(Tier::Monthly));
        assert_eq!(plan.tier_of("m-b"), Some(Tier::Monthly));
        let mut remove = plan.remove.clone();
        remove.sort();
        assert_eq!(remove, ["ancient", "d1-old", "m-a-older"]);
    }

    #[test]
    fn the_boundaries_of_the_tiers() {
        let plan =
            plan_retention(&[e("a", DAY - 1), e("b", DAY), e("c", 30 * D - 1), e("d", 30 * D), e("e", 365 * D - 1), e("f", 365 * D)], NOW);
        assert_eq!(plan.tier_of("a"), Some(Tier::Recent));
        assert_eq!(plan.tier_of("b"), Some(Tier::Daily));
        assert_eq!(plan.tier_of("c"), Some(Tier::Daily));
        assert_eq!(plan.tier_of("d"), Some(Tier::Monthly));
        assert_eq!(plan.tier_of("e"), Some(Tier::Monthly));
        assert_eq!(plan.tier_of("f"), None);
    }

    #[test]
    fn names_are_read_as_local_time() {
        let utc = FixedZone(0);
        assert_eq!(time_from_name("kasboek-backup-2026-11-13_092130.kasboek", &utc), Some(1_794_561_690_000));
        // Amsterdam in November is one hour ahead: the same name is an hour earlier in UTC.
        assert_eq!(time_from_name("kasboek-backup-2026-11-13_092130.kasboek", &FixedZone(60)), Some(1_794_561_690_000 - H));
        assert_eq!(time_from_name("other.kasboek", &utc), None);
        assert_eq!(time_from_name("kasboek-backup-2026-11-13_0921.kasboek", &utc), None);
        // The pattern is searched anywhere in the name, the first fit wins.
        assert_eq!(time_from_name("x1999-01-01_000000-2026-11-13_092130", &utc), Some(915_148_800_000));
        // `new Date` rolls an impossible date over, and reads a year below 100 as 19xx.
        assert_eq!(time_from_name("2026-02-30_000000", &utc), time_from_name("2026-03-02_000000", &utc));
        assert_eq!(time_from_name("2026-13-01_250000", &utc), time_from_name("2027-01-02_010000", &utc));
        assert_eq!(time_from_name("0026-01-01_000000", &utc), time_from_name("1926-01-01_000000", &utc));
    }

    /// Europe/Amsterdam in 2026: daylight saving time from 2026-03-29T01:00Z to 2026-10-25T01:00Z.
    struct Amsterdam;

    impl LocalZone for Amsterdam {
        fn offset_minutes_at(&self, utc_ms: i64) -> i32 {
            const START: i64 = 1_774_746_000_000;
            const END: i64 = 1_792_890_000_000;
            if (START..END).contains(&utc_ms) {
                120
            } else {
                60
            }
        }
    }

    #[test]
    fn names_around_the_daylight_saving_changes() {
        let z = Amsterdam;
        // Winter and summer.
        assert_eq!(stamp(1_794_561_690_000, &z), "2026-11-13_102130");
        assert_eq!(stamp(1_784_000_000_000, &z), "2026-07-14_053320");
        // Spring forward: 02:00 to 03:00 on 2026-03-29. 00:59:59Z is 01:59:59, 01:00:00Z is 03:00:00.
        assert_eq!(stamp(1_774_746_000_000 - 1000, &z), "2026-03-29_015959");
        assert_eq!(stamp(1_774_746_000_000, &z), "2026-03-29_030000");
        // A name in the skipped hour reads with the offset from before the change (02:30 is 01:30Z, the same instant as 03:30).
        assert_eq!(time_from_name("2026-03-29_023000", &z), Some(1_774_746_000_000 + 30 * 60_000));
        assert_eq!(stamp(time_from_name("2026-03-29_023000", &z).unwrap(), &z), "2026-03-29_033000");
        // Fall back: 03:00 to 02:00 on 2026-10-25. The hour 02:00 to 03:00 shows twice; the name means the first time.
        assert_eq!(stamp(1_792_890_000_000 - 1000, &z), "2026-10-25_025959");
        assert_eq!(stamp(1_792_890_000_000, &z), "2026-10-25_020000");
        assert_eq!(time_from_name("2026-10-25_023000", &z), Some(1_792_890_000_000 - 30 * 60_000));
        assert_eq!(time_from_name("2026-10-25_013000", &z), Some(1_792_890_000_000 - 90 * 60_000));
        assert_eq!(time_from_name("2026-10-25_033000", &z), Some(1_792_890_000_000 + 90 * 60_000));
        // A name made now reads back to the same second, except in the repeated hour (second occurrence reads as the first).
        for t in [1_784_000_000_000, 1_794_561_690_000, 1_774_746_000_000 - 1000, 1_774_746_000_000, 1_792_890_000_000 - 1000] {
            assert_eq!(time_from_name(&stamp(t, &z), &z), Some(t));
        }
        assert_eq!(time_from_name(&stamp(1_792_890_000_000 + 1000, &z), &z), Some(1_792_890_000_000 + 1000 - HOUR));
    }

    #[test]
    fn only_the_names_kasboek_gave_are_backups() {
        assert!(is_auto_backup_name("kasboek-backup-2026-11-13_092130.kasboek"));
        assert!(!is_auto_backup_name("kasboek-backup-.kasboek"));
        assert!(!is_auto_backup_name("kasboek-export-2026-11-13_092130.kasboek"));
        assert!(!is_auto_backup_name("kasboek-backup-../x.kasboek"));
        assert!(!is_auto_backup_name("kasboek-backup-1.kasboek\n"));
        assert!(!is_auto_backup_name("kasboek-backup-1.kasboek.partial"));
    }
}
