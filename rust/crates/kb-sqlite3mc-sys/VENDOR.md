# Vendored database engine

This crate builds the same database engine as the Electron app: SQLite3 Multiple Ciphers (sqlite3mc) 2.4.0 on SQLite
3.53.4. The C source is copied into `vendor/`, so a build needs no Node.js and no `node_modules`.

| Item | Value |
|---|---|
| sqlite3mc | 2.4.0 (`SQLITE3MC_VERSION_STRING "SQLite3 Multiple Ciphers 2.4.0"`) |
| SQLite | 3.53.4 (`SQLITE_VERSION_NUMBER 3053004`, source id `2026-07-24 19:02:57 bf7c7f30...`) |
| Copied from | `node_modules/better-sqlite3-multiple-ciphers/deps/sqlite3/` (package version 13.0.3) |
| Files | `vendor/sqlite3.c`, `vendor/sqlite3.h`, `vendor/sqlite3ext.h` |
| Defines | `vendor/defines.gypi`, copied from `node_modules/better-sqlite3-multiple-ciphers/deps/defines.gypi` |
| sha256 sqlite3.c | `ad84d2c24540cf62ea27ee414911a32963390769bd031f39a50aec0ad90614a0` |
| sha256 sqlite3.h | `eae796d67d1a8236ed47b3fff858beb2d2a34f3b7ca0d8b6ea97e21729967374` |
| sha256 sqlite3ext.h | `ac9645e5c9ff0cf176efdd6e75cb5e98f46295d38e02db5c4d208826a39ab4be` |
| sha256 defines.gypi | `9139d3ce20fb5cd848e95da2fd20d4c4fd3d8d33b512d2781d70cb2a3de7c5bb` |
| Licences | `LICENSE-sqlite3mc` (MIT), `LICENSE-sqlite` (public domain), `LICENSE-libsqlite3-sys` (MIT, the Rust bindings) |

`LICENSE-sqlite3mc` was written from the file headers (the npm package ships no licence file for sqlite3mc itself).

## The 37 defines (read by build.rs from vendor/defines.gypi)

```
HAVE_INT16_T=1 HAVE_INT32_T=1 HAVE_INT8_T=1 HAVE_STDINT_H=1 HAVE_UINT16_T=1 HAVE_UINT32_T=1 HAVE_UINT8_T=1
HAVE_USLEEP=1 SQLITE_DEFAULT_CACHE_SIZE=-16000 SQLITE_DEFAULT_FOREIGN_KEYS=1 SQLITE_DEFAULT_MEMSTATUS=0
SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 SQLITE_DQS=0 SQLITE_ENABLE_COLUMN_METADATA SQLITE_ENABLE_DBSTAT_VTAB
SQLITE_ENABLE_DESERIALIZE SQLITE_ENABLE_FTS3 SQLITE_ENABLE_FTS3_PARENTHESIS SQLITE_ENABLE_FTS4 SQLITE_ENABLE_FTS5
SQLITE_ENABLE_GEOPOLY SQLITE_ENABLE_JSON1 SQLITE_ENABLE_MATH_FUNCTIONS SQLITE_ENABLE_PERCENTILE SQLITE_ENABLE_RTREE
SQLITE_ENABLE_STAT4 SQLITE_ENABLE_UPDATE_DELETE_LIMIT SQLITE_LIKE_DOESNT_MATCH_BLOBS SQLITE_OMIT_DEPRECATED
SQLITE_OMIT_PROGRESS_CALLBACK SQLITE_OMIT_SHARED_CACHE SQLITE_OMIT_TCL_VARIABLE SQLITE_SOUNDEX SQLITE_THREADSAFE=2
SQLITE_TRACE_SIZE_LIMIT=32 SQLITE_USER_AUTHENTICATION=0 SQLITE_USE_URI=0
```

On top of these, build.rs passes what better-sqlite3's Release build passes: `NDEBUG`, `-O3`, `-std=c99`, no warnings.
build.rs asserts that there are exactly 37 defines, so a changed list cannot pass unnoticed.

## Why the package is called libsqlite3-sys

rusqlite depends on `libsqlite3-sys`. The workspace (`rust/Cargo.toml`) has
`[patch.crates-io] libsqlite3-sys = { path = "crates/kb-sqlite3mc-sys" }`, and cargo only accepts a patch whose package
name and version match. So the package is named `libsqlite3-sys`, version `0.40.0` (the version rusqlite 0.43 asks for,
`libsqlite3-sys = "0.40.0"` in its manifest), while the directory keeps the product name. The Rust side
(`src/`, `bindings/`) is copied from libsqlite3-sys 0.40.0, which only declares the SQLite C API; sqlite3mc keeps that API.
`kb-db` has a test that fails if the linked engine is not sqlite3mc 2.4.0 / SQLite 3.53.4.

## Updating

1. Update the Electron side first: bump `better-sqlite3-multiple-ciphers` in the root `package.json`, `npm install`.
   Both sides must use the same engine version, or the cross-open tests (`rust/parity`) are meaningless.
2. Copy the three files from `node_modules/better-sqlite3-multiple-ciphers/deps/sqlite3/` and `deps/defines.gypi`
   into `vendor/`.
3. Update this file: versions, sha256 sums (`sha256sum vendor/*`), the defines list, and the number 37 in `build.rs`.
4. Update the expected versions in `rust/crates/kb-db/tests/engine.rs`.
5. If a new rusqlite needs another `libsqlite3-sys` version: copy `src/` and `bindings/bindgen_bundled_version.rs` from
   that libsqlite3-sys release (`cargo download` or the crates.io archive), change `version` in `Cargo.toml` to match
   rusqlite's requirement, and keep `[patch.crates-io]` pointing here. Update the workspace `rusqlite` pin and
   `Cargo.lock` in the same change (`cargo update -p rusqlite`).
6. `cargo test --workspace` and the parity suite (`npx vitest run --config rust/parity/vitest.config.ts`).
