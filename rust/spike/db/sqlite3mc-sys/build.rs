use std::path::PathBuf;

// Defines copied from node_modules/better-sqlite3-multiple-ciphers/deps/defines.gypi, plus the Release flags
// of common.gypi (NDEBUG, -O3) and sqlite3.gyp (-std=c99, -w).
const DEFINES: &[&str] = &[
    "HAVE_INT16_T=1", "HAVE_INT32_T=1", "HAVE_INT8_T=1", "HAVE_STDINT_H=1", "HAVE_UINT16_T=1", "HAVE_UINT32_T=1",
    "HAVE_UINT8_T=1", "HAVE_USLEEP=1", "SQLITE_DEFAULT_CACHE_SIZE=-16000", "SQLITE_DEFAULT_FOREIGN_KEYS=1",
    "SQLITE_DEFAULT_MEMSTATUS=0", "SQLITE_DEFAULT_WAL_SYNCHRONOUS=1", "SQLITE_DQS=0", "SQLITE_ENABLE_COLUMN_METADATA",
    "SQLITE_ENABLE_DBSTAT_VTAB", "SQLITE_ENABLE_DESERIALIZE", "SQLITE_ENABLE_FTS3", "SQLITE_ENABLE_FTS3_PARENTHESIS",
    "SQLITE_ENABLE_FTS4", "SQLITE_ENABLE_FTS5", "SQLITE_ENABLE_GEOPOLY", "SQLITE_ENABLE_JSON1",
    "SQLITE_ENABLE_MATH_FUNCTIONS", "SQLITE_ENABLE_PERCENTILE", "SQLITE_ENABLE_RTREE", "SQLITE_ENABLE_STAT4",
    "SQLITE_ENABLE_UPDATE_DELETE_LIMIT", "SQLITE_LIKE_DOESNT_MATCH_BLOBS", "SQLITE_OMIT_DEPRECATED",
    "SQLITE_OMIT_PROGRESS_CALLBACK", "SQLITE_OMIT_SHARED_CACHE", "SQLITE_OMIT_TCL_VARIABLE", "SQLITE_SOUNDEX",
    "SQLITE_THREADSAFE=2", "SQLITE_TRACE_SIZE_LIMIT=32", "SQLITE_USER_AUTHENTICATION=0", "SQLITE_USE_URI=0",
];

fn main() {
    println!("cargo:rerun-if-env-changed=KB_SQLITE3MC_DIR");
    let dir = std::env::var("KB_SQLITE3MC_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../node_modules/better-sqlite3-multiple-ciphers/deps/sqlite3")
    });
    let src = dir.join("sqlite3.c");
    println!("cargo:rerun-if-changed={}", src.display());
    let mut b = cc::Build::new();
    b.file(&src).include(&dir).std("c99").warnings(false).opt_level(3).define("NDEBUG", None);
    for d in DEFINES {
        match d.split_once('=') {
            Some((k, v)) => b.define(k, v),
            None => b.define(d, None),
        };
    }
    b.compile("sqlite3");
}
