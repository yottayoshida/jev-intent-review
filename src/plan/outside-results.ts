// Functions outside this repository whose return type this check takes on trust — the only thing
// it claims about code it cannot read (ADR 0011).
//
// A row is matched against the **path a call writes**, by its ending: `fs::read_to_string` matches
// `fs::read_to_string(&p)` and `std::fs::read_to_string(&p)`, and `std::env::var` matches only the
// longer of the two, because `gix-path`'s `env::var` returns an `Option`. Method calls are not
// matched at all: Rust resolves a method by the type of its receiver, which this does not read, and
// the same name means different things on different types (`Metadata::file_type` returns a
// `FileType`, `DirEntry::file_type` an `io::Result<FileType>`).
//
// The ending alone is not enough: tokio has an `fs::write` and a `File::open` too (#83, ADR 0025).
// Where the file's `use` statements can be read, a row is not matched to another crate's function of
// that name: a call whose first name a `use` brings in from another crate (`use tokio::fs;`), or that
// is written from another crate (`tokio::fs::write`), matches nothing. A first name no `use` brings in —
// a glob, a `use super::*`, a `use` inside a macro — is matched by its ending as before.
//
// Every row is here because `bench/outside-results-check.ts` read the standard library's own source
// and a machine's cargo registry and found no definition a call could reach that way returning
// anything but a `Result`. The rows are taken from those sources, not from the repositories this
// tool is measured on. What the scan saw is `bench/logs/outside-results-check-v1.json`; its finding
// is "no counterexample in these 1,798 crates", not "no counterexample anywhere".

/** A function outside this repository, named by the ending of the path a call writes. */
export interface OutsideResult {
  /** The ending, as a call writes it: `fs::rename`, `std::env::var`, `serde_json::from_str`. */
  path: string;
  /** Where its own source says what it returns. */
  from: string;
  /** The return type read there, for the reason a report prints. */
  returns: string;
}

export const OUTSIDE_RESULTS: readonly OutsideResult[] = [
  { path: "env::current_dir", from: "std/src/env.rs:53", returns: "io::Result<PathBuf>" },
  { path: "env::current_exe", from: "std/src/env.rs:757", returns: "io::Result<PathBuf>" },
  { path: "env::join_paths", from: "std/src/env.rs:578", returns: "Result<OsString, JoinPathsError>" },
  { path: "env::set_current_dir", from: "std/src/env.rs:80", returns: "io::Result<()>" },
  { path: "File::create", from: "std/src/fs.rs:637", returns: "io::Result<File>" },
  { path: "File::create_buffered", from: "std/src/fs.rs:673", returns: "io::Result<io::BufWriter<File>>" },
  { path: "File::create_new", from: "std/src/fs.rs:711", returns: "io::Result<File>" },
  { path: "File::lock", from: "std/src/fs.rs:864", returns: "io::Result<()>" },
  { path: "File::lock_shared", from: "std/src/fs.rs:916", returns: "io::Result<()>" },
  { path: "File::open", from: "std/src/fs.rs:569", returns: "io::Result<File>" },
  { path: "File::open_buffered", from: "std/src/fs.rs:605", returns: "io::Result<io::BufReader<File>>" },
  { path: "File::set_len", from: "std/src/fs.rs:1120", returns: "io::Result<()>" },
  { path: "File::set_modified", from: "std/src/fs.rs:1276", returns: "io::Result<()>" },
  { path: "File::set_permissions", from: "std/src/fs.rs:1220", returns: "io::Result<()>" },
  { path: "File::set_times", from: "std/src/fs.rs:1267", returns: "io::Result<()>" },
  { path: "File::sync_all", from: "std/src/fs.rs:779", returns: "io::Result<()>" },
  { path: "File::sync_data", from: "std/src/fs.rs:811", returns: "io::Result<()>" },
  { path: "File::try_clone", from: "std/src/fs.rs:1182", returns: "io::Result<File>" },
  { path: "File::try_lock", from: "std/src/fs.rs:981", returns: "Result<(), TryLockError>" },
  { path: "File::try_lock_shared", from: "std/src/fs.rs:1045", returns: "Result<(), TryLockError>" },
  { path: "File::unlock", from: "std/src/fs.rs:1082", returns: "io::Result<()>" },
  { path: "fs::canonicalize", from: "std/src/fs.rs:3009", returns: "io::Result<PathBuf>" },
  { path: "fs::copy", from: "std/src/fs.rs:2854", returns: "io::Result<u64>" },
  { path: "fs::create_dir", from: "std/src/fs.rs:3051", returns: "io::Result<()>" },
  { path: "fs::create_dir_all", from: "std/src/fs.rs:3097", returns: "io::Result<()>" },
  { path: "fs::exists", from: "std/src/fs.rs:3503", returns: "io::Result<bool>" },
  { path: "fs::File::metadata", from: "std/src/fs.rs:1138", returns: "io::Result<Metadata>" },
  { path: "fs::hard_link", from: "std/src/fs.rs:2900", returns: "io::Result<()>" },
  { path: "fs::metadata", from: "std/src/fs.rs:2708", returns: "io::Result<Metadata>" },
  { path: "fs::read", from: "std/src/fs.rs:340", returns: "io::Result<Vec<u8>>" },
  { path: "fs::read_dir", from: "std/src/fs.rs:3285", returns: "io::Result<ReadDir>" },
  { path: "fs::read_link", from: "std/src/fs.rs:2966", returns: "io::Result<PathBuf>" },
  { path: "fs::read_to_string", from: "std/src/fs.rs:382", returns: "io::Result<String>" },
  { path: "fs::remove_dir", from: "std/src/fs.rs:3142", returns: "io::Result<()>" },
  { path: "fs::remove_dir_all", from: "std/src/fs.rs:3206", returns: "io::Result<()>" },
  { path: "fs::remove_file", from: "std/src/fs.rs:2669", returns: "io::Result<()>" },
  { path: "fs::rename", from: "std/src/fs.rs:2791", returns: "io::Result<()>" },
  { path: "fs::set_permissions", from: "std/src/fs.rs:3336", returns: "io::Result<()>" },
  { path: "fs::set_permissions_nofollow", from: "std/src/fs.rs:3355", returns: "io::Result<()>" },
  { path: "fs::set_times", from: "std/src/fs.rs:462", returns: "io::Result<()>" },
  { path: "fs::set_times_nofollow", from: "std/src/fs.rs:503", returns: "io::Result<()>" },
  { path: "fs::soft_link", from: "std/src/fs.rs:2932", returns: "io::Result<()>" },
  { path: "fs::symlink_metadata", from: "std/src/fs.rs:2743", returns: "io::Result<Metadata>" },
  { path: "fs::write", from: "std/src/fs.rs:419", returns: "io::Result<()>" },
  { path: "io::pipe", from: "std/src/io/pipe.rs:83", returns: "io::Result<(PipeReader, PipeWriter)>" },
  { path: "io::try_set_output_capture", from: "std/src/io/stdio.rs:1132", returns: "Result<Option<LocalStream>, AccessError>" },
  { path: "serde_json::from_reader", from: "serde_json-1.0.151/src/de.rs:2624", returns: "Result<T>" },
  { path: "serde_json::from_slice", from: "serde_json-1.0.151/src/de.rs:2667", returns: "Result<T>" },
  { path: "serde_json::from_str", from: "serde_json-1.0.151/src/de.rs:2709", returns: "Result<T>" },
  { path: "serde_json::from_value", from: "serde_json-1.0.151/src/value/mod.rs:1037", returns: "Result<T, Error>" },
  { path: "serde_json::to_raw_value", from: "serde_json-1.0.151/src/raw.rs:334", returns: "Result<Box<RawValue>, Error>" },
  { path: "serde_json::to_string", from: "serde_json-1.0.151/src/ser.rs:2245", returns: "Result<String>" },
  { path: "serde_json::to_string_pretty", from: "serde_json-1.0.151/src/ser.rs:2264", returns: "Result<String>" },
  { path: "serde_json::to_value", from: "serde_json-1.0.151/src/value/mod.rs:995", returns: "Result<Value, Error>" },
  { path: "serde_json::to_vec", from: "serde_json-1.0.151/src/ser.rs:2213", returns: "Result<Vec<u8>>" },
  { path: "serde_json::to_vec_pretty", from: "serde_json-1.0.151/src/ser.rs:2229", returns: "Result<Vec<u8>>" },
  { path: "serde_json::to_writer", from: "serde_json-1.0.151/src/ser.rs:2177", returns: "Result<()>" },
  { path: "serde_json::to_writer_pretty", from: "serde_json-1.0.151/src/ser.rs:2197", returns: "Result<()>" },
  { path: "std::env::var", from: "std/src/env.rs:228", returns: "Result<String, VarError>" },
  { path: "std::io::copy", from: "std/src/io/copy.rs:62", returns: "Result<u64>" },
  { path: "std::io::read_to_string", from: "std/src/io/mod.rs:1399", returns: "Result<String>" },
];

/** Paths that say the callee is in this repository, whatever the table holds. */
const INSIDE = new Set(["crate", "self", "super"]);

/** The rows by the name they end in, so a call is looked up by its last segment. */
const byName = new Map<string, OutsideResult[]>();
for (const row of OUTSIDE_RESULTS) {
  const name = row.path.split("::").at(-1)!;
  byName.set(name, [...(byName.get(name) ?? []), row]);
}

/** The crate a row is defined in, from where its source is: `std/src/fs.rs:340` → `std`, `serde_json-1.0.151/src/…` → `serde_json`. */
export const crateOf = (row: OutsideResult): string => row.from.split("/")[0]!.replace(/-\d[\w.-]*$/, "");

/**
 * The row a call's written path matches, or undefined. A call with no path (`entry.file_type()`)
 * matches nothing: the table is for paths, and a method is resolved by its receiver's type.
 *
 * `imports` gives the path a `use` brings a name in by at the call (`importOf`), or null when none
 * does. Without it — a file not read as Rust — the ending alone is matched, as before #83.
 */
export function outsideResult(callee: string, imports?: (name: string) => string[] | null): OutsideResult | undefined {
  const written = callee.split("::");
  if (written.length < 2 || INSIDE.has(written[0]!)) return undefined;
  let lookup = written;
  const brought = imports?.(written[0]!) ?? null;
  // An alias is read as what it names (`use std::fs::File as F;` — `F::open` is `File::open`), so a
  // call written through one can match a row it did not match before #83.
  if (brought && brought.at(-1) !== written[0]) lookup = [brought.at(-1)!, ...written.slice(1)];
  return byName.get(lookup.at(-1)!)?.find((row) => {
    const wanted = row.path.split("::");
    if (!(wanted.length <= lookup.length && wanted.every((segment, i) => segment === lookup[lookup.length - wanted.length + i]))) return false;
    if (!imports) return true;
    // Brought in by a `use`: from the row's crate only.
    if (brought) return brought[0] === crateOf(row);
    // Not brought in: the call is the row's path as it stands (`fs::write`), or written from the row's
    // crate (`std::fs::write`) — not from another (`tokio::fs::write`).
    return lookup.length === wanted.length || lookup[0] === crateOf(row);
  });
}

/** Whether the call names the standard library itself, which no definition here can be. */
export const namesTheStandardLibrary = (callee: string) => callee.startsWith("std::");
