//! Sync files (.kbsync): `"KBSYNC1\n" | uint32 BE header length | header JSON | 12-byte IV | 16-byte GCM tag |
//! AES-256-GCM(deflate-raw(payload JSON))`, with the magic and header as associated data. Port of src/core/sync-file.ts.
//!
//! Compressed bytes differ between zlib builds, so compare decoded JSON, never the files.
use crate::aead::{IV_LEN, TAG_LEN};
use crate::random_bytes;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use std::io::{Read, Write};
use thiserror::Error;
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"KBSYNC1\n";
/// `maxOutputLength` of the inflate step.
pub const MAX_INFLATED: usize = 256 * 1024 * 1024;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SyncFileError {
    #[error("not a sync file")]
    NotSyncFile,
    #[error("the header is damaged")]
    BadHeader,
    #[error("header {0} mismatch")]
    HeaderMismatch(String),
    /// Wrong key, or the file or its header was changed.
    #[error("the sync file could not be decrypted")]
    Decrypt,
    #[error("the sync file is damaged or too large")]
    Inflate,
    #[error("the sync payload is not valid JSON of the expected shape")]
    Payload,
}

pub fn seal_sync_file(key: &[u8; 32], header: &Map<String, Value>, payload: &Value) -> Vec<u8> {
    seal_sync_file_with_iv(key, header, payload, random_bytes::<IV_LEN>())
}

/// `seal_sync_file` with a chosen IV, for known-answer tests only.
pub fn seal_sync_file_with_iv(key: &[u8; 32], header: &Map<String, Value>, payload: &Value, iv: [u8; IV_LEN]) -> Vec<u8> {
    let header_bytes = serde_json::to_vec(header).expect("a JSON map always serialises");
    let json = Zeroizing::new(serde_json::to_vec(payload).expect("a JSON value always serialises"));
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&json).expect("writing to a Vec cannot fail");
    let compressed = Zeroizing::new(encoder.finish().expect("writing to a Vec cannot fail"));
    let mut aad = MAGIC.to_vec();
    aad.extend_from_slice(&header_bytes);
    let sealed = Aes256Gcm::new(key.into())
        .encrypt(Nonce::from_slice(&iv), Payload { msg: &compressed, aad: &aad })
        .expect("AES-GCM encryption of an in-memory buffer cannot fail");
    let (ciphertext, tag) = sealed.split_at(sealed.len() - TAG_LEN);
    let mut file = MAGIC.to_vec();
    file.extend_from_slice(&u32::try_from(header_bytes.len()).expect("header below 4 GiB").to_be_bytes());
    file.extend_from_slice(&header_bytes);
    file.extend_from_slice(&iv);
    file.extend_from_slice(tag);
    file.extend_from_slice(ciphertext);
    file
}

/// Decrypts and decodes a sync file. Every key of `expect` must equal the same key of the header
/// (the file's place: account, device, sequence).
pub fn open_sync_file<T: DeserializeOwned>(key: &[u8; 32], file: &[u8], expect: &Map<String, Value>) -> Result<T, SyncFileError> {
    open_sync_file_capped(key, file, expect, MAX_INFLATED)
}

pub(crate) fn open_sync_file_capped<T: DeserializeOwned>(
    key: &[u8; 32],
    file: &[u8],
    expect: &Map<String, Value>,
    cap: usize,
) -> Result<T, SyncFileError> {
    if file.len() < MAGIC.len() + 4 + IV_LEN + TAG_LEN || &file[..MAGIC.len()] != MAGIC {
        return Err(SyncFileError::NotSyncFile);
    }
    let header_len = u32::from_be_bytes(file[MAGIC.len()..MAGIC.len() + 4].try_into().expect("4 bytes")) as usize;
    let start = MAGIC.len() + 4;
    let header_bytes = file.get(start..start + header_len).ok_or(SyncFileError::BadHeader)?;
    let header: Value = serde_json::from_slice(header_bytes).map_err(|_| SyncFileError::BadHeader)?;
    for (k, v) in expect {
        if header.get(k) != Some(v) {
            return Err(SyncFileError::HeaderMismatch(k.clone()));
        }
    }
    let rest = &file[start + header_len..];
    if rest.len() < IV_LEN + TAG_LEN {
        return Err(SyncFileError::BadHeader);
    }
    let (iv, rest) = rest.split_at(IV_LEN);
    let (tag, ciphertext) = rest.split_at(TAG_LEN);
    let mut sealed = ciphertext.to_vec();
    sealed.extend_from_slice(tag);
    let mut aad = MAGIC.to_vec();
    aad.extend_from_slice(header_bytes);
    let compressed = Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(iv), Payload { msg: &sealed, aad: &aad })
        .map(Zeroizing::new)
        .map_err(|_| SyncFileError::Decrypt)?;
    let mut json = Zeroizing::new(Vec::new());
    DeflateDecoder::new(compressed.as_slice()).take(cap as u64 + 1).read_to_end(&mut json).map_err(|_| SyncFileError::Inflate)?;
    if json.len() > cap {
        return Err(SyncFileError::Inflate);
    }
    serde_json::from_slice(&json).map_err(|_| SyncFileError::Payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: [u8; 32] = [0x11; 32];

    fn header() -> Map<String, Value> {
        json!({"v": 1, "device": "dev-a", "seq": 7}).as_object().unwrap().clone()
    }

    #[test]
    fn roundtrip_and_header_checks() {
        let payload = json!({"changes": [{"tbl": "accounts", "uid": "u1", "name": "Invented ✓"}]});
        let file = seal_sync_file(&KEY, &header(), &payload);
        let got: Value = open_sync_file(&KEY, &file, &json!({"device": "dev-a", "seq": 7}).as_object().unwrap().clone()).unwrap();
        assert_eq!(got, payload);
        let mismatch = open_sync_file::<Value>(&KEY, &file, json!({"device": "dev-b"}).as_object().unwrap());
        assert_eq!(mismatch.err(), Some(SyncFileError::HeaderMismatch("device".into())));
        let missing = open_sync_file::<Value>(&KEY, &file, json!({"nope": 1}).as_object().unwrap());
        assert_eq!(missing.err(), Some(SyncFileError::HeaderMismatch("nope".into())));
    }

    #[test]
    fn wrong_key_and_changes_are_refused() {
        let file = seal_sync_file(&KEY, &header(), &json!({"a": 1}));
        assert_eq!(open_sync_file::<Value>(&[0x12; 32], &file, &Map::new()).err(), Some(SyncFileError::Decrypt));
        let mut changed = file.clone();
        changed[8 + 4 + 3] ^= 1; // a character inside the header: the AAD no longer matches
        assert!(open_sync_file::<Value>(&KEY, &changed, &Map::new()).is_err());
        let mut last = file.clone();
        *last.last_mut().unwrap() ^= 1;
        assert_eq!(open_sync_file::<Value>(&KEY, &last, &Map::new()).err(), Some(SyncFileError::Decrypt));
        assert_eq!(open_sync_file::<Value>(&KEY, b"KBSYNC1\nshort", &Map::new()).err(), Some(SyncFileError::NotSyncFile));
        assert_eq!(open_sync_file::<Value>(&KEY, &[b'x'; 80], &Map::new()).err(), Some(SyncFileError::NotSyncFile));
    }

    #[test]
    fn inflated_size_is_capped() {
        let payload = json!({"pad": "a".repeat(5000)});
        let file = seal_sync_file(&KEY, &header(), &payload);
        assert!(open_sync_file_capped::<Value>(&KEY, &file, &Map::new(), 6000).is_ok());
        assert_eq!(open_sync_file_capped::<Value>(&KEY, &file, &Map::new(), 4000).err(), Some(SyncFileError::Inflate));
    }
}
