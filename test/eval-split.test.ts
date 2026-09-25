import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPool, buildSplit } from "../bench/eval/build-pool.ts";
import { batchesOnlyGrow, batchRecordProblems, batchSaltProblems, checkSplit, saltProblems, sideOf, type Pool, type SealedBatch, type SealedBatches, type Split } from "../bench/eval/split.ts";

const pool = JSON.parse(readFileSync(new URL("../bench/eval/pool.json", import.meta.url), "utf8")) as Pool;
const split = JSON.parse(readFileSync(new URL("../bench/eval/split.json", import.meta.url), "utf8")) as Split;
const poolRepos = new Set(pool.rows.map((r) => r.repo));

test("the committed split holds, and pool.json and split.json are what build-pool.ts writes", () => {
  assert.deepEqual(checkSplit(split, poolRepos), []);
  execFileSync(process.execPath, [fileURLToPath(new URL("../bench/eval/build-pool.ts", import.meta.url)), "--check"], { stdio: "pipe" });
});

test("every repository in the pool before any sealed case is dev, and none is sealed", () => {
  assert.equal(split.repos.filter((r) => r.side === "sealed").length, 0);
  for (const r of ["yottayoshida/omamori", "yottayoshida/sideeye", "moltis-org/moltis", "dashpay/grovedb", "kontorprotocol/kontor", "oxidezap/whatsapp-rust", "naoray/instruckt-tauri", "void-technology-inc/pybun", "ratazzi/quebec", "burntsushi/ripgrep"]) {
    assert.equal(split.repos.find((e) => e.repo === r)?.side, "dev", r);
  }
});

// Every real repository is fixed to dev, so the hash is checked on made-up ones: without them, a check
// that never recomputed the hash would pass.
const SALT = "0123456789abcdef0123456789abcdef01234567";
const made = Array.from({ length: 12 }, (_, i) => `example/made-up-${i}`);

test("repositories placed by the hash are where the hash puts them, and moving one is caught", () => {
  const hashed: Split = { ...split, repos: [...split.repos, ...made.map((repo) => ({ repo, side: sideOf(repo, SALT), fixed: false, why: ["test"], salt: SALT }))] };
  assert.deepEqual(checkSplit(hashed, poolRepos), []);
  // Both sides occur among the made-up ones, so each mutation below has something to flip.
  assert.ok(new Set(hashed.repos.slice(-12).map((r) => r.side)).size === 2);
  const flipped = structuredClone(hashed);
  const last = flipped.repos.at(-1)!;
  last.side = last.side === "sealed" ? "dev" : "sealed";
  assert.match(checkSplit(flipped, poolRepos).join("\n"), /the rule puts it on/);
  // A contaminated repository is dev whatever the hash says.
  const moved = structuredClone(hashed);
  const s = moved.repos.find((r) => r.salt && r.side === "sealed")!;
  s.side = "dev";
  s.contaminated = { on: "2026-09-25", why: "read to choose a budget" };
  assert.deepEqual(checkSplit(moved, poolRepos), []);
});

test("a fixed repository written as sealed, one written twice, or one missing is caught", () => {
  const sealedFixed = structuredClone(split);
  sealedFixed.repos.find((r) => r.repo === "moltis-org/moltis")!.side = "sealed";
  assert.match(checkSplit(sealedFixed, poolRepos).join("\n"), /fixed entries are dev/);
  const twice = structuredClone(split);
  twice.repos.push({ ...twice.repos[0]!, repo: twice.repos[0]!.repo.toUpperCase() });
  assert.match(checkSplit(twice, poolRepos).join("\n"), /on the split 2 times/);
  const missing = structuredClone(split);
  missing.repos = missing.repos.filter((r) => r.repo !== "dashpay/grovedb");
  assert.match(checkSplit(missing, poolRepos).join("\n"), /dashpay\/grovedb: in the pool and not on the split/);
});

test("the sealed access log on this branch only adds lines to the one on origin/main", (t) => {
  let onMain: string;
  try {
    git("rev-parse", "--verify", "--quiet", "origin/main");
  } catch {
    return t.skip("no origin/main in this clone");
  }
  try {
    onMain = git("show", "origin/main:bench/eval/sealed-access.jsonl");
  } catch {
    return t.skip("origin/main has no sealed access log yet");
  }
  const here = readFileSync(new URL("../bench/eval/sealed-access.jsonl", import.meta.url), "utf8");
  assert.ok(here.startsWith(onMain), "bench/eval/sealed-access.jsonl changed or removed a line origin/main has; it may only grow");
});

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("a salt must be a merge commit on main's first-parent line", (t) => {
  let merges: Set<string>;
  try {
    merges = new Set(git("rev-list", "--first-parent", "--merges", "origin/main").split("\n").filter(Boolean));
  } catch {
    return t.skip("no origin/main in this clone");
  }
  // f8613f7 merged pull request #79; 02b9d5a is that pull request's last commit, not a merge.
  const merge = "f8613f7ee64369cdcb1edf12777b3de5544a970f";
  const plain = "02b9d5a8d28d81386487c18c0ebcdfb841ad790a";
  if (!merges.has(merge)) return t.skip("origin/main does not reach f8613f7 here");
  const entry = (repo: string, salt: string) => ({ repo, side: sideOf(repo, salt), fixed: false, why: ["test"], salt });
  const withSalts: Split = { ...split, repos: [entry("example/merged", merge), entry("example/plain", plain), entry("example/made-up", "not-a-commit")] };
  assert.deepEqual(
    saltProblems(withSalts, (sha) => merges.has(sha)).map((p) => p.split(":")[0]),
    ["example/plain", "example/made-up"],
  );
  assert.deepEqual(saltProblems(split, (sha) => merges.has(sha)), []);
});

test("rebuilding the split keeps what the hash placed, and refuses a repository that is both", () => {
  const pool = buildPool();
  const salt = "0123456789abcdef0123456789abcdef01234567";
  const placed = { repo: "example/second-batch", side: sideOf("example/second-batch", salt), fixed: false, why: ["search-v1.json order 1"], salt };
  const rebuilt = buildSplit(pool, { ...split, repos: [...split.repos, placed] });
  assert.deepEqual(rebuilt.repos.find((r) => r.repo === "example/second-batch"), placed);
  assert.equal(rebuilt.repos.length, split.repos.length + 1);
  assert.throws(() => buildSplit(pool, { ...split, repos: [...split.repos, { ...placed, repo: "moltis-org/moltis" }] }), /both|already in the pool/);
});

const batchesFile = JSON.parse(readFileSync(new URL("../bench/eval/sealed-batches.json", import.meta.url), "utf8")) as SealedBatches;

test("a salt is the first main merge commit holding its batch's sha256, found by the hash", () => {
  const batch: SealedBatch = { measurement: "#80", id: "b1", from: 1, to: 100, rows: 100, kept: 8, sha256: "a".repeat(64) };
  const first = "f".repeat(40);
  const later = "e".repeat(40);
  const firstMergeWith = (sha: string) => (sha === batch.sha256 ? { commit: first, merge: true } : null);
  // example/new and example/second have a row in 1..100; example/later only at row 150.
  const rowsOf = (_m: string, repo: string) => ({ "example/new": [7], "example/second": [30], "example/later": [150] } as Record<string, number[]>)[repo] ?? [];
  const entry = (salt: string, over: Partial<Split["repos"][number]> = {}) => ({ repo: "example/new", side: sideOf("example/new", salt), fixed: false, why: ["test"], salt, batch: { measurement: "#80" as const, id: "b1" }, ...over });
  const at = (e: Split["repos"][number], b = [batch]) => batchSaltProblems({ ...split, repos: [...split.repos, e] }, b, firstMergeWith, rowsOf);
  assert.deepEqual(at(entry(first)), []);
  // A later merge commit that also holds the hash is not the salt.
  assert.match(at(entry(later)).join(), /is not f+, the first main merge commit/);
  // Swapping the verdicts changes the sha256; main never held the new one, whatever the id says.
  assert.match(at(entry(first), [{ ...batch, sha256: "b".repeat(64) }]).join(), /main has never held/);
  assert.match(at(entry(first, { batch: undefined })).join(), /names no batch/);
  assert.match(at(entry(first, { batch: { measurement: "#89", id: "b1" } })).join(), /not in sealed-batches.json/);
  // A batch that reached main by a squash or a direct push has no salt, and says so.
  assert.match(batchSaltProblems({ ...split, repos: [...split.repos, entry(first)] }, [batch], () => ({ commit: first, merge: false }), rowsOf).join(), /not a merge commit/);
  // A repository whose only row is in a later batch cannot be hung on this one, whatever `kept` allows.
  assert.match(at(entry(first, { repo: "example/later", side: sideOf("example/later", first) })).join(), /no batch of #80 read a row of it/);
  // With both batches merged, a repository first read in b1 cannot take b2's salt.
  const b2: SealedBatch = { ...batch, id: "b2", from: 101, to: 200, sha256: "c".repeat(64) };
  const both = (sha: string) => (sha === batch.sha256 ? { commit: first, merge: true } : sha === b2.sha256 ? { commit: later, merge: true } : null);
  const moved = entry(later, { batch: { measurement: "#80", id: "b2" } });
  assert.match(batchSaltProblems({ ...split, repos: [...split.repos, moved] }, [batch, b2], both, rowsOf).join(), /names batch #80 b2, but b1 read its first row/);
  // More repositories naming a batch than it kept.
  const two = [entry(first), entry(first, { repo: "example/second", side: sideOf("example/second", first) })];
  assert.match(batchSaltProblems({ ...split, repos: [...split.repos, ...two] }, [{ ...batch, kept: 1 }], firstMergeWith, rowsOf).join(), /kept 1 and 2 repositories name it/);
});

test("batches are only added: an earlier line changed or removed is caught", () => {
  const a: SealedBatch = { measurement: "#80", id: "b1", from: 1, to: 100, rows: 100, kept: 8, sha256: "a".repeat(64) };
  const b: SealedBatch = { measurement: "#89", id: "r1", from: 1, to: 50, rows: 50, kept: 2, sha256: "c".repeat(64) };
  assert.ok(batchesOnlyGrow([a], [a, b]));
  assert.equal(batchesOnlyGrow([a], [{ ...a, sha256: "d".repeat(64) }, b]), false);
  assert.equal(batchesOnlyGrow([a, b], [a]), false);
});

test("the batches on this branch only add to the ones on origin/main", (t) => {
  let onMain: SealedBatches;
  try {
    onMain = JSON.parse(execFileSync("git", ["show", "origin/main:bench/eval/sealed-batches.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as SealedBatches;
  } catch {
    return t.skip("origin/main has no sealed-batches.json yet");
  }
  assert.ok(batchesOnlyGrow(onMain.batches, batchesFile.batches), "bench/eval/sealed-batches.json changed a line origin/main has; it may only grow");
});

/**
 * The first main merge commit whose sealed-batches.json holds `sha256`, asked of git: `-S` finds the
 * commits that changed how often the string occurs, `--first-parent` keeps main's own line (a merge
 * commit's change is against its first parent), and the first of them is where it arrived.
 */
function firstMergeWith(sha256: string): { commit: string; merge: boolean } | null {
  const out = execFileSync("git", ["log", "--first-parent", "--reverse", "--format=%H %P", `-S${sha256}`, "origin/main", "--", "bench/eval/sealed-batches.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const first = out.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) return null;
  const [commit, ...parents] = first.trim().split(" ");
  // Only a merge commit is a salt: a squash or a direct push to main is not (PROTOCOL.md rule 5).
  return { commit: commit!, merge: parents.length === 2 };
}

test("every committed salt is the first main merge commit holding its batch's sha256, asked of git", (t) => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], { stdio: "ignore" });
  } catch {
    return t.skip("no origin/main in this clone");
  }
  // Rows by repository, from each measurement's committed searches.
  const read = (p: string) => (JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { rows: { order: number; repo: string }[] }).rows;
  const index = { "#80": [...read("../bench/eval/search-v1.json"), ...read("../bench/eval/search-v2.json")], "#89": read("../bench/eval/retro/search-v1.json") };
  const rowsOfReal = (m: "#80" | "#89", repo: string) => index[m].filter((r) => r.repo.toLowerCase() === repo).map((r) => r.order);
  assert.deepEqual(batchSaltProblems(split, batchesFile.batches, firstMergeWith, rowsOfReal), []);
});

test("batch records: consecutive ranges from row 1, rows equal to the range, kept within rows, one line each", () => {
  const b = (over: Partial<SealedBatch>): SealedBatch => ({ measurement: "#80", id: "b1", from: 1, to: 100, rows: 100, kept: 8, sha256: "a".repeat(64), ...over });
  assert.deepEqual(batchRecordProblems([b({}), b({ id: "b2", from: 101, to: 150, rows: 50 }), b({ measurement: "#89", id: "r1", from: 1, to: 10, rows: 10 })]), []);
  // The same rows read again in a later batch — the way to draw a side twice.
  assert.match(batchRecordProblems([b({}), b({ id: "b2", from: 51, to: 150 })]).join(), /starts at row 51/);
  assert.match(batchRecordProblems([b({}), b({ id: "b2", from: 102, to: 151, rows: 50 })]).join(), /starts at row 102/);
  assert.match(batchRecordProblems([b({ rows: 99 })]).join(), /rows 99 but read 1..100/);
  assert.match(batchRecordProblems([b({ kept: 101 })]).join(), /kept 101 of 100/);
  assert.match(batchRecordProblems([b({}), b({ from: 101, to: 200 })]).join(), /written twice/);
  assert.match(batchRecordProblems([b({ sha256: "xyz" })]).join(), /64 hex/);
  assert.deepEqual(batchRecordProblems(batchesFile.batches), []);
});

test("#89's search leaves out the repositories of both of #80's searches", async () => {
  const { searchOf80 } = await import("../bench/eval/retro/search.ts");
  const evalDir = fileURLToPath(new URL("../bench/eval/", import.meta.url));
  const of80 = searchOf80(evalDir);
  const v1 = JSON.parse(readFileSync(new URL("../bench/eval/search-v1.json", import.meta.url), "utf8")) as { rows: { repo: string }[] };
  const v2 = JSON.parse(readFileSync(new URL("../bench/eval/search-v2.json", import.meta.url), "utf8")) as { rows: { repo: string }[] };
  for (const r of [...v1.rows.slice(0, 3), ...v2.rows.slice(0, 3), v2.rows.at(-1)!]) assert.ok(of80.has(r.repo.toLowerCase()), r.repo);
  assert.equal(of80.size, new Set([...v1.rows, ...v2.rows].map((r) => r.repo.toLowerCase())).size);
});

test("search-v2's rows: newest first after search-v1's, one per reference with every phrase, known repositories left out and counted", async () => {
  const { rowsOf } = await import("../bench/eval/search-v2.ts");
  const hit = (repo: string, n: number, closedAt: string) => ({ number: n, title: "t", repository: { nameWithOwner: repo }, url: "", closedAt });
  const hits = new Map([
    ["swallow error", [hit("A/one", 1, "2026-03-01T00:00:00Z"), hit("b/split", 2, "2026-03-02T00:00:00Z"), hit("c/v1", 3, "2026-03-03T00:00:00Z")]],
    ["ignored error", [hit("A/one", 1, "2026-03-01T00:00:00Z"), hit("d/retro", 4, "2026-03-04T00:00:00Z"), hit("e/two", 5, "2026-05-01T00:00:00Z"), hit("f/late", 6, "2026-07-02T00:00:00Z")]],
  ]);
  const { rows, left } = rowsOf(hits, { split: new Set(["b/split"]), v1: new Set(["c/v1"]), retro: new Set(["d/retro"]) }, 305);
  assert.deepEqual(rows.map((r) => [r.order, r.ref, r.queries]), [[306, "e/two#5", ["ignored error"]], [307, "A/one#1", ["swallow error", "ignored error"]]]);
  assert.equal(rows[1]!.repo, "a/one");
  assert.deepEqual(left, { onSplit: 1, inSearchV1: 1, inRetroSearch: 1, outsideRange: 1 });
});
