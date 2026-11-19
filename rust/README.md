# Rust workspace (native port, `rust-native` branch)

The real code of the port described in `docs/rust-port-plan.md`. The Electron app keeps shipping from `main`. The
throw-away spikes of milestone M0 stay in `spike/` with their own workspaces and are not part of this one.

Rust 1.97 (`rust-version` in `Cargo.toml`; CI pins 1.97.0). Licence of the workspace: GPL-3.0-only.

## Layout

| Path | What it is |
|---|---|
| `Cargo.toml` | Workspace: shared package fields and dependency versions, the `[patch.crates-io]` that makes rusqlite link sqlite3mc, the release profile (LTO, strip, one codegen unit, abort on panic). |
| `crates/kb-sqlite3mc-sys` | The database engine: sqlite3mc 2.4.0 / SQLite 3.53.4, vendored, built with `cc`. See its `VENDOR.md`. Named `libsqlite3-sys` so the patch applies. |
| `crates/kb-crypto` | Key slots (Argon2id, legacy scrypt, HKDF recovery), vault seal, TOTP, recovery key, base32/base64/hex, and the `.kasboek` (KASBOEK2) and `.kbsync` (KBSYNC1) codecs. Port of `src/core/{crypto,totp,account,transfer-format,sync-file}.ts`. Keys are `Zeroizing`; errors are typed and carry the TypeScript error codes. |
| `crates/kb-db` | The storage boundary. `Store` trait, `SqliteStore` on sqlite3mc, open/unlock sequence of `src/core/database.ts`, the 15 migrations (same SQL), sync tables and triggers, the `fx()` SQL function, integrity check, `VACUUM INTO`, canonical dump for the conformance tests, and `Queries`: the typed reads and writes behind the business operations. All SQL lives here. No business logic. |
| `crates/kb-core` | M2, slices 1 and 2. The op table of all 154 operations with their flags, `dispatch(core, op, input, actor)` (locked refusal, zod-like input validation, audit log), `AppError`, `Actor`, injected `Clock` and `Rng`, and the ported operations: accounts, categories, settings, prefs, saved searches, transactions (list, create, edit, splits, bulk), balances, valuations, exchange rates; slice 2: rules, budgets, summaries (month, year, review), net worth, alerts, goals, recurring payments, transfers. 55 of 154 operations are ported; the others answer `op.not_ported`. No SQL: it depends on `kb-db`'s traits. `contract.json` is generated from the TypeScript sources. |
| `crates/kb-cli` | Dev-only binary `kb-cli` for the parity suite (never shipped). `kb-cli help` lists the commands; `kb-cli scenario file.json` runs a scenario of ops through kb-core. |
| `parity/` | Node side of the differential tests (vitest) and the known-answer fixtures. |

Not here yet (later milestones of the plan): the rest of kb-core (see `docs/rust-port-plan.md`, section 10, M2 progress), kb-import, kb-pdf, kb-assistant, kb-sync, kb-i18n, kb-platform,
kb-ui, the app binary.

## Run the tests (from the repository root)

```
cargo build --workspace --release --manifest-path rust/Cargo.toml     # about 1 minute, mostly the C amalgamation
cargo test --workspace --manifest-path rust/Cargo.toml
cargo clippy --workspace --manifest-path rust/Cargo.toml -- -D warnings
cargo fmt --all --check --manifest-path rust/Cargo.toml

npm ci --ignore-scripts                                               # once; installs the app's own core and vitest
npx vitest run --config rust/parity/vitest.config.ts                  # needs the release build of kb-cli
```

- The parity suite runs the app's own TypeScript code (`src/core`, with better-sqlite3-multiple-ciphers and hash-wasm)
  against `kb-cli`, in both directions: databases at schema 1 to 15 (Rust migrates a TS-made file and the canonical dump
  equals TS's migration of the same file, and the reverse), password, recovery and scrypt slots, the vault seal, TOTP
  (RFC 6238 vectors), `.kasboek` and `.kbsync` files, `fx()` results, wrong keys and refusals.
- The scenario suite (`parity/scenarios.spec.ts`) runs every file of `parity/scenarios/*.json` and a seeded household of about
  2,000 transactions through the app's own `dispatch` (`src/main/ipc.ts`, with Electron and the session mocked) and through
  `kb-cli scenario`, on a fresh invented encrypted database with a fixed clock (UTC), and diffs every op result and a dump of
  all tables (random ids and `*_at` times masked). A scenario is `{name, clock?, languages?, prefs?, steps: [{op, input, actor?}]}`;
  steps starting with `@` are harness steps (`@lock`, `@unlock`, `@sql` for seeding invented rows, `@fxReload`,
  `@resetImportedSettings`). The random `transfer_pair` keys are numbered in order of first appearance in the dumps. The text of `op.invalid_input` / `op.failed` errors is not compared, only their code.
- `parity/contract.spec.ts` regenerates `crates/kb-core/contract.json` (op names and flags, input JSON Schemas, enums, defaults,
  currency list) from the TypeScript sources and fails when the committed file is stale:
  `KB_WRITE_CONTRACT=1 npx vitest run --config rust/parity/vitest.config.ts contract` rewrites it. The kb-core tests compare the
  Rust op table with it.
- `KB_CLI_BIN` selects another `kb-cli` binary (default: `rust/target/release/kb-cli`, then `debug`).
  `KB_PARITY_TMP` selects where the temporary files go. They are removed afterwards.
- `rust/parity/vitest.config.ts` is separate from the repository's `vitest.config.ts`, which only includes `tests/**`, so
  `npm test` ignores the parity suite.
- The cargo tests also read the committed fixtures (`kb-crypto/tests/kat.rs`, `kb-db/tests/kat.rs`), so
  `cargo test` alone already checks Rust against files the TypeScript core made.

## Fixtures

`parity/fixtures/` holds known-answer files made by the TypeScript core: slots, a vault, two `.kasboek` files, a
`.kbsync` file, databases at schema 1, 15 and schema 1 migrated by TS, and `kat.json` with the keys and expected
answers. Everything is invented and protects nothing real. They are committed, and only regenerated when a format
changes on purpose:

```
KB_WRITE_FIXTURES=1 npx vitest run --config rust/parity/vitest.config.ts gen-fixtures
```

`rust/.gitattributes` keeps line endings as they are on Windows checkouts (migration SQL is stored in the database and
compared as text; the fixtures are compared byte for byte).

## Updating the vendored sqlite3mc

Both sides must run the same engine. Bump `better-sqlite3-multiple-ciphers` in the root `package.json` first, then
copy the amalgamation and `defines.gypi` into `crates/kb-sqlite3mc-sys/vendor/` and update `VENDOR.md`, the expected
versions in `crates/kb-db/tests/engine.rs`, and (when rusqlite needs it) the `libsqlite3-sys` shim. The full steps are
in `crates/kb-sqlite3mc-sys/VENDOR.md`.

## Rules

- No real data. Fixtures, tests and examples use invented names, IBANs, amounts and keys. Never commit a file from
  a real Kasboek folder, a real bank export or a real key. The owner's own comparisons run locally and their results
  stay out of the repository.
- A shipped migration never changes: add a new one, port it in the same change as the TypeScript one, and extend the
  parity suite.
- Only `kb-db` talks to the database engine. `kb-core` (M2) depends on the `Store` trait.
- Secrets live in `Zeroizing` buffers and are never logged. No `unwrap` on user data; typed errors.
- Compare decoded content, not compressed bytes (`.kbsync` uses zlib).
