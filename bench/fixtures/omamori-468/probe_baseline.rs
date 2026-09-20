//! What `integrity::read_baseline` does when the baseline path cannot be read as a regular file.
//!
//!   cargo run --quiet --example probe_baseline
//!
//! Untracked on purpose: the branches under measurement stay one-file diffs, and the packet is
//! built from git objects, which do not have this file.
//!
//! This is the path issue #468 describes — a non-regular file planted where omamori reads — and
//! PR #476's sentence is that it is "refused by name instead of … being silently treated as an
//! empty file". A directory is used rather than a FIFO: it is non-regular, it needs no second
//! process, and `open_read_regular` refuses it the same way.

use std::path::PathBuf;

fn main() {
    let base: PathBuf = std::env::temp_dir().join(format!("probe-baseline-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).expect("temp base dir");

    // Where read_baseline looks. Mirrors integrity::baseline_path, which is private.
    let path = base.join(".integrity.json");

    println!("-- nothing planted (a genuinely absent baseline)");
    report(&base);

    println!("-- a directory planted at the baseline path (non-regular, #468's shape)");
    std::fs::create_dir_all(&path).expect("plant a directory");
    report(&base);

    let _ = std::fs::remove_dir_all(&base);
}

fn report(base: &std::path::Path) {
    match omamori::integrity::read_baseline(base) {
        Ok(None) => println!("   read_baseline -> Ok(None)   \"there is no baseline\""),
        Ok(Some(_)) => println!("   read_baseline -> Ok(Some(..))"),
        Err(e) => println!("   read_baseline -> Err({e})"),
    }
}
