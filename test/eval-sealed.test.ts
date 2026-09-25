import assert from "node:assert/strict";
import test from "node:test";
import { openSealed, Refused, runSealed, type SealedDeps } from "../bench/eval/run.ts";
import { PROTOCOL_VERSION } from "../bench/eval/split.ts";

/** A world where every condition holds, with a log in memory and a count of the requests sent. */
function world(over: Partial<SealedDeps> = {}) {
  let log = "";
  let main: string | null = "";
  let sent = 0;
  let ids = 0;
  const deps: SealedDeps = {
    now: () => "2026-09-25T00:00:00Z",
    newRunId: () => `run-${++ids}`,
    head: () => "a".repeat(40),
    dirty: () => "",
    manifest: () => "m",
    accessLogOnMain: () => main,
    readAccessLog: () => log,
    appendAccessLog: (line) => void (log += line),
    modelIdentity: () => ({ host: "cloudflare", requested: "jev" }),
    sealedRepos: () => ["x/one", "x/two"],
    build: () => "dist-hash",
    measure: async () => {
      sent += 1;
      return { file: "bench/eval/logs/sealed.json", sha256: "r", answeredBy: [{ host: "cloudflare", returned: [{ model: "jev-1.13.0", responses: 4 }] }] };
    },
    ...over,
  };
  return {
    deps,
    /** What merging the branch to main does: main's copy becomes the branch's. */
    merge: () => void (main = log),
    get log() {
      return log;
    },
    get sent() {
      return sent;
    },
  };
}

const refuses = async (f: () => unknown, pattern: RegExp) => assert.rejects(async () => f(), (e: unknown) => e instanceof Refused && pattern.test((e as Error).message));

test("open refuses with no reason, no sealed case, no host, or a dirty tree, and appends nothing", async () => {
  for (const [w, reason, why] of [
    [world(), "  ", /needs a reason/],
    [world({ modelIdentity: () => null }), "release 0.2.0", /sends judgments nowhere/],
    [world({ dirty: () => " M bench/eval/split.json\n" }), "release 0.2.0", /not clean/],
    [world({ sealedRepos: () => [] }), "release 0.2.0", /no case yet/],
  ] as const) {
    await refuses(() => openSealed(w.deps, reason), why);
    assert.equal(w.log, "");
    assert.equal(w.sent, 0);
  }
});

test("run refuses until the open line is on main, with a dirty tree, or with another model; nothing is sent", async () => {
  const w = world();
  const line = openSealed(w.deps, "release 0.2.0");
  // Opened on the branch, not merged.
  await refuses(() => runSealed(w.deps, line.runId), /not opened on origin\/main/);
  w.merge();
  const dirty = world({ ...w.deps, dirty: () => " M src/cli/main.ts\n" });
  await refuses(() => runSealed(dirty.deps, line.runId), /not clean/);
  const other = world({ ...w.deps, modelIdentity: () => ({ host: "typesafe", requested: "jev" }) });
  await refuses(() => runSealed(other.deps, line.runId), /does not ask the host and model/);
  const moved = world({ ...w.deps, manifest: () => "another split" });
  await refuses(() => runSealed(moved.deps, line.runId), /not what the run was opened with/);
  await refuses(() => runSealed(w.deps, "run-unknown"), /not opened/);
  assert.equal(w.sent + dirty.sent + other.sent + moved.sent, 0);
});

test("with everything in place the requests are sent, a result line follows, and a run cannot run twice", async () => {
  const w = world();
  const line = openSealed(w.deps, "release 0.2.0");
  w.merge();
  const result = await runSealed(w.deps, line.runId);
  assert.equal(w.sent, 1);
  assert.equal(result.dist, "dist-hash");
  assert.equal(result.head, "a".repeat(40));
  assert.deepEqual(result.answeredBy, [{ host: "cloudflare", returned: [{ model: "jev-1.13.0", responses: 4 }] }]);
  assert.deepEqual(
    w.log.trim().split("\n").map((l) => JSON.parse(l).kind),
    ["open", "result"],
  );
  await refuses(() => runSealed(w.deps, line.runId), /has run already/);
  assert.equal(w.sent, 1);
});

test("each repository's count goes up with every opening, across versions of the protocol", async () => {
  const w = world();
  assert.deepEqual(openSealed(w.deps, "first").opened, { "x/one": 1, "x/two": 1 });
  assert.deepEqual(openSealed(w.deps, "second").opened, { "x/one": 2, "x/two": 2 });
  // A later version of the protocol (a line written by it) does not start the count again.
  const bumped = w.log.replaceAll(`"protocolVersion":${PROTOCOL_VERSION}`, `"protocolVersion":${PROTOCOL_VERSION + 1}`);
  assert.notEqual(bumped, w.log, "the lines must carry the version the test raises");
  const later = world({ readAccessLog: () => bumped, sealedRepos: () => ["x/one", "x/three"] });
  assert.deepEqual(openSealed(later.deps, "third").opened, { "x/one": 3, "x/three": 1 });
});

test("a run that has a result on main cannot run again from a tree that has no copy of it", async () => {
  const w = world();
  const line = openSealed(w.deps, "release 0.2.0");
  w.merge();
  await runSealed(w.deps, line.runId);
  w.merge();
  // A fresh clone of main: the same open line, and no local file of its own beyond main's.
  const fresh = world({ ...w.deps, readAccessLog: () => "", appendAccessLog: () => undefined });
  await refuses(() => runSealed(fresh.deps, line.runId), /has run already/);
  assert.equal(w.sent + fresh.sent, 1);
});

test("openings are counted over main's lines too, so a branch behind main does not count low", () => {
  const w = world();
  openSealed(w.deps, "on another branch");
  w.merge();
  // This branch has none of main's lines.
  const behind = world({ accessLogOnMain: w.deps.accessLogOnMain, readAccessLog: () => "" });
  assert.deepEqual(openSealed(behind.deps, "here").opened, { "x/one": 2, "x/two": 2 });
});
