// Scoring a selected set, and deciding which of its sites a question can be put to.
// No model, no network: the applicability check gets a repository made of two strings.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import { enumerate } from "../src/plan/candidates.ts";
import { applicabilityOf } from "../src/plan/applicability.ts";
import { locateCall } from "../src/plan/local-check.ts";
import { redact } from "../src/evidence/redact.ts";
import type { Discoverer } from "../src/discovery/discover.ts";
import { reachesTheDefect, scoreSet, type SiteOutcome } from "../bench/set-scoring.ts";

const SOURCE = `pub fn read_baseline(base_dir: &Path) -> Result<Option<Baseline>, AppError> {
    let path = baseline_path(base_dir);
    if !path.exists() || path.symlink_metadata().is_ok() {
        return Ok(None);
    }
    let n = maybe_value().unwrap_or(0);
    let a = read_capped(a_path)?;
    let b = read_capped(b_path).unwrap_or_default();
    Ok(Some(a))
}
`;

const HELPERS = `pub(crate) fn read_capped(path: &Path) -> io::Result<String> {
    Ok(String::new())
}

fn maybe_value() -> Option<u32> {
    None
}

fn baseline_path(base_dir: &Path) -> PathBuf {
    base_dir.join(".integrity.json")
}
`;

const c = enumerate("src/integrity.rs", SOURCE);
const fn = c.functions.find((f) => f.name === "read_baseline")!;
const reads = c.calls.filter((k) => k.callee === "read_capped");
const existsCall = c.calls.find((k) => k.callee === "exists")!;
const maybeCall = c.calls.find((k) => k.callee === "maybe_value")!;

/** A repository of two files, answering the two things `applicabilityOf` asks of a Discoverer. */
const FILES: Record<string, string> = { "src/integrity.rs": SOURCE, "src/util.rs": HELPERS };
const fakeDiscoverer = {
  async search(word: string) {
    const hits = Object.entries(FILES).flatMap(([path, text]) =>
      text.split("\n").flatMap((line, i) => (new RegExp(`(?<![\\w$])${word}(?![\\w$])`).test(line) ? [{ path, line: i + 1, text: line }] : [])),
    );
    return { hits, more: false };
  },
  async index(path: string) {
    return FILES[path] ? new BlockIndex(FILES[path]!.split("\n")) : null;
  },
} as unknown as Discoverer;

test("reaching the defect is the call, not the function it is in", () => {
  const truth = { functionName: "read_baseline", callExpression: reads[0]!.expression };
  const onlyExists = reachesTheDefect([{ fn, call: existsCall }], truth);
  assert.equal(onlyExists.call, false);
  assert.equal(onlyExists.functionOnly, true, "being in the right function is worth saying, not silently false");
  assert.equal(reachesTheDefect([{ fn, call: reads[0]! }], truth).call, true);
  assert.equal(reachesTheDefect([], truth).call, false);
});

test("two calls to the same helper in one body are two different places", () => {
  // The earlier version matched on the callee's bare name and called either of these a hit.
  assert.equal(reads.length, 2);
  const truth = { functionName: "read_baseline", callExpression: reads[0]!.expression };
  const wrongOne = reachesTheDefect([{ fn, call: reads[1]! }], truth);
  assert.equal(wrongOne.call, false, "the other call to the same helper is not the one the patch changed");
  assert.equal(wrongOne.functionOnly, true);
});

test("a callee defined here and returning a Result can carry the condition", async () => {
  const r = await applicabilityOf(fakeDiscoverer, fn, reads[0]!);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.calleeDefinedAt, /src\/util\.rs:1/);
});

test("the neighbour's `.is_ok()` no longer lets a bool through", async () => {
  // `if !path.exists() || path.symlink_metadata().is_ok()` — the line has `.is_ok()` on it, and
  // the old check read the line. `exists` has no definition here, so it is held.
  const r = await applicabilityOf(fakeDiscoverer, fn, existsCall);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "callee_unresolved");
    assert.match(r.reason, /no definition in this repository/);
  }
});

test("an Option is not a Result, whatever `unwrap_or` looks like", async () => {
  const r = await applicabilityOf(fakeDiscoverer, fn, maybeCall);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "callee_not_result");
    assert.match(r.reason, /does not return a Result/);
  }
});

test("a target that does not return a Result is held whatever it calls", async () => {
  const boolFn = enumerate("src/util.rs", HELPERS).functions.find((f) => f.name === "baseline_path")!;
  const r = await applicabilityOf(fakeDiscoverer, boolFn, reads[0]!);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "target_not_result");
});

test("unverified and not-applicable count as neither right nor wrong", () => {
  const outcomes: SiteOutcome[] = [
    { kind: "right" },
    { kind: "wrong" },
    { kind: "unverified" },
    { kind: "unverified" },
    { kind: "not_applicable", reason: "bool" },
    { kind: "withheld", reason: "not found in this version" },
  ];
  const s = scoreSet(outcomes, { call: false, functionOnly: true });
  assert.deepEqual(
    { right: s.right, wrong: s.wrong, unverified: s.unverified, notApplicable: s.notApplicable, withheld: s.withheld },
    { right: 1, wrong: 1, unverified: 2, notApplicable: 1, withheld: 1 },
  );
  assert.equal(s.sites, 6, "every site is still in the set — none is dropped to flatter the method");
});

test("dropping hard candidates cannot improve a score, because nothing is dropped", () => {
  const withHard: SiteOutcome[] = [{ kind: "right" }, { kind: "unverified" }, { kind: "not_applicable", reason: "bool" }];
  const trimmed: SiteOutcome[] = [{ kind: "right" }];
  const reach = { call: true, functionOnly: false };
  assert.notEqual(scoreSet(withHard, reach).sites, scoreSet(trimmed, reach).sites);
  assert.equal(scoreSet(withHard, reach).right, scoreSet(trimmed, reach).right);
});

test("a call with an opaque argument is found in the redacted body it is judged in", () => {
  // The body handed to the model has been through redaction; the call expression has not. A long
  // hex argument made the two disagree, and the site was withheld with "this version moved it" —
  // a reason that is about the wrong thing, and says nothing about redaction.
  const opaque = `pub fn load(path: &Path) -> Result<String, AppError> {
    let content = read_capped(path, "0123456789abcdef0123456789abcdef0123456789abcdef")?;
    Ok(content)
}
`;
  const call = enumerate("src/opaque.rs", opaque).calls.find((k) => k.callee === "read_capped")!;
  assert.match(call.expression, /0123456789abcdef/, "the expression is as the file has it");
  const body = redact(opaque).text;
  assert.match(body, /REDACTED LONG STRING/, "the body the model sees is not the file");
  assert.equal(locateCall(body, call).ok, true);
});

test("a signature that wraps is still read as returning a Result", async () => {
  // `fn create_staging_subdir(` on its own line says nothing about the return type. Reading only
  // the definition line held every wrapped signature as "does not return a Result" — a silent
  // refusal to ask that reads like a considered one.
  const WRAPPED = `fn wrapped(
    destination: &Path,
    timestamp: u64,
) -> Result<PathBuf, String> {
    let a = read_capped(destination)?;
    Ok(a)
}
`;
  const w = enumerate("src/wrapped.rs", WRAPPED);
  const fnw = w.functions[0]!;
  assert.match(fnw.signature, /-> Result<PathBuf, String> \{/);
  const call = w.calls.find((k) => k.callee === "read_capped")!;
  const r = await applicabilityOf(fakeDiscoverer, fnw, call);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});
