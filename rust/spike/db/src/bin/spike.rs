//! Subcommands (all paths and secrets are arguments; nothing is stored in the repo):
//!   open-db <file> <keyhex>        open, check user_version, count rows per table, print totals
//!   wrong-key <file> <keyhex>      expect the open to fail
//!   write-db <file> <keyhex>       create a DB with the same pragmas and a tiny table
//!   unwrap <slot.json> <password>  print the unwrapped master key as hex (exit 1 if it fails)
//!   wrap <master-hex> <password> <m> <t> <p>   print a slot as JSON
//!   bench-kdf [runs]               time the real default KDF (m=131072, t=3, p=4)
use kb_spike_db::{db, slot};
use std::{path::Path, process::exit, time::Instant};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let arg = |i: usize| a.get(i).unwrap_or_else(|| { eprintln!("missing argument {i}"); exit(2) }).as_str();
    match arg(1) {
        "open-db" => {
            let t0 = Instant::now();
            let c = db::open(Path::new(arg(2)), arg(3)).unwrap_or_else(|e| { eprintln!("open failed: {e}"); exit(1) });
            let open_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let uv: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            println!("user_version={uv}");
            let sv: String = c.query_row("SELECT sqlite_version()", [], |r| r.get(0)).unwrap();
            println!("sqlite_version={sv}");
            let names: Vec<String> = c
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                .unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
            let mut total = 0i64;
            let t1 = Instant::now();
            for n in &names {
                let k: i64 = c.query_row(&format!("SELECT count(*) FROM \"{n}\""), [], |r| r.get(0)).unwrap();
                total += k;
                println!("table {n}={k}");
            }
            let sum: (i64, i64) = c.query_row("SELECT count(*), coalesce(sum(amount_cents),0) FROM transactions", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            println!("tables={} rows_total={total} tx_count={} tx_sum_cents={}", names.len(), sum.0, sum.1);
            println!("open_ms={open_ms:.2} count_all_ms={:.2}", t1.elapsed().as_secs_f64() * 1000.0);
            let fk: i64 = c.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
            println!("foreign_keys={fk}");
        }
        "wrong-key" => match db::open(Path::new(arg(2)), arg(3)) {
            Ok(_) => { eprintln!("UNEXPECTED: wrong key was accepted"); exit(1) }
            Err(e) => println!("rejected as expected: {e}"),
        },
        "write-db" => {
            let c = db::open(Path::new(arg(2)), arg(3)).unwrap();
            c.execute_batch("CREATE TABLE rust_made (id INTEGER PRIMARY KEY, note TEXT NOT NULL); INSERT INTO rust_made VALUES (1,'hello from rust'),(2,'zażółć € ✓'); PRAGMA user_version = 15;").unwrap();
            println!("written");
        }
        "unwrap" => {
            let s: slot::Slot = serde_json::from_str(&std::fs::read_to_string(arg(2)).unwrap()).unwrap();
            match slot::open_slot(&s, arg(3)) { Some(k) => println!("{}", hex::encode(k)), None => exit(1) }
        }
        "wrap" => {
            let master = hex::decode(arg(2)).unwrap();
            let (m, t, p) = (arg(4).parse().unwrap(), arg(5).parse().unwrap(), arg(6).parse().unwrap());
            let s = slot::make_slot(&master, arg(3), m, t, p, *b"rust-spike-salt!", *b"rust-iv-12by");
            println!("{}", serde_json::to_string(&s).unwrap());
        }
        "bench-kdf" => {
            let runs: usize = a.get(2).map_or(5, |s| s.parse().unwrap());
            let kdf = slot::Kdf { name: "argon2id".into(), m: 131072, t: 3, p: 4, salt: "AAECAwQFBgcICQoLDA0ODw==".into() };
            let mut ms = vec![];
            for _ in 0..runs {
                let t0 = Instant::now();
                slot::derive_key("correct horse battery staple", &kdf).unwrap();
                ms.push(t0.elapsed().as_secs_f64() * 1000.0);
            }
            println!("argon2id m=131072 t=3 p=4 runs_ms={:?}", ms.iter().map(|x| x.round()).collect::<Vec<_>>());
        }
        other => { eprintln!("unknown command {other}"); exit(2) }
    }
}
