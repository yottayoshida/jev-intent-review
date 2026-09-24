// Inside a changed function, a `check_before_action` call whose own name is the operation the
// requirement names takes the budget's turns before one that meets its words only through a
// receiver or the rest of its path (#39, ADR 0016). The failure form marks no call named, and its
// order is the one it was.

import assert from "node:assert/strict";
import { test } from "node:test";
import { enumerate } from "../src/plan/candidates.ts";
import { FORMS } from "../src/plan/forms.ts";
import { callsIntoChangedFirst, roundRobin, type Askability, type Site } from "../src/plan/select.ts";
import type { Requirement } from "../src/types.ts";

// The shape of moltis#1064's function, with other names: calls met through a receiver (`title_store`),
// through the rest of a path (`titles::`), and the one named (`generate_title`), last in line order.
const SOURCE = `pub async fn make_title(state: &State) -> Result<Option<String>> {
    let store = state.title_store.as_ref();
    let history = state.title_store.read(key)?;
    let other = titles::helpers::lookup(key)?;
    let text = agents::title::generate_title(provider, &history)?;
    Ok(Some(text))
}
`;
const requirement: Requirement = { id: "R1", text: "A title must not be generated for a session that has fewer messages than the minimum.", kind: "behavior", priority: "required", sourceRefs: [], searchHints: [], form: "check_before_action" };
const listing = enumerate("src/title.rs", SOURCE);
const fn = listing.functions[0]!;

async function sites(): Promise<Site[]> {
  const out: Site[] = [];
  for (const call of listing.calls.filter((c) => c.functionId === fn.id)) {
    const applicability = await FORMS.check_before_action.askable({ requirement, fn, call, resultOf: async () => ({ ok: true }), readHere: async () => null });
    if (applicability.ok) out.push({ call, fn, origin: "changed", fnOrigin: "changed", applicability });
  }
  return out;
}
const callees = (list: readonly Site[]) => list.map((s) => s.call.callee);

test("a call named by the requirement takes a turn before calls met only through a receiver or the rest of a path", async () => {
  const all = await sites();
  // All four are askable: each meets "title" somewhere.
  assert.deepEqual(callees(all), ["as_ref", "read", "titles::helpers::lookup", "agents::title::generate_title"]);
  assert.deepEqual(
    all.map((s) => (s.applicability as Extract<Askability, { ok: true }>).names),
    [false, false, false, true],
  );
  const ordered = callsIntoChangedFirst(all, new Set());
  assert.equal(ordered[0]!.call.callee, "agents::title::generate_title");
  // The rest keep their line order.
  assert.deepEqual(callees(ordered.slice(1)), ["as_ref", "read", "titles::helpers::lookup"]);
  // With one turn for the function, the named call is the one asked.
  assert.deepEqual(callees(roundRobin(ordered, 1).taken), ["agents::title::generate_title"]);
});

test("a call not marked named — the failure form marks none — keeps the order it had", async () => {
  const unmarked = (await sites()).map((s) => ({ ...s, applicability: { ok: true } as Askability }));
  assert.deepEqual(callees(callsIntoChangedFirst(unmarked, new Set())), ["as_ref", "read", "titles::helpers::lookup", "agents::title::generate_title"]);
  // `names: false` reads the same as absent.
  const markedFalse = (await sites()).map((s) => ({ ...s, applicability: { ok: true, names: false } as Askability }));
  assert.deepEqual(callees(callsIntoChangedFirst(markedFalse, new Set())), callees(callsIntoChangedFirst(unmarked, new Set())));
  // The failure form's askable is `resultOf` itself, which marks no name.
  const failure = await FORMS.failure_propagation.askable({ requirement: { ...requirement, form: "failure_propagation" }, fn, call: listing.calls[0]!, resultOf: async () => ({ ok: true }), readHere: async () => null });
  assert.equal((failure as { names?: boolean }).names, undefined);
});
