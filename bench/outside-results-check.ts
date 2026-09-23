// What justifies every row of `src/plan/outside-results.ts`: the functions outside this repository
// whose return type the local check is allowed to take on trust. No request is sent, and nothing
// here runs at review time — this reads a copy of the standard library and a machine's cargo
// registry, which a review run has neither of.
//
//   node bench/outside-results-check.ts --std <library dir> --registry <registry src dir> [--out <file>]
//
// Two passes:
//
//   1. **Candidates.** Every `pub fn` at the top level of any file of the standard library's `fs`,
//      `env` and `io` modules (their own file and every file of their directory, tests aside), of
//      `impl File`, and of serde_json's `src`, whose return type holds a `Result`.
//      The candidates come from the sources, never from the repositories this tool is measured on:
//      a table fitted to the corpus would make the measurement its own witness.
//   2. **Counterexamples.** Every definition in the registry and the standard library whose ending
//      reads the same as a candidate's (`fs::read_to_string`: a `fn read_to_string` in a file or
//      directory named `fs`; `File::open`: a `fn open` inside an `impl` for a type named `File`)
//      and whose return type holds no `Result`. A candidate with none may be a row at that length;
//      one with a counterexample is written longer (`std::env::var`) or left out.
//
// The count of definitions seen is printed for every candidate: a scan that reads nothing also
// finds no counterexample, and the two must be told apart. Rust writes a module's functions in the
// files of a directory as often as in `<name>.rs`, and a type's in an `impl` far from its `struct`,
// so both are walked.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { enclosingItem, itemHead, signatureAt } from "../src/plan/result-type.ts";

const { values } = parseArgs({ options: { std: { type: "string" }, registry: { type: "string" }, out: { type: "string" } } });
if (!values.std || !values.registry) throw new Error("usage: node bench/outside-results-check.ts --std <library dir> --registry <registry src dir> [--out <file>]");
const STD = resolve(values.std);
const REGISTRY = resolve(values.registry);

/** A function a call may name by a path, and what its own source says it returns. */
interface Candidate {
  path: string;
  from: string;
  returns: string;
}

const lines = (file: string) => readFileSync(file, "utf8").split("\n");

/** The `pub fn`s a file declares at its top level, with what each returns. */
function topLevelFunctions(file: string): { name: string; line: number; returns: string }[] {
  const source = lines(file);
  const found: { name: string; line: number; returns: string }[] = [];
  for (const [index, text] of source.entries()) {
    const declared = /^pub (?:async )?(?:unsafe )?fn ([a-z_][\w]*)/.exec(text);
    if (!declared) continue;
    const signature = signatureAt(source, index + 1, declared[1]!);
    if (signature.ok) found.push({ name: declared[1]!, line: index + 1, returns: signature.returns });
  }
  return found;
}

/** The `pub fn`s an `impl <type>` block declares, with what each returns. */
function methodsOf(file: string, type: string): { name: string; line: number; returns: string }[] {
  const source = lines(file);
  const found: { name: string; line: number; returns: string }[] = [];
  for (const [index, text] of source.entries()) {
    const declared = /^\s+pub (?:const )?(?:async )?(?:unsafe )?fn ([a-z_][\w]*)/.exec(text);
    if (!declared) continue;
    const enclosing = enclosingItem(source, index + 1);
    if (enclosing.kind !== "item") continue;
    const head = itemHead(enclosing.text);
    if (head.kind !== "impl" || head.self !== type) continue;
    const signature = signatureAt(source, index + 1, declared[1]!);
    if (signature.ok) found.push({ name: declared[1]!, line: index + 1, returns: signature.returns });
  }
  return found;
}

const holdsResult = (type: string) => /\bResult\b/.test(type);

// ---- pass 1: the candidates, from the sources themselves ----

/** Every `.rs` file of a module: its own file, and the files of its directory. */
function moduleFiles(root: string, module: string): string[] {
  const own = join(root, `${module}.rs`);
  const directory = join(root, module);
  const files = existsSync(own) ? [own] : [];
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith(".rs")) files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}

const candidates: Candidate[] = [];
const seenCandidate = new Set<string>();
const fromModule = (root: string, module: string, label: string) => {
  for (const file of moduleFiles(root, module)) {
    if (/(^|\/)tests?\.rs$/.test(file) || /(^|\/)tests\//.test(file)) continue;
    for (const fn of topLevelFunctions(file)) {
      const path = `${module}::${fn.name}`;
      if (!holdsResult(fn.returns) || seenCandidate.has(path)) continue;
      seenCandidate.add(path);
      candidates.push({ path, from: `${label}${file.slice(root.length + 1)}:${fn.line}`, returns: fn.returns });
    }
  }
};
fromModule(join(STD, "std/src"), "fs", "std/src/");
fromModule(join(STD, "std/src"), "env", "std/src/");
fromModule(join(STD, "std/src"), "io", "std/src/");
for (const fn of methodsOf(join(STD, "std/src/fs.rs"), "File")) {
  if (holdsResult(fn.returns)) candidates.push({ path: `File::${fn.name}`, from: `std/src/fs.rs:${fn.line}`, returns: fn.returns });
}
const serde = readdirSync(REGISTRY)
  .filter((name) => /^serde_json-/.test(name))
  .sort()
  .at(-1);
if (serde) {
  const root = join(REGISTRY, serde, "src");
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".rs")) continue;
    const file = join(entry.parentPath, entry.name);
    for (const fn of topLevelFunctions(file)) {
      const path = `serde_json::${fn.name}`;
      if (!holdsResult(fn.returns) || seenCandidate.has(path)) continue;
      seenCandidate.add(path);
      candidates.push({ path, from: `${serde}/${file.slice(join(REGISTRY, serde).length + 1)}:${fn.line}`, returns: fn.returns });
    }
  }
}

// ---- pass 2: definitions elsewhere whose ending reads the same ----

/** Every `.rs` line in the registry and the standard library that declares one of these names. */
function declarations(names: readonly string[]): { file: string; line: number; name: string }[] {
  const pattern = `fn (${names.join("|")})[(<]`;
  const out: { file: string; line: number; name: string }[] = [];
  for (const root of [REGISTRY, STD]) {
    const printed = execFileSync("grep", ["-rEn", "--include=*.rs", pattern, root], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    for (const hit of printed.split("\n")) {
      const parsed = /^(.+?):(\d+):(.*)$/.exec(hit);
      if (!parsed) continue;
      const name = new RegExp(`\\bfn (${names.join("|")})[(<]`).exec(parsed[3]!)?.[1];
      if (name) out.push({ file: parsed[1]!, line: Number(parsed[2]), name });
    }
  }
  return out;
}

/**
 * Whether a call writing `<holder>::<name>` could reach this definition.
 *
 * A type's is inside an `impl` for it. A module's and a crate's are at the top of a file — a `fn`
 * inside an `impl` is reached by a method call, never by the path, so `OpenOptions::read` is not a
 * second meaning of `fs::read(path)`. A definition in a test module is reached by nothing outside
 * its own crate's tests.
 */
function endsAs(file: string, line: number, holder: string): boolean {
  if (/(^|\/)(tests?|benches|examples)\//.test(file) || /(^|\/)tests?\.rs$/.test(file)) return false;
  const source = lines(file);
  const enclosing = enclosingItem(source, line);
  if (/^[A-Z]/.test(holder)) {
    if (enclosing.kind !== "item") return false;
    const head = itemHead(enclosing.text);
    return head.kind === "impl" && head.self === holder;
  }
  if (enclosing.kind !== "top") return false;
  const parts = file.split(sep);
  // A crate is a directory named `<crate>-<version>` under the registry, and a call writing
  // `serde_json::from_str` names what that crate puts at its root.
  if (parts.some((part) => new RegExp(`^${holder}-\\d`).test(part))) return true;
  // A module is a file of that name, or any file inside a directory of that name.
  return basename(file, ".rs") === holder || parts.slice(0, -1).includes(holder);
}

const byHolder = new Map<string, string[]>();
for (const candidate of candidates) {
  const [holder, name] = candidate.path.split("::") as [string, string];
  byHolder.set(holder, [...(byHolder.get(holder) ?? []), name]);
}

interface Checked {
  path: string;
  from: string;
  returns: string;
  /** Definitions a call could reach this way. */
  definitionsSeen: number;
  /** Of those, the ones whose signature this could not read, and so did not judge. */
  unread: number;
  counterexamples: { at: string; returns: string }[];
}
const checked: Checked[] = [];
for (const [holder, names] of byHolder) {
  const hits = declarations([...new Set(names)]);
  for (const name of new Set(names)) {
    const candidate = candidates.find((c) => c.path === `${holder}::${name}`)!;
    const here = hits.filter((hit) => hit.name === name && endsAs(hit.file, hit.line, holder));
    const counterexamples: { at: string; returns: string }[] = [];
    let unread = 0;
    for (const hit of here) {
      const signature = signatureAt(lines(hit.file), hit.line, name);
      if (!signature.ok) {
        unread++;
        continue;
      }
      if (!holdsResult(signature.returns)) counterexamples.push({ at: `${hit.file.replace(`${REGISTRY}/`, "").replace(`${STD}/`, "std: ")}:${hit.line}`, returns: signature.returns });
    }
    checked.push({ ...candidate, definitionsSeen: here.length, unread, counterexamples });
  }
}

const crates = readdirSync(REGISTRY).length;
// What a row may be matched on. A candidate nothing else defines that way is matched as a call
// writes it (`fs::rename`); one something else defines that way is matched only when the call
// names the standard library itself (`std::fs::read`, because `OpenOptions::read` is a builder).
/** The path a row is matched on when the short one has a second meaning, or null when it has none. */
function longerForm(path: string): string | null {
  const [holder] = path.split("::") as [string];
  if (/^[A-Z]/.test(holder)) return `fs::${path}`; // a type of the standard library's `fs`
  if (candidates.some((c) => c.path === path && c.from.startsWith("std/"))) return `std::${path}`;
  return null; // a crate's own path is already as long as it gets
}
const table = checked
  .filter((c) => c.definitionsSeen > 0)
  .map((c) => ({
    path: c.counterexamples.length === 0 ? c.path : longerForm(c.path),
    from: c.from,
    returns: c.returns,
    why:
      c.counterexamples.length === 0
        ? `${c.definitionsSeen} definitions a call could reach this way, in the standard library and the registry, all returning a Result`
        : `${c.counterexamples.length} of ${c.definitionsSeen} definitions a call could reach this way return something else (${c.counterexamples[0]!.returns} at ${c.counterexamples[0]!.at})`,
  }))
  .filter((row) => row.path !== null)
  .sort((a, b) => a.path!.localeCompare(b.path!));
const dropped = checked.filter((c) => c.definitionsSeen > 0 && c.counterexamples.length > 0 && longerForm(c.path) === null).map((c) => c.path);
const report = {
  sources: { std: values.std, registry: values.registry, crates },
  candidates: candidates.length,
  definitionsSeen: checked.reduce((n, c) => n + c.definitionsSeen, 0),
  unread: checked.reduce((n, c) => n + c.unread, 0),
  clean: checked.filter((c) => c.counterexamples.length === 0 && c.definitionsSeen > 0).map((c) => c.path),
  unseen: checked.filter((c) => c.definitionsSeen === 0).map((c) => c.path),
  refused: checked.filter((c) => c.counterexamples.length > 0).map((c) => ({ path: c.path, counterexamples: c.counterexamples })),
  dropped,
  table,
  checked: checked.sort((a, b) => a.path.localeCompare(b.path)),
};
if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify({ ...report, checked: undefined }, null, 1));
