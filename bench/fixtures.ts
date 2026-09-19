// End to end against the real model: every fixture, through the command line, several times.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node bench/fixtures.ts [runs]
//   JEV_API_URL=... JEV_API_TOKEN=... node bench/fixtures.ts [runs]
//
// Each case names the requirement status it expects and, per path, whether it expects a
// violation there. A run passes a case only if every expectation holds.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli/main.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { ReviewReport } from "../src/types.ts";
import { FIXTURES, fixtureRepo } from "../test/helpers/repo.ts";

interface Case {
  fixture: string;
  after: "head" | "fixed";
  status: string;
  violations: string[]; // paths expected to hold a violation
  clean: string[]; // paths expected not to
}

const CASES: Case[] = [
  { fixture: "missed-path", after: "head", status: "violation", violations: ["src/auth/oauth.ts", "src/auth/websocket.ts"], clean: ["src/auth/password.ts", "src/auth/api-key.ts"] },
  { fixture: "missed-path", after: "fixed", status: "verified", violations: [], clean: ["src/auth/password.ts", "src/auth/oauth.ts", "src/auth/websocket.ts", "src/auth/api-key.ts"] },
  { fixture: "unknown-plugin", after: "head", status: "unknown", violations: [], clean: ["src/records/api.ts", "src/jobs/purge.ts"] },
];

const runs = Number(process.argv[2] ?? 3);
let failures = 0;
for (const c of CASES) {
  const repo = fixtureRepo(c.fixture);
  const after = c.after === "fixed" ? repo.fixed : repo.head;
  if (!after) throw new Error(`${c.fixture} has no ${c.after} version`);
  const spec = join(repo.dir, "spec.json");
  writeFileSync(spec, JSON.stringify(JSON.parse(readFileSync(join(FIXTURES, c.fixture, "fixture.json"), "utf8")).spec));
  for (let run = 1; run <= runs; run++) {
    let stdout = "";
    const started = Date.now();
    const code = await main(["--base", repo.base, "--head", after, "--intent-spec", spec, "--json"], {
      stdout: (t) => void (stdout += t),
      stderr: (t) => process.stderr.write(t),
      cwd: repo.dir,
      env: process.env,
    });
    const report = JSON.parse(stdout) as ReviewReport;
    const r1 = report.requirements[0];
    const outcomes = new Map<string, string[]>();
    for (const cr of r1?.candidates ?? []) outcomes.set(cr.candidate.path, [...(outcomes.get(cr.candidate.path) ?? []), cr.outcome]);
    const wrong: string[] = [];
    if (r1?.status !== c.status) wrong.push(`status ${r1?.status}`);
    for (const path of c.violations) if (!outcomes.get(path)?.includes("violates")) wrong.push(`${path} not a violation`);
    for (const path of c.clean) if (outcomes.get(path)?.includes("violates")) wrong.push(`${path} a violation`);
    if (wrong.length > 0) failures += 1;
    const from = process.env.JEV_API_URL ? "JEV_API_*" : "CLOUDFLARE_*";
    console.log(
      `${wrong.length === 0 ? "PASS" : "FAIL"} ${c.fixture}/${c.after} run ${run}: ${r1?.status} (exit ${code}, ${report.discovery.candidateCount} candidates, ${report.sent.requests} requests, ${report.sent.bytes} bytes, ${Date.now() - started} ms, ${report.sent.endpoint ?? "no endpoint"} from ${from})${wrong.length ? ` — ${wrong.join("; ")}` : ""}`,
    );
    for (const cr of r1?.candidates ?? []) {
      const s = cr.satisfaction;
      const r = cr.relevance;
      const p = (a: typeof s) => (a ? probabilityOf(a, a.choice).toFixed(2) : "-");
      console.log(`    ${cr.outcome.padEnd(14)} ${cr.candidate.path}:${cr.candidate.startLine}-${cr.candidate.endLine} ${cr.candidate.symbol ?? ""} | relevance ${r?.choice ?? "-"} ${p(r)} | satisfaction ${s?.choice ?? "-"} ${p(s)}${cr.notes.length ? ` | ${cr.notes.join("; ")}` : ""}`);
    }
    for (const note of r1?.notes ?? []) console.log(`    note: ${note}`);
  }
  repo.remove();
}
console.log(failures === 0 ? `all ${CASES.length * runs} runs as expected` : `${failures} of ${CASES.length * runs} runs not as expected`);
process.exitCode = failures === 0 ? 0 : 1;
