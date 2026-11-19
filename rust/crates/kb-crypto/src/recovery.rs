//! Recovery keys: 160 random bits as 8 groups of 4 base32 characters, e.g. `K7QJ-2M4X-...` (src/core/totp.ts).
use crate::encoding::base32_encode;
use crate::random_bytes;

pub fn new_recovery_key() -> String {
    group_recovery_key(&base32_encode(&random_bytes::<20>()))
}

fn group_recovery_key(chars: &str) -> String {
    chars.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).expect("ASCII")).collect::<Vec<_>>().join("-")
}

/// Upper-case, drop everything outside A-Z and 2-7, regroup in fours with dashes.
pub fn normalize_recovery_key(input: &str) -> String {
    let kept: String = input.to_uppercase().chars().filter(|c| matches!(c, 'A'..='Z' | '2'..='7')).collect();
    group_recovery_key(&kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_keys_have_eight_groups_and_are_stable_under_normalising() {
        let key = new_recovery_key();
        assert_eq!(key.split('-').count(), 8);
        assert!(key.split('-').all(|g| g.len() == 4));
        assert_eq!(normalize_recovery_key(&key.to_lowercase().replace('-', " ")), key);
    }

    #[test]
    fn normalising_matches_the_app() {
        assert_eq!(normalize_recovery_key("abcd efgh ij"), "ABCD-EFGH-IJ");
        assert_eq!(normalize_recovery_key("a1b0c8d9-ef"), "ABCD-EF");
        assert_eq!(normalize_recovery_key(""), "");
    }
}
