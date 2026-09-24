// What the two benches of a form share: one run of the command, distilled to what is scored, and the
// rule that says whether a run meets a version's row. `run.ts` drives the constructed case, `real.ts`
// the code of the acceptance set's pull requests.

import { main } from "../../src/cli/main.ts";
import type { LocalCheckResult } from "../../src/review/local-check-run.ts";

export interface Distilled {
  exit: number;
  requests: number;
  origins: string[];
  observed: { key: string; outcome: string; mapping: string; observation: string }[];
  findings: string[];
  unchecked: { key: string; why: string }[];
  /** The calls a budget took, as `function · call` (what `--candidates-only` says would be asked). */
  wouldAsk: string[];
  counts: LocalCheckResult["counts"];
  stderr: string;
}

export type Row = Record<string, string>;

const key = (o: { function: string; call: string }) => `${o.function} · ${o.call}`;

/** One run of the command on `base..head` of `repo`, through `main`, with the requests counted. */
export async function once(repo: string, spec: string, base: string, head: string, candidatesOnly: boolean): Promise<Distilled> {
  const out: string[] = [];
  const err: string[] = [];
  let requests = 0;
  const origins = new Set<string>();
  const counting: typeof fetch = (input, init) => {
    requests += 1;
    origins.add(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).origin);
    return fetch(input, init);
  };
  const args = ["--skip-change-check", "--intent-spec", spec, "--base", base, "--head", head, "--json", ...(candidatesOnly ? ["--candidates-only"] : [])];
  const exit = await main(args, { stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), cwd: repo, env: process.env }, { fetch: counting });
  const report = out.length > 0 ? (JSON.parse(out.join("")) as { requirements: LocalCheckResult[] }) : { requirements: [] };
  const r = report.requirements[0];
  return {
    exit,
    requests,
    origins: [...origins],
    observed: (r?.observed ?? []).map((o) => {
      const m = r!.mappings.find((x) => x.callId === o.callId);
      return { key: key(o), outcome: o.outcome, mapping: m ? `${m.verdict} ${m.probability.toFixed(2)}` : "none", observation: `${o.result.observation} ${o.result.probability.toFixed(2)}` };
    }),
    findings: (r?.findings ?? []).map(key),
    unchecked: (r?.unchecked ?? []).map((u) => ({ key: key(u), why: u.why })),
    wouldAsk: (r?.wouldAsk ?? []).map(key),
    counts: r?.counts as LocalCheckResult["counts"],
    stderr: err.join("").slice(0, 2000),
  };
}

/** Whether one run meets its version's row. */
export function meets(row: Row, run: Distilled): { ok: boolean; misses: string[] } {
  const misses: string[] = [];
  const outcome = new Map(run.observed.map((o) => [o.key, o.outcome]));
  for (const [k, want] of Object.entries(row)) {
    if (k === "*" || k === "why") continue;
    const got = outcome.get(k);
    if (got === undefined) misses.push(`${k}: not read`);
    else if (want === "not_violates" ? got === "violates" : got !== want) misses.push(`${k}: ${got}, expected ${want}`);
  }
  if (row["*"] === "not_violates") {
    for (const o of run.observed) if (!Object.hasOwn(row, o.key) && o.outcome === "violates") misses.push(`${o.key}: violates, expected not_violates`);
  }
  return { ok: misses.length === 0 && run.exit === 0, misses };
}
