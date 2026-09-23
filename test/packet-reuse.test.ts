import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparePair, expectedReused, judgmentsOf, median, samePackets, sharesOf, withoutLineNumbers, type Judgment } from "../bench/packet-reuse.ts";

const judgment = (exact: string, loose: string, side: Judgment["side"] = "calls"): Judgment => ({ exact, loose, side });

test("a judgment is counted once, in the first bucket it falls into", () => {
  const before = [judgment("a", "A"), judgment("b", "B")];
  // Identical to `a`; a packet whose line numbers moved off `b`; and one that is neither.
  const after = [judgment("a", "A"), judgment("b2", "B"), judgment("c", "C")];
  const count = comparePair(before, after);

  assert.equal(count.sent, 3);
  assert.equal(count.identical, 1);
  assert.equal(count.onlyLinesMoved, 1);
  assert.equal(count.new, 1);
});

test("a packet whose bytes match is not also counted as one whose lines moved", () => {
  // Both keys match: without the order of the branches this would be counted in both.
  const count = comparePair([judgment("a", "A")], [judgment("a", "A")]);
  assert.equal(count.identical, 1);
  assert.equal(count.onlyLinesMoved, 0);
  assert.equal(count.new, 0);
});

test("what the earlier push asked and the later one did not is counted from the earlier side", () => {
  const before = [judgment("a", "A"), judgment("gone", "GONE")];
  const after = [judgment("a", "A")];
  assert.equal(comparePair(before, after).goneFromBefore, 1);
});

test("one side is counted without the other", () => {
  const before = [judgment("a", "A", "calls"), judgment("c", "C", "changes")];
  const after = [judgment("a", "A", "calls"), judgment("d", "D", "changes")];

  assert.deepEqual(
    { ...comparePair(before, after, "calls") },
    { sent: 1, identical: 1, onlyLinesMoved: 0, new: 0, goneFromBefore: 0 },
  );
  assert.deepEqual(
    { ...comparePair(before, after, "changes") },
    { sent: 1, identical: 0, onlyLinesMoved: 0, new: 1, goneFromBefore: 1 },
  );
});

test("blanking the line numbers leaves everything else in the packet alone", () => {
  const packet = {
    requirement: { id: "R1", text: "a requirement" },
    candidate: { path: "src/a.rs", lines: "10-20", symbol: "f" },
    evidence: { code: "fn f() {}", related: [{ path: "src/b.rs", lines: "3-4", code: "g()" }] },
  };
  const blanked = withoutLineNumbers(packet) as typeof packet;

  assert.equal(blanked.candidate.lines, "");
  assert.equal(blanked.evidence.related[0]?.lines, "");
  assert.equal(blanked.candidate.path, "src/a.rs", "the path is untouched");
  assert.equal(blanked.evidence.code, "fn f() {}", "the code is untouched");
  assert.equal(blanked.requirement.id, "R1", "the requirement's id is untouched — it is what a moved requirement changes");
  // The same packet at different line numbers is one packet; a different requirement is not.
  const moved = { ...packet, candidate: { ...packet.candidate, lines: "40-50" } };
  assert.deepEqual(withoutLineNumbers(moved), blanked);
  const other = { ...packet, requirement: { id: "R2", text: "a requirement" } };
  assert.notDeepEqual(withoutLineNumbers(other), blanked);
});

test("a pair one of whose runs did not finish is not a share of 0", () => {
  // The earlier run died, so it left no trace and the later head's packets all look new.
  const died = { ran: false, all: { sent: 61, identical: 0, onlyLinesMoved: 0 } };
  const finished = { ran: true, all: { sent: 61, identical: 59, onlyLinesMoved: 1 } };
  assert.deepEqual(sharesOf([died, finished], false), [59 / 61]);
  assert.deepEqual(sharesOf([died, finished], true), [60 / 61]);
  // A later head that sent nothing has no share either.
  assert.deepEqual(sharesOf([{ ran: true, all: { sent: 0, identical: 0, onlyLinesMoved: 0 } }], false), []);
});

test("the median of an even number of shares is the middle pair's average, and of none is nothing", () => {
  assert.equal(median([]), null);
  assert.equal(median([0.5]), 0.5);
  assert.equal(median([0.2, 0.4, 0.6]), 0.4);
  assert.equal(median([0.2, 0.4, 0.6, 0.8]), 0.5);
  assert.equal(median([0.8, 0.2, 0.6, 0.4]), 0.5, "the input is not assumed to be sorted");
});

test("a trace line is on the change side only when its state holds a change", () => {
  const dir = mkdtempSync(join(tmpdir(), "packet-reuse-"));
  const path = join(dir, "trace.jsonl");
  const line = (state: unknown) => JSON.stringify({ request: { state, questions: { q: 1 } } });
  writeFileSync(path, `${line({ requirement: "R1", candidate: { lines: "1-2" } })}\n${line({ requirements: [], change: { lines: "3-4" } })}\n`);
  assert.deepEqual(judgmentsOf(path).map((j) => j.side), ["calls", "changes"]);
  assert.deepEqual(judgmentsOf(join(dir, "none.jsonl")), [], "a run that left no trace has no judgments — which is why `ran` exists");
});

test("the stand-in and the real run agree when they sent the same packets, whatever the order", () => {
  // The change questions go out together, so the trace's order follows which answer came back first.
  assert.deepEqual(samePackets(["a", "b", "b"], ["b", "a", "b"]), { samePackets: true, sameOrder: false });
  assert.deepEqual(samePackets(["a", "b"], ["a", "b"]), { samePackets: true, sameOrder: true });
  assert.equal(samePackets(["a", "b", "b"], ["a", "a", "b"]).samePackets, false, "each packet as often, not just the same set");
  assert.equal(samePackets(["a"], ["a", "b"]).samePackets, false, "a shorter run is not a match");
});

test("what kept answers should cover: anything an earlier push sent, and every repeat within this one", () => {
  // `a` was sent before; `b` is new and sent twice; `c` is new once.
  assert.equal(expectedReused(new Set(["a"]), ["a", "b", "b", "c"]), 2);
  // Nothing earlier and nothing repeated: nothing to reuse.
  assert.equal(expectedReused(new Set(), ["a", "b"]), 0);
  // A packet sent earlier and repeated now counts each time it is sent.
  assert.equal(expectedReused(new Set(["a"]), ["a", "a"]), 2);
});
