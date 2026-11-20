//! The rules of the first-run screen that are not layout (`src/shared/setup-rules.ts`): when the recovery key counts as
//! stored, and what the two-factor step shows.

/// The last group of a recovery key, which the person types back to show they saved it.
pub fn recovery_key_tail(recovery_key: &str) -> &str {
    recovery_key.split('-').next_back().unwrap_or("")
}

/// Continue on the recovery key screen: only when "saved" is ticked and the last group matches (typed in any case, as the
/// renderer upper-cases the field).
pub fn recovery_key_confirmed(tail: &str, saved: bool, typed: &str) -> bool {
    saved && !tail.is_empty() && typed.to_uppercase() == tail
}

/// How asking the core for a new 2FA secret went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TotpBegin {
    Ready,
    Failed,
}

impl TotpBegin {
    /// The value of the `state` property of the two-factor panel: a failure shows the error and still allows "Not now", so the
    /// step is never a dead end.
    pub fn word(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tail_is_the_last_group() {
        assert_eq!(recovery_key_tail("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789"), "6789");
        assert_eq!(recovery_key_tail(""), "");
    }

    #[test]
    fn continue_needs_saved_and_the_matching_tail() {
        assert!(recovery_key_confirmed("6789", true, "6789"));
        assert!(recovery_key_confirmed("AB2K", true, "ab2k"));
        assert!(!recovery_key_confirmed("6789", false, "6789"));
        assert!(!recovery_key_confirmed("6789", true, "6788"));
        assert!(!recovery_key_confirmed("6789", true, ""));
        // No key (the call failed): nothing to confirm, never a free pass.
        assert!(!recovery_key_confirmed("", true, ""));
    }
}
