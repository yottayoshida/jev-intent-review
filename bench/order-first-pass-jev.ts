// The two calls the order inside a function swaps on omamori `#468`, asked of the real Jev.
//
//   node bench/order-first-pass-jev.ts --omamori <clone> [--runs 3] [--dry] [--out <file>]
//
// On every branch of `#468` the order moves one call of `run_override_disable` into the budget
// (`read_to_string_capped(&config_path, ...)`, line 949) and one out of it
// (`guard_ai_config_modification(...)`, line 935) — `bench/logs/order-first-pass-v1.json`. A
// finding at the call that left is one the order loses; a finding at the call that entered is one
// it adds. Both are asked, `--runs` times each, with the tool as it is.
//
// The run is the CLI's own `runLocalCheck` with a budget large enough for every askable call, and
// a provider that sends only the questions about these two calls and answers every other one with
// nothing — so no other request leaves. The budget does not change what a question or its packet
// holds, only which calls get one. `--dry` counts what would be sent and sends nothing.
//
// Not scored: this says how many findings the swap moves, not whether they are right.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config/config.ts";
import { pathFilter } from "../src/config/glob.ts";
import { parseIntentSpec } from "../src/intent/schema.ts";
import { endpointFromEnv, JevClient } from "../src/judgments/client.ts";
import { JevProvider } from "../src/judgments/jev.ts";
import { LimitedProvider, type JudgmentProvider } from "../src/judgments/provider.ts";
import { Git } from "../src/repository/git.ts";
import { DEFAULT_LOCAL_CHECK, runLocalCheck } from "../src/review/local-check-run.ts";

const HERE = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { omamori: { type: "string" }, runs: { type: "string", default: "3" }, dry: { type: "boolean", default: false }, out: { type: "string" } } });
if (!values.omamori) throw new Error("usage: node bench/order-first-pass-jev.ts --omamori <clone> [--runs 3] [--dry] [--out <file>]");
const clone = resolve(values.omamori);
const RUNS = Number(values.runs);

const FUNCTION = "run_override_disable";
const TARGETS = [
  { tag: "entered", call: "crate::atomic_file::read_to_string_capped(&config_path, MAX_READ_FILE_BYTES)" },
  { tag: "left", call: 'guard_ai_config_modification("override disable")' },
];
// The same branches as `bench/order-first-pass.ts`.
const BRANCHES: Record<string, string> = {
  correct: "e58c04f6df082146969320b91f09aa7a0123ac1f",
  "m-read-baseline": "46cd434299a05ff8c6d2664f720f0606d7e11579",
  "v-read-baseline": "a3dae0a134cc70952fe467bad860a714e4c45792",
  "m-raw-override": "e8f2fdc8385e539aaffd6602ef869cfcbccd2bea",
  "v-raw-override": "6c96366a0ec6e0e5ef3092866d0a2d2da871e332",
};
const SPEC = join(HERE, "bench/fixtures/omamori-468/stated-failure-handling.spec.json");
const intent = parseIntentSpec(readFileSync(SPEC, "utf8"), SPEC);

/** Sends a question only when it is about one of the two calls, in `run_override_disable`. */
class OnlyTheseCalls implements JudgmentProvider {
  readonly model: string;
  readonly #inner: JudgmentProvider | null;
  sent = 0;
  answeredWithNothing = 0;
  constructor(inner: JudgmentProvider | null, model: string) {
    this.#inner = inner;
    this.model = model;
  }
  async judge(state: unknown, questions: Parameters<JudgmentProvider["judge"]>[1]) {
    const asked = JSON.stringify(questions);
    const about = TARGETS.some((t) => asked.includes(JSON.stringify(t.call).slice(1, -1))) && JSON.stringify(state).includes(`fn ${FUNCTION}`);
    if (!about) {
      this.answeredWithNothing += 1;
      return {};
    }
    this.sent += 1;
    return this.#inner ? this.#inner.judge(state, questions) : {};
  }
}

const git = (...args: string[]) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" }).trim();
const endpoint = values.dry ? null : endpointFromEnv(process.env);
if (!values.dry && !endpoint) throw new Error("no endpoint: set the same variables the CLI reads (JEV_PROVIDER and its key)");
const deadline = Date.now() + 30 * 60 * 1000;
const client = endpoint ? new JevClient(endpoint, { deadline, maxRequests: 2000, maxBytes: 64 * 1024 * 1024 }) : null;
const inner = client ? new LimitedProvider(new JevProvider(client), { concurrency: 4, deadline }) : null;

const rows = [];
let sent = 0;
let answeredWithNothing = 0;
const repo = new Git(clone);
for (const [branch, sha] of Object.entries(BRANCHES)) {
  const head = git("rev-parse", sha);
  const before = git("merge-base", "52a58fa", head);
  const { config } = await loadConfig(repo, before, head);
  const include = pathFilter(config.repository.include, config.repository.ignore);
  for (let run = 1; run <= RUNS; run++) {
    const provider = new OnlyTheseCalls(inner, inner?.model ?? "dry");
    const { requirements: results } = await runLocalCheck(repo, { before, after: head }, intent.requirements, provider, include, { ...DEFAULT_LOCAL_CHECK, budget: 10_000 });
    sent += provider.sent;
    answeredWithNothing += provider.answeredWithNothing;
    for (const r of results) {
      for (const t of TARGETS) {
        const at = <T extends { function: string; call: string }>(list: readonly T[]) => list.filter((x) => x.function === FUNCTION && x.call === t.call);
        rows.push({
          branch,
          run,
          requirementId: r.requirementId,
          target: t.tag,
          call: t.call,
          mapping: at(r.mappings).map((m) => ({ verdict: m.verdict, probability: m.probability, probabilities: m.probabilities, governs: m.governs })),
          observed: at(r.observed).map((o) => o.result),
          findings: at(r.findings).length,
        });
      }
    }
  }
}

const srcFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(join(dir, e.name)) : [join(dir, e.name)])).sort();
const digest = createHash("sha256");
for (const f of srcFiles(join(HERE, "src"))) digest.update(f.slice(HERE.length)).update(readFileSync(f));
const log = {
  what: "The two calls of run_override_disable that the order inside a function swaps on omamori #468, asked of Jev; every other question answered with nothing and not sent.",
  tool: { commit: execFileSync("git", ["-C", HERE, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), src: digest.digest("hex") },
  model: inner?.model ?? "dry",
  runs: RUNS,
  questions: { sent, answeredWithNothing },
  requests: client ? { ...client.sent } : null,
  rows,
};
const text = `${JSON.stringify(log, null, 2)}\n`;
if (values.out) writeFileSync(values.out, text);
else process.stdout.write(text);
