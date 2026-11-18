# Spike A: database and crypto compatibility with the Electron app

Standalone cargo project (its own `[workspace]`, not part of any `rust/Cargo.toml`). All data is invented and created
in a temporary directory that the test removes. Nothing generated is kept in the repo.

- `sqlite3mc-sys/` builds the sqlite3mc 2.4.0 amalgamation shipped in
  `node_modules/better-sqlite3-multiple-ciphers/deps/sqlite3/` (override with `KB_SQLITE3MC_DIR`) with the defines of
  `deps/defines.gypi`. The package is named `libsqlite3-sys` and swapped in through `[patch.crates-io]`, so rusqlite
  links sqlite3mc unchanged. Its Rust bindings are copied from libsqlite3-sys 0.40.0 (MIT).
- `src/db.rs` is the open sequence of `src/core/database.ts` (cipher chacha20, hexkey, probe, pragmas).
- `src/slot.rs` is the password slot of `src/core/crypto.ts` (Argon2id, NFKC, AES-256-GCM, label AAD).
- `src/bin/spike.rs` is a small CLI used by the Node checks.
- `node/cross.spec.ts` runs the app's own core (`openDatabase`, migrations, `makeSlot`/`openSlot`) against the binary.

## Rerun (from the repository root)

```
cargo build --release --manifest-path rust/spike/db/Cargo.toml        # about 1 minute, mostly the C amalgamation
npx vitest run --config rust/spike/db/node/vitest.config.ts --disableConsoleIntercept
```

`--disableConsoleIntercept` prints the Rust output (row counts, open time) and the Argon2 timings. Set
`KB_SPIKE_TMP` to choose where the temporary database goes and `KB_SPIKE_BIN` to test another binary.

Rust-only timing: `rust/spike/db/target/release/spike bench-kdf 5`.
