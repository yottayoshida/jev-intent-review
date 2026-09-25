import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPool, buildSplit } from "../bench/eval/build-pool.ts";
import { checkSplit, saltProblems, sideOf, type Pool, type Split } from "../bench/eval/split.ts";

const pool = JSON.parse(readFileSync(new URL("../bench/eval/pool.json", import.meta.url), "utf8")) as Pool;
const split = JSON.parse(readFileSync(new URL("../bench/eval/split.json", import.meta.url), "utf8")) as Split;
const poolRepos = new Set(pool.rows.map((r) => r.repo));

test("the committed split holds, and pool.json and split.json are what build-pool.ts writes", () => {
  assert.deepEqual(checkSplit(split, poolRepos), []);
  execFileSync(process.execPath, [fileURLToPath(new URL("../bench/eval/build-pool.ts", import.meta.url)), "--check"], { stdio: "pipe" });
});

test("every repository of protocol v1 is dev, and none is sealed", () => {
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
