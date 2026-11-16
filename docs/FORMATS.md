# Kasboek file formats

What a second Kasboek app (a phone app, for example) needs in order to open the desktop's data and
take part in sync. `src/core/portable.ts` implements the reading side using only WebCrypto,
`DecompressionStream` and `hash-wasm`, and `tests/portable.test.ts` checks it against files the
desktop code writes. `src/core/sync-store.ts` (WebDAV, `fetch` only) is the sync transport a phone
can use as is.

All integers are big-endian. "AES-GCM" means AES-256-GCM with a 12-byte IV and a 16-byte tag.

## Keys

```
password ──Argon2id──┐
                     ├─► master key (32 bytes) ─► vault { dbKey, totp } ─► database (sqlite3mc, chacha20)
recovery key ──HKDF──┘                                                     └─► secrets.syncKey ─► sync files
```

- **Slot**: `{ kdf, sealed: { iv, ct } }`. `ct` = AES-GCM(master key) + tag, base64, with associated
  data `kasboek:slot:password` or `kasboek:slot:recovery`.
- **Slot KDF**:
  - `argon2id { m (KiB), t, p, salt }`: password NFKC-normalised, 32-byte output. The default is
    m = 131072, t = 3, p = 4.
  - `hkdf { salt }`: HKDF-SHA256, with info `kasboek:slot`. It is used for the recovery key, which is
    normalised to `XXXX-XXXX-…` (base32 upper case, groups of 4).
  - `scrypt { N, r, p, salt }`: older slots only.
- **2FA**: TOTP (RFC 6238), SHA-1, 6 digits, 30 s. The secret is in the vault (`totp.secret`, base32).
  It is checked after the file is decrypted, so the code is a second factor, not part of the key.
- **Device seal**: on each computer, the login slots are also sealed by the operating system
  (DPAPI, Keychain, libsecret) in `account.json`. That file never leaves the computer. A phone makes
  its own, with the Android Keystore or the iOS Keychain.

## Export, backup and sync snapshot (`.kasboek`)

```
"KASBOEK2" | uint32 header length | header JSON | AES-GCM ciphertext | 16-byte tag
```

- **Header**:
  `{ format: 2, kind, createdAt, appVersion, schemaVersion, mode, twoFactor, slots: { password?, recovery }, salt, iv }`.
- **File key**: HKDF-SHA256(master key, salt, info `kasboek:file:v2`).
- **Associated data**: everything before the ciphertext (the magic, the length and the header).
- **Plaintext**: `uint32 vault length | vault JSON | database file`. The database file is still
  encrypted with `vault.dbKey`.

## Database

SQLite3 Multiple Ciphers, `PRAGMA cipher='chacha20'; PRAGMA hexkey='<vault.dbKey>'`, set before any
other statement. `schemaVersion` in the header is the migration number (`src/core/migrations.ts`).

- **Phones**: sqlite3mc has native builds for Android and iOS, and a WASM build that can run in a
  WebView. SQLCipher libraries can't open it, because the cipher differs.
- **Opening a desktop database in the WASM build**: still to be tested, because the check could not
  be run in this environment.

## Sync folder (`Kasboek sync/`)

```
group.json                  { "format": 1, "groupId": "<hex>", "createdAt": "…" }   (not encrypted, no secrets)
<device>/c-<seq>.kbsync     that device's changes, numbered from 1 without gaps
<device>/state.kbsync       { deviceId, label, lastSeen, seq, applied, snapshotApplied, snapshotAt, floor }
<device>/snapshot.kasboek   a full copy (format above), to join from
```

- **Sync file layout**:
  `"KBSYNC1\n" | uint32 header length | header JSON | 12-byte IV | 16-byte tag | ciphertext`.
- **Associated data**: the magic followed by the header.
- **Plaintext**: deflate-raw (JSON).
- **Headers**: `{ kind: "changes", groupId, device, seq }` or `{ kind: "state", groupId, device }`.
  A reader checks them against the file's place.
- **Key**: the sync key, which is the hex value of `secrets.syncKey` in the database.
- **Changes**: rows of the synced tables, by `uid`, with a hybrid logical clock per field. See
  `src/core/sync.ts` (`Change`, `apply`) and `src/core/sync-schema.ts` (which tables and columns).
- **Rules for a writer**:
  - write each file whole (temporary name, then rename or MOVE);
  - never reuse a sequence number;
  - remove its own change files only once every active device's `applied`, and its own snapshot,
    include them.

## Transport

- **A folder**: a cloud app keeps it in step. This is the desktop default.
- **WebDAV**: `src/core/sync-store.ts`. The address is the folder on the server. `Kasboek sync/` is
  created inside it.
  - Requests: GET, PUT, MOVE (falling back to a direct PUT), MKCOL, DELETE, and PROPFIND with
    Depth 1.
  - Authentication: Basic, over https, or plain http inside the home network.
