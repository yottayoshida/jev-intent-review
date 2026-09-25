// Checks 1 and 2 of #82's rule naming the code a reading turns on (ADR 0019, bench/decisive/expected.json).
// No request: the rules are the product's (`Form.decisive`, `decisiveBodies`), applied to real code.
//
//   node bench/decisive/check.ts <acceptance dir>
//
// `<acceptance dir>` holds the clones (`grovedb`, `moltis`, `whatsapp-rust`, `pybun`, `quebec`,
// `instruckt-tauri`, `Kontor`), as for bench/acceptance/run.ts. It writes bench/logs/decisive-v1.json
// and prints every held call, for the reading by hand that check 2 asks for.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli/main.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { pathFilter } from "../../src/config/glob.ts";
import { Discoverer } from "../../src/discovery/discover.ts";
import { buildEvidence, DECISIVE_LIMITS, decisiveBodies } from "../../src/evidence/builder.ts";
import { redact } from "../../src/evidence/redact.ts";
import { parseIntentSpec } from "../../src/intent/schema.ts";
import { JUDGMENT_ENV } from "../../src/judgments/client.ts";
import { functionDefinitionsOf } from "../../src/plan/applicability.ts";
import { enumerate } from "../../src/plan/candidates.ts";
import { FORMS } from "../../src/plan/forms.ts";
import { DEFAULT_LOCAL_CHECK, type LocalCheckResult } from "../../src/review/local-check-run.ts";
import { Git } from "../../src/repository/git.ts";
import type { Requirement } from "../../src/types.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const LOG = join(ROOT, "bench", "logs", "decisive-v1.json");
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const CLONES: Record<string, string> = { "grovedb-500": "grovedb", "moltis-1064": "moltis", "whatsapp-rust-759": "whatsapp-rust", "pybun-428": "pybun", "quebec-136": "quebec", "instruckt-tauri-9": "instruckt-tauri", "kontor-385": "Kontor" };
const UNSEEN = ["whatsapp-rust-759", "pybun-428", "quebec-136", "instruckt-tauri-9", "kontor-385"];

interface Place {
  file: string;
  function: string;
  call: string;
}

/** A place at a commit, as `askSite` has it: the listing's function and call, its calls, the packet's body. */
async function at(repo: string, head: string, place: Place, requirement: Requirement) {
  const git = await Git.open(repo);
  const source = await git.readText(head, place.file);
  if (source === null) return { skip: "the file is not at this commit" } as const;
  const listed = enumerate(place.file, source);
  const hits = listed.calls.filter((c) => listed.functions.find((f) => f.id === c.functionId)?.name === place.function && redact(c.expression).text === place.call);
  if (hits.length !== 1) return { skip: `the call appears ${hits.length} times in its function: the run does not ask it either` } as const;
  const call = hits[0]!;
  const fn = listed.functions.find((f) => f.id === call.functionId)!;
  const cfg = defaultConfig();
  const discoverer = new Discoverer(git, head, { include: pathFilter(cfg.repository.include, cfg.repository.ignore), lexicalSearch: true, referenceSearch: true });
  const evidence = await buildEvidence(discoverer, requirement, { path: fn.path, startLine: fn.startLine, endLine: fn.endLine, symbol: fn.name, changed: true, reasons: [] }, { maxPrimaryChars: DEFAULT_LOCAL_CHECK.maxPrimaryChars, maxRelatedChars: DEFAULT_LOCAL_CHECK.maxRelatedChars });
  if (evidence.cut.own) return { skip: "the body does not fit: the run does not ask it either" } as const;
  const defined = async (name: string) => {
    const { found, more } = await functionDefinitionsOf(discoverer, name);
    return found.length > 0 || more;
  };
  return { fn, call, calls: listed.calls.filter((c) => c.functionId === fn.id), body: evidence.packet.evidence.code, discoverer, defined };
}

const requirementOf = (spec: string) => parseIntentSpec(readFileSync(join(ROOT, spec), "utf8"), spec).requirements[0]!;

/** Check 1: the failure form on every call v4 read with a confident outcome. */
async function check1(acceptance: string) {
  type Run = { requirements: { observed: (Place & { outcome: string })[] }[] };
  const v4 = readJson<{ cases: Record<string, { versions: Record<string, { head: string; runs: Run[] }> }> }>(join(ROOT, "bench/logs/acceptance-v4.json"));
  const rows: (Place & { case: string; version: string; held: string | null; located: boolean })[] = [];
  for (const [id, c] of Object.entries(v4.cases)) {
    const requirement = requirementOf(`bench/acceptance/cases/${id}/spec.json`);
    for (const [version, v] of Object.entries(c.versions)) {
      const confident = new Map<string, Place>();
      for (const run of v.runs) for (const o of run.requirements[0]!.observed) if (o.outcome === "satisfies" || o.outcome === "violates") confident.set(`${o.file}\u0000${o.function}\u0000${o.call}`, { file: o.file, function: o.function, call: o.call });
      for (const place of confident.values()) {
        const p = await at(join(acceptance, CLONES[id]!), v.head, place, requirement);
        const d = !("skip" in p) ? await FORMS.failure_propagation.decisive({ requirement, fn: p.fn, call: p.call, body: p.body, calls: p.calls, defined: p.defined }) : null;
        rows.push({ case: id, version, ...place, located: !("skip" in p), held: d && "hold" in d ? d.hold : null });
      }
    }
  }
  return rows;
}

/** Check 2: both rules on every call `--candidates-only` would ask in five shipped pull requests. */
async function check2(acceptance: string) {
  const pre = readJson<{ cases: Record<string, { revisions: { before: string; after: string } }> }>(join(ROOT, "bench/acceptance/precheck-shipped.json"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !(JUDGMENT_ENV as readonly string[]).includes(k)));
  type Row = { listed: number; asked: number; failureHeld: (Place & { why: string })[]; checkHeld: (Place & { why: string })[]; checkSent: number; notAsked: Record<string, number> };
  const out: Record<string, Row> = {};
  for (const id of UNSEEN) {
    const repo = join(acceptance, CLONES[id]!);
    const { before, after } = pre.cases[id]!.revisions;
    const spec = `bench/acceptance/cases/${id}/spec.json`;
    let stdout = "";
    const code = await main(["--skip-change-check", "--candidates-only", "--json", "--base", before, "--head", after, "--intent-spec", join(ROOT, spec)], { stdout: (t) => void (stdout += t), stderr: () => {}, cwd: repo, env });
    if (code !== 0) throw new Error(`${id}: --candidates-only exited ${code}`);
    const r = (JSON.parse(stdout) as { requirements: LocalCheckResult[] }).requirements[0]!;
    const requirement = requirementOf(spec);
    const row: Row = (out[id] = { listed: r.wouldAsk.length, asked: 0, failureHeld: [], checkHeld: [], checkSent: 0, notAsked: {} });
    for (const w of r.wouldAsk) {
      const place = { file: w.file, function: w.function, call: w.call };
      const p = await at(repo, after, place, requirement);
      if ("skip" in p) {
        const why = (p as { skip: string }).skip;
        row.notAsked[why] = (row.notAsked[why] ?? 0) + 1;
        continue;
      }
      row.asked += 1;
      const f = await FORMS.failure_propagation.decisive({ requirement, fn: p.fn, call: p.call, body: p.body, calls: p.calls, defined: p.defined });
      if ("hold" in f) row.failureHeld.push({ ...place, why: f.hold });
      // The check rule with the call's own name standing in for the requirement's words.
      const own = p.call.callee.split("::").pop()!;
      const proxy: Requirement = { id: "P", text: own.replace(/_/g, " "), kind: "behavior", priority: "required", sourceRefs: [], searchHints: [own], form: "check_before_action" };
      const c = await FORMS.check_before_action.decisive({ requirement: proxy, fn: p.fn, call: p.call, body: p.body, calls: p.calls, defined: p.defined });
      if ("send" in c && c.send.length > 0) {
        const bodies = await decisiveBodies(p.discoverer, c.send, p.fn, DECISIVE_LIMITS);
        if ("hold" in bodies) row.checkHeld.push({ ...place, why: bodies.hold });
        else row.checkSent += 1;
      }
    }
  }
  return out;
}

/**
 * Check 3: the target's outcome in each run of bench/logs/check-before-action-real-v3.json and
 * -v2.json (the constructed case) against `check3.rows`. A row is "satisfies 3/3", "violates 3/3" or
 * "violates in at least 2 of 3"; a run where the target is not checked fails whatever the row says.
 */
export function check3(): { lines: string[]; pass: boolean } {
  type Run = { observed: { key: string; outcome: string }[]; unchecked: { key: string; why: string }[] };
  const expected = readJson<{ check3: { rows: Record<string, Record<string, string>> } }>(join(ROOT, "bench/decisive/expected.json")).check3.rows;
  const real = readJson<{ cases: Record<string, Record<string, { runs: Run[] }>> }>(join(ROOT, "bench/logs/check-before-action-real-v3.json"));
  const constructed = readJson<{ versions: Record<string, { runs: Run[] }> }>(join(ROOT, "bench/logs/check-before-action-v2.json"));
  const targetOf = (id: string) => (id === "constructed" ? "open_session · create_session(store, &record)" : (() => {
    const t = readJson<{ target: { function: string; call: string } }>(join(ROOT, "bench/forms/real", id, "case.json")).target;
    return `${t.function} · ${t.call}`;
  })());
  const lines: string[] = [];
  let pass = true;
  for (const [id, rows] of Object.entries(expected)) {
    const key = targetOf(id);
    for (const [version, row] of Object.entries(rows)) {
      const runs = (id === "constructed" ? constructed.versions[version]?.runs : real.cases[id]?.[version]?.runs) ?? [];
      const got = runs.map((r) => r.observed.find((o) => o.key === key)?.outcome ?? (r.unchecked.some((u) => u.key === key) ? "not checked" : "not read"));
      const want = row.startsWith("satisfies") ? "satisfies" : "violates";
      const need = /at least (\d)/.exec(row)?.[1] ? Number(/at least (\d)/.exec(row)![1]) : 3;
      const ok = runs.length === 3 && got.filter((g) => g === want).length >= need && !got.includes("not checked");
      if (!ok) pass = false;
      lines.push(`${ok ? "ok  " : "MISS"} ${id} ${version}: ${got.join(", ") || "no run"} (expected ${row})`);
    }
  }
  return { lines, pass };
}

const [acceptance] = process.argv.slice(2);
if (acceptance === "check3") {
  const { lines, pass } = check3();
  for (const l of lines) console.log(l);
  console.log(`check 3: ${pass ? "PASS" : "FAIL"}`);
} else if (!acceptance) {
  console.error("usage: check.ts <acceptance dir>");
  process.exitCode = 2;
} else {
  const expected = readJson<{ check1: { held: (Place & { case: string; version: string })[] } }>(join(ROOT, "bench/decisive/expected.json"));
  const one = await check1(acceptance);
  const heldKey = (x: Place & { case: string; version: string }) => `${x.case} ${x.version} ${x.function} · ${x.call}`;
  const want = new Set(expected.check1.held.map(heldKey));
  const got = new Set(one.filter((r) => r.held).map(heldKey));
  const pass1 = one.every((r) => r.located) && want.size === got.size && [...want].every((k) => got.has(k));
  console.log(`check 1: ${one.length} confident readings, ${got.size} held (${[...got].join("; ")}), ${one.filter((r) => !r.located).length} not located — ${pass1 ? "PASS" : "FAIL"}`);
  const two = await check2(acceptance);
  let pass2 = true;
  for (const [id, r] of Object.entries(two)) {
    const f = r.failureHeld.length / Math.max(1, r.asked);
    const c = r.checkHeld.length / Math.max(1, r.asked);
    if (f > 0.1 || c > 0.1) pass2 = false;
    console.log(`check 2 ${id}: ${r.listed} in the budget, ${r.asked} asked by the run (not asked either way: ${JSON.stringify(r.notAsked)}); failure form held ${r.failureHeld.length} (${(f * 100).toFixed(1)}%); check rule held ${r.checkHeld.length} (${(c * 100).toFixed(1)}%), sent a check's body for ${r.checkSent}`);
    for (const h of r.failureHeld) console.log(`    failure held: ${h.file} · ${h.function} — ${h.call}: ${h.why}`);
    for (const h of r.checkHeld) console.log(`    check held: ${h.file} · ${h.function} — ${h.call}: ${h.why}`);
  }
  console.log(`check 2: ${pass2 ? "PASS on the rates; every failure-form hold still has to be read by hand" : "FAIL"}`);
  writeFileSync(LOG, `${JSON.stringify({ what: "#82 checks 1 and 2 (bench/decisive/expected.json), no request", check1: one, check2: two }, null, 2)}\n`);
}
