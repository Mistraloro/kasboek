use crate::error::{DbError, DbResult};
use zeroize::Zeroizing;

/// The database key: 32 bytes as 64 lower-case hex characters (`KEY_HEX` in database.ts). Wiped on drop.
pub struct DbKey(Zeroizing<String>);

impl DbKey {
    pub fn from_hex(hex: &str) -> DbResult<Self> {
        if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            Ok(Self(Zeroizing::new(hex.to_owned())))
        } else {
            Err(DbError::BadKey)
        }
    }

    pub fn from_bytes(bytes: &[u8; 32]) -> Self {
        Self(Zeroizing::new(hex::encode(bytes)))
    }

    pub(crate) fn as_hex(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for DbKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DbKey(..)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_lower_case_hex_of_64_characters_is_a_key() {
        assert!(DbKey::from_hex(&"a1".repeat(32)).is_ok());
        for bad in ["", "abc", &"A1".repeat(32), &"g1".repeat(32), &"a1".repeat(33)] {
            assert!(matches!(DbKey::from_hex(bad), Err(DbError::BadKey)), "{bad}");
        }
        assert_eq!(DbKey::from_bytes(&[0xff; 32]).as_hex(), "ff".repeat(32));
    }
}
