// Within a function, which call the budget reaches first: the calls into a function the change
// touched, then the rest in line order. No model, no network, no repository beyond two strings.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import { enumerate, type CallCandidate, type FunctionCandidate } from "../src/plan/candidates.ts";
import { applicabilityOf, type Applicability } from "../src/plan/applicability.ts";
import { resolvedTo, roundRobin, selectSites, type SiteSource } from "../src/plan/select.ts";
import type { Discoverer } from "../src/discovery/discover.ts";
import { FORMS } from "../src/plan/forms.ts";
import type { Requirement } from "../src/types.ts";

// `changed_one` and `changed_two` hold changed lines; `caller` calls `changed_one`; `plain` holds a
// changed line and calls nothing the change touched.
const A = `pub fn changed_one() -> Result<(), E> {
    let x = outside_first()?;
    let y = changed_two()?;
    Ok(())
}

pub fn changed_two() -> Result<(), E> {
    let z = outside_first()?;
    Ok(())
}

pub fn caller() -> Result<(), E> {
    outside_second()?;
    changed_one()?;
    Ok(())
}

pub fn plain() -> Result<(), E> {
    outside_first()?;
    outside_second()?;
    Ok(())
}

pub fn outer() -> Result<(), E> {
    outside_first()?;
    caller()?;
    Ok(())
}
`;

const B = `pub fn outside_first() -> Result<(), E> {
    Ok(())
}

pub fn outside_second() -> Result<(), E> {
    Ok(())
}
`;

const candidates = enumerate("src/a.rs", A);
const fnNamed = (name: string) => candidates.functions.find((f) => f.name === name)!;
const at = (name: string) => {
  const fn = fnNamed(name) ?? enumerate("src/b.rs", B).functions.find((f) => f.name === name)!;
  return `${fn.path}:${fn.startLine}`;
};
const source = (changed: string[], callsChanged: string[]): SiteSource => ({
  candidates,
  changed: changed.map((n) => fnNamed(n).id),
  callsChanged: callsChanged.map((n) => fnNamed(n).id),
});

/** Every call askable, each pointing at where its callee is defined — unless `override` says otherwise. */
const decideAll =
  (override: Record<string, Applicability> = {}) =>
  async (_fn: FunctionCandidate, call: CallCandidate): Promise<Applicability> =>
    override[call.expression] ?? { ok: true, calleeDefinedAt: at(call.callee) };

const firstIn = (budgeted: { fn: FunctionCandidate; call: CallCandidate }[], fnName: string) => budgeted.find((s) => s.fn.name === fnName)?.call.expression;

test("in a changed function, the call into a changed function is asked before an earlier line", async () => {
  // One call per function fits: which call a function gets is its first in the order.
  const sel = await selectSites([source(["changed_one", "changed_two", "plain"], ["caller"])], decideAll(), 4);
  assert.equal(firstIn(sel.budgeted, "changed_one"), "changed_two()", "line 3 calls a changed function; line 2 does not");
});

test("in a caller one hop out, the call into the changed function goes first too", async () => {
  const sel = await selectSites([source(["changed_one", "changed_two", "plain"], ["caller"])], decideAll(), 4);
  assert.equal(firstIn(sel.budgeted, "caller"), "changed_one()");
});

test("a function that calls nothing the change touched keeps its line order", async () => {
  const sel = await selectSites([source(["changed_one", "changed_two", "plain"], ["caller"])], decideAll(), 4);
  assert.equal(firstIn(sel.budgeted, "plain"), "outside_first()");
});

test("a callee with a changed function's name but defined elsewhere is not moved up", async () => {
  // The name matches `changed_two`; where it resolves to does not. The order goes by the place.
  const elsewhere: Applicability = { ok: true, calleeDefinedAt: "src/other.rs:1" };
  const sel = await selectSites([source(["changed_one", "changed_two", "plain"], ["caller"])], decideAll({ "changed_two()": elsewhere }), 4);
  assert.equal(firstIn(sel.budgeted, "changed_one"), "outside_first()");
});

test("a call into a caller one hop out is not a call into a changed function", async () => {
  // `caller` is in the set because it calls a changed function; it is not changed itself, so a
  // changed function's call to it keeps its place.
  const sel = await selectSites([source(["changed_one", "changed_two", "plain", "outer"], ["caller"])], decideAll(), 5);
  assert.equal(firstIn(sel.budgeted, "outer"), "outside_first()");
  assert.equal(firstIn(sel.budgeted, "changed_one"), "changed_two()", "the order still moves a call into a changed function");
});

test("the order of functions and how many calls each gets are what they were", async () => {
  const sources = [source(["changed_one", "changed_two", "plain"], ["caller"])];
  for (const budget of [1, 2, 3, 4, 5, 6, 20]) {
    const sel = await selectSites(sources, decideAll(), budget);
    const lineOrder = roundRobin(sel.applicable, budget).taken;
    const count = (list: { fn: FunctionCandidate }[]) => list.map((s) => s.fn.name);
    const tally = (names: string[]) => names.reduce<Record<string, number>>((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {});
    assert.deepEqual(tally(count(sel.budgeted)), tally(count(lineOrder)), `budget ${budget}`);
    assert.deepEqual(
      [...new Set(count(sel.budgeted))],
      [...new Set(count(lineOrder))],
      `budget ${budget}: functions take their turns in the same order`,
    );
  }
});

test("held calls keep the order they were found in; only the budget's side moves", async () => {
  const held: Applicability = { ok: false, kind: "callee_unresolved", reason: "no definition" };
  const sel = await selectSites(
    [source(["changed_one", "changed_two", "plain"], ["caller"])],
    decideAll({ "outside_second()": held, "changed_two()": { ok: true, calleeDefinedAt: at("changed_two") } }),
    4,
  );
  const inWidened = sel.widened.filter((s) => s.call.expression === "outside_second()").map((s) => s.call.id);
  assert.deepEqual(
    sel.held.map((s) => s.call.id),
    inWidened,
  );
  assert.deepEqual(sel.applicable.map((s) => s.call.id), sel.widened.filter((s) => s.call.expression !== "outside_second()").map((s) => s.call.id), "applicable stays in the order the calls were found");
});

// The two readings the order compares are separate code: `definitionsOf` finds the callee's line
// by grep, and `enumerate` finds a function's first line on its own. If they ever point at
// different lines, the order silently stops moving anything — so this goes through both.
const FILES: Record<string, string> = { "src/a.rs": A, "src/b.rs": B };
const discoverer = {
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

test("a real callee resolution points at the changed function's own first line", async () => {
  const sel = await selectSites([source(["changed_one", "changed_two"], [])], (fn, call) => applicabilityOf(discoverer, fn, call), 2);
  const intoChanged = sel.applicable.find((s) => s.call.expression === "changed_two()")!;
  assert.equal(resolvedTo(intoChanged.applicability), `src/a.rs:${fnNamed("changed_two").startLine}`);
  assert.equal(firstIn(sel.budgeted, "changed_one"), "changed_two()");
});

// The CLI does not hand `applicabilityOf` to the selection; it hands the requirement's form. If the
// form stopped passing the resolved callee on, the order would stop and every test above would
// still pass — so this goes through the form the CLI uses.
test("through the failure form the CLI uses, the order still moves the call", async () => {
  const requirement: Requirement = { id: "R1", text: "A failure must reach the caller.", kind: "behavior", priority: "required", sourceRefs: [], searchHints: [] };
  const form = FORMS.failure_propagation;
  const decide = (fn: FunctionCandidate, call: CallCandidate) => form.askable({ requirement, fn, call, resultOf: (f, c) => applicabilityOf(discoverer, f, c), readHere: async () => null });
  const sel = await selectSites([source(["changed_one", "changed_two"], [])], decide, 2);
  assert.equal(firstIn(sel.budgeted, "changed_one"), "changed_two()");
});

test("a form that resolves no callee keeps line order", async () => {
  // `check_before_action` answers `{ ok: true }` with no place: there is nothing to move by.
  const sel = await selectSites([source(["changed_one", "changed_two", "plain"], ["caller"])], async () => ({ ok: true }), 4);
  assert.equal(firstIn(sel.budgeted, "changed_one"), "outside_first()");
  assert.equal(firstIn(sel.budgeted, "caller"), "outside_second()");
});
