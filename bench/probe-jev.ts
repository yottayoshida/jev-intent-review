// Can Jev read code? Hand-built evidence packets for the missed-path fixture, sent to the real
// model several times. No discovery, no aggregation: only whether the judgment itself is right.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node bench/probe-jev.ts [runs]
//   JEV_API_URL=... JEV_API_TOKEN=... node bench/probe-jev.ts [runs]
//
// Expected: oauth and websocket `violates`; password and api-key not `violates`.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { enclosingBlock } from "../src/change/blocks.ts";
import { JevClient, endpointFromEnv } from "../src/judgments/client.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { CANDIDATE_QUESTIONS } from "../src/judgments/questions.ts";
import { FIXTURES } from "../test/helpers/repo.ts";

const fixture = join(FIXTURES, "missed-path");
const read = (path: string) => readFileSync(existsSync(join(fixture, "head", path)) ? join(fixture, "head", path) : join(fixture, "base", path), "utf8");

function region(path: string, marker: string) {
  const lines = read(path).split("\n");
  const at = lines.findIndex((l) => l.includes(marker)) + 1;
  const block = enclosingBlock(lines, at);
  return { lines: `${block.startLine}-${block.endLine}`, symbol: block.name, code: lines.slice(block.startLine - 1, block.endLine).join("\n") };
}

function routeLine(symbol: string) {
  const lines = read("src/routes.ts").split("\n");
  const at = lines.findIndex((l) => l.includes(`${symbol}(`)) + 1;
  return { path: "src/routes.ts", lines: `${at}`, code: lines[at - 1] ?? "" };
}

const middleware = (() => {
  const r = region("src/middleware/reject-disabled.ts", "if (user?.disabledAt)");
  return { path: "src/middleware/reject-disabled.ts", lines: r.lines, code: r.code };
})();

interface Case {
  label: string;
  path: string;
  changed: boolean;
  expectViolation: boolean;
  related: { path: string; lines: string; code: string }[];
}

const cases: Case[] = [
  { label: "password (changed, guarded)", path: "src/auth/password.ts", changed: true, expectViolation: false, related: [routeLine("loginWithPassword")] },
  { label: "oauth (unchanged, no guard)", path: "src/auth/oauth.ts", changed: false, expectViolation: true, related: [routeLine("completeOAuthLogin")] },
  { label: "websocket (unchanged, no guard)", path: "src/auth/websocket.ts", changed: false, expectViolation: true, related: [routeLine("authenticateHandshake")] },
  { label: "api-key, route line only", path: "src/auth/api-key.ts", changed: false, expectViolation: false, related: [routeLine("loginWithApiKey")] },
  { label: "api-key, route + middleware", path: "src/auth/api-key.ts", changed: false, expectViolation: false, related: [routeLine("loginWithApiKey"), middleware] },
];

const endpoint = endpointFromEnv();
if (!endpoint) {
  console.error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN");
  process.exit(10);
}
const client = new JevClient(endpoint);
console.log(`endpoint ${client.origin} (from ${endpoint.source})`);
const jev = new JevProvider(client);
const runs = Number(process.argv[2] ?? 3);

let failures = 0;
for (const c of cases) {
  const r = region(c.path, "createSession(");
  const state = {
    requirement: { id: "R1", text: "Disabled users cannot authenticate." },
    candidate: { path: c.path, lines: r.lines, symbol: r.symbol, changed_by_pull_request: c.changed },
    evidence: { code: r.code, related: c.related, truncated: false },
  };
  const rows: string[] = [];
  let right = 0;
  for (let i = 0; i < runs; i++) {
    const started = Date.now();
    const a = await jev.judge(state, CANDIDATE_QUESTIONS);
    const violates = a.satisfaction?.choice === "violates";
    if (violates === c.expectViolation) right += 1;
    rows.push(
      `    run ${i + 1}: relevance ${a.relevance?.choice} ${a.relevance?.confidence.toFixed(2)} · satisfaction ${a.satisfaction?.choice} ${a.satisfaction?.confidence.toFixed(2)} ${JSON.stringify(a.satisfaction?.probabilities)} · ${Date.now() - started} ms`,
    );
  }
  if (right !== runs) failures += 1;
  console.log(`${right === runs ? "PASS" : "FAIL"} ${c.label} [${c.path}:${r.lines} ${r.symbol}] expected ${c.expectViolation ? "violates" : "not violates"}: ${right}/${runs}`);
  for (const row of rows) console.log(row);
}
console.log(failures === 0 ? "all cases as expected" : `${failures} case(s) not as expected`);
process.exitCode = failures === 0 ? 0 : 1;
