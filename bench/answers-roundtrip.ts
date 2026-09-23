// The answers kept for a pull request, carried from one CI job to the next through the Actions cache
// (ADR 0013). A fixed case is built in a throwaway repository — not the pull request's checkout,
// whose changes differ from one pull request to the next — and run against a stand-in on
// localhost, so nothing is billed and no key is needed.
//
//   node bench/answers-roundtrip.ts save  <dir>     first job: no restore; asks everything, keeps it
//   node bench/answers-roundtrip.ts check <dir> <n> second job, after restore: <n> is what the first sent
//
// `save` prints `requests=<n>` for GITHUB_OUTPUT. `check` makes the directory private again the way
// action/run.sh does, then fails unless answers were reused and fewer requests were sent.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { fixtureRepo } from "../test/helpers/repo.ts";
import { STAND_IN_TOKEN, standIn } from "./stand-in.ts";
import type { ReviewReport } from "../src/types.ts";

/** Fixed, because the kept answers are keyed on the endpoint's origin: the two jobs must meet the same one. */
const PORT = 47823;
const SPEC = join(import.meta.dirname, "..", "test", "fixtures", "integrity-rust", "spec.json");

async function run(dir: string): Promise<ReviewReport> {
  const endpoint = await standIn("hashed", PORT);
  const repo = fixtureRepo("integrity-rust");
  try {
    const args = ["--base", repo.base, "--head", repo.head, "--intent-spec", SPEC, "--json", "--answers", dir];
    const out = await new Promise<string>((done, fail) => {
      const child = spawn("node", [join(import.meta.dirname, "..", "src", "cli", "main.ts"), ...args], {
        cwd: repo.dir,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", JEV_API_URL: endpoint.url, JEV_API_TOKEN: STAND_IN_TOKEN },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (code) => (code === 0 ? done(stdout) : fail(new Error(`the command exited ${code}: ${stderr.slice(0, 400)}`))));
    });
    return JSON.parse(out) as ReviewReport;
  } finally {
    endpoint.close();
    repo.remove();
  }
}

function fail(message: string): never {
  console.error(`answers-roundtrip: ${message}`);
  process.exit(1);
}

const [mode, dir, first] = process.argv.slice(2);
if (!dir) fail("usage: answers-roundtrip.ts save|check <dir> [first-requests]");

if (mode === "save") {
  if (existsSync(join(dir, "answers.jsonl"))) fail("the first job found answers already there: it must not restore");
  const report = await run(dir);
  if (report.sent.requests === 0 || report.sent.reused !== 0) fail(`the first run should ask everything: ${JSON.stringify(report.sent)}`);
  console.log(`requests=${report.sent.requests}`);
} else if (mode === "check") {
  const expected = Number(first);
  if (!Number.isInteger(expected) || expected <= 0) fail("check needs the first job's request count");
  const file = join(dir, "answers.jsonl");
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) fail("nothing was restored");
  // As a cache gives it back, before action/run.sh makes it private again.
  console.log(`restored: directory ${(statSync(dir).mode & 0o777).toString(8)}, file ${(statSync(file).mode & 0o777).toString(8)}`);
  chmodSync(dir, 0o700);
  chmodSync(file, 0o600);
  const report = await run(dir);
  console.log(`second run: ${JSON.stringify(report.sent)}`);
  if (report.sent.reused === 0) fail("no answer was reused");
  if (report.sent.requests >= expected) fail(`the second run sent ${report.sent.requests}, the first ${expected}`);
  if (report.metadata.notes.some((n) => n.includes("--answers"))) fail(`the kept answers were refused: ${report.metadata.notes.join(" | ")}`);
} else {
  fail(`unknown mode ${mode}`);
}
