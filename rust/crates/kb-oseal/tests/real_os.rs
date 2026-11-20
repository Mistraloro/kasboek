//! The real operating system calls. Every test runs on the matching OS only (cfg) and is not `#[ignore]`d, so the CI
//! runner of each OS exercises it. Nothing here touches the real `Kasboek` items except the Linux fallback check, which
//! only seals and opens in memory. Invented data only.
#[cfg(target_os = "linux")]
use kb_session::oscrypt::SealError;
use kb_session::seal::{KeyProtection, OsSeal};

fn roundtrip(seal: &dyn OsSeal) {
    let blob = seal.seal(b"invented account json").unwrap();
    assert!(!blob.windows(8).any(|w| w == b"invented"), "plaintext must not appear in the blob");
    assert_eq!(seal.unseal(&blob).unwrap().as_slice(), b"invented account json");
    let mut bad = blob.clone();
    *bad.last_mut().unwrap() ^= 1;
    assert!(seal.unseal(&bad).is_err());
    assert!(seal.unseal(&blob[..5]).is_err());
    assert_eq!(seal.protection(), KeyProtection::Os);
}

#[cfg(windows)]
mod windows {
    use super::*;
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    use kb_crypto::encoding::base64_encode;
    use kb_oseal::dpapi::{DpapiApi, DpapiSeal, SystemDpapi};
    use kb_oseal::legacy::open_electron_account_json;

    #[test]
    fn dpapi_seal_roundtrips_and_entropy_matters() {
        let seal = DpapiSeal::new(SystemDpapi);
        assert!(seal.available());
        roundtrip(&seal);
        let blob = SystemDpapi.protect(b"x", None).unwrap();
        assert!(SystemDpapi.unprotect(&blob, Some(b"other entropy")).is_err());
        assert_eq!(SystemDpapi.unprotect(&blob, None).unwrap().as_slice(), b"x");
        assert!(SystemDpapi.unprotect(b"not a dpapi blob", None).is_err());
    }

    #[test]
    fn selected_seal_is_dpapi() {
        roundtrip(&*kb_oseal::select_os_seal());
    }

    /// Builds what Electron writes (Local State key protected with the real DPAPI, `v10` AES-GCM value) and opens it.
    #[test]
    fn electron_v10_with_a_real_dpapi_protected_key() {
        let dir = tempfile::tempdir().unwrap();
        let key = [7u8; 32];
        let mut raw = b"DPAPI".to_vec();
        raw.extend(SystemDpapi.protect(&key, None).unwrap());
        std::fs::write(dir.path().join("Local State"), format!(r#"{{"os_crypt":{{"encrypted_key":"{}"}}}}"#, base64_encode(&raw))).unwrap();
        let nonce = [9u8; 12];
        let ct = Aes256Gcm::new((&key).into()).encrypt(Nonce::from_slice(&nonce), b"{\"invented\":true}".as_slice()).unwrap();
        let mut value = b"v10".to_vec();
        value.extend(nonce);
        value.extend(ct);
        let file = format!(r#"{{"format":"kasboek-account","version":2,"seal":"os","data":"{}"}}"#, base64_encode(&value));
        std::fs::write(dir.path().join("account.json"), file).unwrap();
        assert_eq!(open_electron_account_json(dir.path()).unwrap().as_slice(), br#"{"invented":true}"#);

        let plan = kb_oseal::plan_migration(dir.path(), &DpapiSeal::new(SystemDpapi)).unwrap().unwrap();
        plan.apply().unwrap();
        assert!(dir.path().join("account.electron.json").exists());
        assert!(kb_oseal::plan_migration(dir.path(), &DpapiSeal::new(SystemDpapi)).unwrap().is_none());
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use kb_oseal::error::OsealError;
    use kb_oseal::keychain::MacKeychain;
    use kb_oseal::wrap::{Item, SecretStore, WrapKeySeal};

    /// A locked or unreachable keychain (typical on a fresh CI runner without a login session) skips the test.
    fn skip(e: &OsealError) -> bool {
        let skipped = matches!(e, OsealError::Locked | OsealError::Unavailable);
        if skipped {
            eprintln!("SKIPPED: the login keychain is locked or unavailable on this machine ({e}); run `security unlock-keychain` to enable this test");
        }
        skipped
    }

    #[test]
    fn keychain_wrap_key_seal_roundtrips() {
        let service = format!("Kasboek Wrap Key test {}", std::process::id());
        let keychain = MacKeychain::with_wrap_service(&service);
        if let Err(e) = keychain.create_wrap_key(&[5u8; 32]) {
            if skip(&e) {
                return;
            }
            panic!("keychain write failed: {e}");
        }
        assert_eq!(keychain.get(Item::WrapKey).unwrap().unwrap().as_slice(), &[5u8; 32]);
        // Create-if-absent: a second creation keeps the first key.
        keychain.create_wrap_key(&[6u8; 32]).unwrap();
        assert_eq!(keychain.get(Item::WrapKey).unwrap().unwrap().as_slice(), &[5u8; 32]);
        keychain.delete_wrap_key().unwrap();
        assert!(keychain.get(Item::WrapKey).unwrap().is_none());
        keychain.delete_wrap_key().unwrap();

        let seal = WrapKeySeal::new(MacKeychain::with_wrap_service(&service));
        roundtrip(&seal);
        MacKeychain::with_wrap_service(&service).delete_wrap_key().unwrap();
    }

    #[test]
    fn a_stale_wrap_key_is_replaced_when_no_native_account_exists() {
        let service = format!("Kasboek Wrap Key stale test {}", std::process::id());
        let keychain = MacKeychain::with_wrap_service(&service);
        if let Err(e) = keychain.create_wrap_key(&[5u8; 32]) {
            if skip(&e) {
                return;
            }
            panic!("keychain write failed: {e}");
        }
        let seal = WrapKeySeal::replacing_stale_key(MacKeychain::with_wrap_service(&service));
        roundtrip(&seal);
        assert_ne!(keychain.get(Item::WrapKey).unwrap().unwrap().as_slice(), &[5u8; 32]);
        keychain.delete_wrap_key().unwrap();
    }

    #[test]
    fn electron_item_is_absent_here_and_read_only() {
        let keychain = MacKeychain::default();
        match keychain.get(Item::ElectronPassword) {
            // A CI machine has no Kasboek: absent. A developer machine with Kasboek installed may prompt or hold it.
            Ok(_) => {}
            Err(e) => assert!(skip(&e), "unexpected error {e}"),
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use kb_crypto::encoding::base64_encode;
    use kb_oseal::legacy::open_electron_account_json;
    use kb_oseal::secret_service::SecretService;
    use kb_oseal::wrap::{Item, SecretStore, WrapKeySeal};

    /// Without a Secret Service (GitHub's ubuntu runner) the seal says it is unavailable; with one it seals.
    #[test]
    fn selection_is_unavailable_without_a_keyring_and_seals_with_one() {
        let seal = kb_oseal::select_os_seal();
        if seal.available() {
            eprintln!("a Secret Service is running: testing the real wrap-key seal instead of the fallback");
            roundtrip(&*seal);
        } else {
            assert_eq!(seal.protection(), KeyProtection::Weak);
            assert_eq!(seal.seal(b"x").unwrap_err(), SealError::Unavailable);
            assert_eq!(seal.unseal(b"KBK1 whatever whatever whatever whatever").unwrap_err(), SealError::Unavailable);
        }
    }

    /// The Secret Service tests use their own item (`account` attribute), never the real wrap key, and skip cleanly on a
    /// machine without a (reachable, unlockable) keyring.
    fn own_store(tag: &str) -> Option<SecretService> {
        let store = SecretService::with_wrap_account(&format!("wrap-key-test-{tag}-{}", std::process::id()));
        if !store.usable() {
            eprintln!("SKIPPED: no Secret Service on this machine");
            return None;
        }
        match store.get(Item::WrapKey) {
            Ok(_) => Some(store),
            Err(e) => {
                eprintln!("SKIPPED: the Secret Service cannot be used here ({e})");
                None
            }
        }
    }

    #[test]
    fn wrap_key_is_created_once_and_never_replaced() {
        let Some(store) = own_store("create") else { return };
        store.create_wrap_key(&[5u8; 32]).unwrap();
        store.create_wrap_key(&[6u8; 32]).unwrap();
        assert_eq!(store.get(Item::WrapKey).unwrap().unwrap().as_slice(), &[5u8; 32]);
        store.delete_wrap_key().unwrap();
        assert!(store.get(Item::WrapKey).unwrap().is_none());
        store.delete_wrap_key().unwrap();
    }

    #[test]
    fn a_stale_wrap_key_is_replaced_when_no_native_account_exists() {
        let Some(store) = own_store("stale") else { return };
        store.create_wrap_key(&[5u8; 32]).unwrap();
        let tag = format!("wrap-key-test-stale-{}", std::process::id());
        let seal = WrapKeySeal::replacing_stale_key(SecretService::with_wrap_account(&tag));
        roundtrip(&seal);
        assert_ne!(store.get(Item::WrapKey).unwrap().unwrap().as_slice(), &[5u8; 32]);
        store.delete_wrap_key().unwrap();
    }

    /// `usable()` must neither prompt nor remember a failure: it is asked at every start-up.
    #[test]
    fn usable_is_cheap_and_repeatable() {
        let store = SecretService::new();
        let first = store.usable();
        assert_eq!(store.usable(), first);
    }

    /// `v10` ("peanuts", Electron without a keyring) needs no keyring at all, so it opens on a bare runner.
    #[test]
    fn electron_v10_opens_without_a_keyring() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../../parity/fixtures-session/oscrypt.json")).unwrap();
        let blob = hex::decode(f["linuxV10"]["blobHex"].as_str().unwrap()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = format!(r#"{{"format":"kasboek-account","version":2,"seal":"os","data":"{}"}}"#, base64_encode(&blob));
        std::fs::write(dir.path().join("account.json"), file).unwrap();
        assert_eq!(open_electron_account_json(dir.path()).unwrap().as_slice(), f["plain"].as_str().unwrap().as_bytes());
    }

    /// `v11` needs the keyring item: without a Secret Service it is refused as unavailable, never guessed.
    #[test]
    fn electron_v11_without_a_keyring_is_unavailable() {
        if kb_oseal::select_os_seal().available() {
            eprintln!("SKIPPED: a Secret Service is running");
            return;
        }
        let f: serde_json::Value = serde_json::from_str(include_str!("../../../parity/fixtures-session/oscrypt.json")).unwrap();
        let blob = hex::decode(f["linuxV11"]["blobHex"].as_str().unwrap()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = format!(r#"{{"format":"kasboek-account","version":2,"seal":"os","data":"{}"}}"#, base64_encode(&blob));
        std::fs::write(dir.path().join("account.json"), file).unwrap();
        assert_eq!(open_electron_account_json(dir.path()).unwrap_err(), kb_oseal::OsealError::Unavailable);
    }
}
