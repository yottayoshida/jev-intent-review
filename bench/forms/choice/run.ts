// Does Jev read which form a requirement's sentence has? (ADR 0008)
//
//   node bench/forms/choice/run.ts verify          every sentence is verbatim from where it says it is
//                                                  from, none is a duplicate; sends nothing
//   node bench/forms/choice/run.ts measure [runs]  each sentence `runs` times (default 3) against real
//                                                  Jev, every answer appended to the log as it comes
//   node bench/forms/choice/run.ts score           the table the documentation quotes, from the log;
//                                                  sends nothing
//
// `measure` and `score` take `--set 2` for the second set (sentences-v2.json, log
// form-choice-v2.json): sentences added after the first log was taken, which records the first
// set's sha256 and so is not added to. `verify` checks both sets, and what the repository holds
// against the two together.
//
// `measure` needs JEV_PROVIDER and that host's key in the environment, as the CLI does. It records
// the host's origin, never a header or a key. The log's head records the sha256 of the labelled set
// and of the question before the first request; a log started under another set or another wording
// is not added to, and `score` refuses it.
//
// The sentence is sent alone — `{ requirement: { id, text } }`, the text redacted as every packet's
// is — with the fixed id `R1`: nothing in the request says what the sentence was labelled or who
// wrote it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../../../src/evidence/redact.ts";
import { endpointFromEnv, FATAL_KINDS, JevClient, ProviderError } from "../../../src/judgments/client.ts";
import { JevProvider } from "../../../src/judgments/jev.ts";
import { BAR } from "../../../src/plan/local-check.ts";
import { FORM_QUESTION, QUESTION_HASH } from "./question.ts";
import { duplicates, isFragment, KINDS, LABELS, normalise, renderTables, requirementSentencesIn, requirementsIn, type Log, type Sentence, type SentenceSet } from "./score.ts";

const HERE = new URL("./", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;
const SETS = {
  "1": { set: join(HERE, "sentences.json"), log: join(ROOT, "bench/logs/form-choice-v1.json") },
  "2": { set: join(HERE, "sentences-v2.json"), log: join(ROOT, "bench/logs/form-choice-v2.json") },
} as const;
type SetName = keyof typeof SETS;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const readSet = (name: SetName) => {
  const raw = readFileSync(SETS[name].set, "utf8");
  return { raw, set: JSON.parse(raw) as SentenceSet };
};

/** The text at the place a sentence says it came from, or why it could not be looked up. */
function textAt(s: Sentence): { text: string } | { byHand: true } | { missing: string } {
  const o = s.origin;
  if (o.file === undefined) return o.url !== undefined ? { byHand: true } : { missing: "no file and no url" };
  const doc = JSON.parse(readFileSync(join(ROOT, o.file), "utf8")) as Record<string, unknown>;
  if (o.id !== undefined) {
    const r = requirementsIn(doc).find((x) => x.id === o.id);
    return r ? { text: r.text } : { missing: `${o.file} has no requirement ${o.id}` };
  }
  if (o.case !== undefined && o.index !== undefined) {
    const item = (doc.cases as Record<string, { text: string }[]>)[o.case]?.[o.index];
    return item ? { text: item.text } : { missing: `${o.file} has no ${o.case}[${o.index}]` };
  }
  if (o.ref !== undefined) {
    const c = (doc.candidates as { ref: string; requirement?: string }[]).find((x) => x.ref === o.ref);
    return c?.requirement !== undefined ? { text: c.requirement } : { missing: `${o.file} has no sentence for ${o.ref}` };
  }
  return { missing: `${o.file}: nothing says where in it` };
}

function verify(): number {
  let bad = 0;
  const all: Sentence[] = [];
  for (const name of Object.keys(SETS) as SetName[]) {
    const { raw, set } = readSet(name);
    console.log(`set ${name}:`);
    bad += verifySet(set);
    console.log(`set sha256 ${sha256(raw)}, question sha256 ${QUESTION_HASH}`);
    all.push(...set.sentences);
  }
  for (const ids of duplicates(all)) {
    console.log(`the same sentence twice: ${ids.join(", ")}`);
    bad += 1;
  }
  // The other direction: nothing the repository holds is left out. A set that only checks what it
  // lists would pass with half the sentences missing.
  const have = new Set(all.map((s) => normalise(s.text)));
  for (const { file, text } of requirementSentencesIn(ROOT)) {
    if (!have.has(normalise(text))) {
      console.log(`not in either set: ${file}: ${text.slice(0, 120)}`);
      bad += 1;
    }
  }
  console.log(`${bad} problem(s)`);
  return bad === 0 ? 0 : 1;
}

function verifySet(set: SentenceSet): number {
  let bad = 0;
  let byHand = 0;
  for (const s of set.sentences) {
    if (!LABELS.includes(s.label) || !KINDS.includes(s.origin.kind)) {
      console.log(`${s.id}: label ${s.label} / kind ${s.origin.kind} is not one of the set's`);
      bad += 1;
      continue;
    }
    const found = textAt(s);
    if ("byHand" in found) byHand += 1;
    else if ("missing" in found) {
      console.log(`${s.id}: ${found.missing}`);
      bad += 1;
    } else if (found.text !== s.text) {
      console.log(`${s.id}: differs from ${s.origin.file}\n    set:  ${s.text}\n    file: ${found.text}`);
      bad += 1;
    }
  }
  const count = (f: (s: Sentence) => boolean) => set.sentences.filter(f).length;
  console.log(`${set.sentences.length} sentences: ${LABELS.map((l) => `${l} ${count((s) => s.label === l)}`).join(", ")}`);
  console.log(`by author: ${KINDS.map((k) => `${k} ${count((s) => s.origin.kind === k)}`).join(", ")}; fragments ${count((s) => isFragment(s.text))}`);
  console.log(`${set.sentences.length - byHand} checked against their files, ${byHand} from an issue (checked by hand, see README)`);
  return bad;
}

async function measure(name: SetName, runs: number): Promise<number> {
  const LOG = SETS[name].log;
  const endpoint = endpointFromEnv();
  if (!endpoint) {
    console.error("set JEV_PROVIDER and that host's key (see the README)");
    return 10;
  }
  const client = new JevClient(endpoint);
  const jev = new JevProvider(client);
  const { raw, set } = readSet(name);
  const conditions = { sentences: sha256(raw), question: QUESTION_HASH, bar: BAR, runsPerSentence: runs, provider: process.env.JEV_PROVIDER ?? endpoint.host };
  const head = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const log: Log = existsSync(LOG)
    ? (JSON.parse(readFileSync(LOG, "utf8")) as Log)
    : { conditions, tool: { head, note: "the labelled set and the question were committed before the first request; `conditions` holds their sha256" }, question: FORM_QUESTION, endpoint: client.where, runs: {} };
  if (JSON.stringify(log.conditions) !== JSON.stringify(conditions)) throw new Error(`the log was started under other conditions:\n${JSON.stringify(log.conditions)}\nnow:\n${JSON.stringify(conditions)}`);
  writeFileSync(LOG, `${JSON.stringify(log, null, 2)}\n`);
  console.log(`endpoint ${client.where}, model ${client.model}; ${set.sentences.length} sentences × ${runs}`);

  let sent = 0;
  for (const s of set.sentences) {
    const entry = (log.runs[s.id] ??= []);
    while (entry.length < runs) {
      const state = { requirement: { id: "R1", text: redact(s.text).text } };
      const started = Date.now();
      let answers: Awaited<ReturnType<typeof jev.judge>> | undefined;
      for (let attempt = 1; attempt <= 3 && !answers; attempt++) {
        try {
          answers = await jev.judge(state, FORM_QUESTION);
        } catch (error) {
          const kind = error instanceof ProviderError ? error.kind : "unknown";
          console.log(`${s.id}: request failed (${kind}: ${error instanceof Error ? error.message : String(error)})`);
          if (error instanceof ProviderError && FATAL_KINDS.has(error.kind)) return 12;
          if (attempt === 3) return 12;
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      sent += 1;
      const a = answers!.requirement_form;
      // The provider checks every answer against its question, so this is unreachable through it;
      // a provider that returned without the key would otherwise leave a half entry in the log.
      if (!a) {
        console.log(`${s.id}: the answer has no requirement_form; stopping`);
        return 12;
      }
      entry.push({ answer: a, ms: Date.now() - started });
      writeFileSync(LOG, `${JSON.stringify(log, null, 2)}\n`);
      console.log(`${s.id} [${s.label}] run ${entry.length}: ${a.choice} ${a.probability.toFixed(2)} ${JSON.stringify(a.probabilities)}`);
    }
  }
  console.log(`\n${sent} request(s) sent this time. Table:\n`);
  console.log(renderTables(set, log));
  return 0;
}

function score(name: SetName): number {
  const { raw, set } = readSet(name);
  const log = JSON.parse(readFileSync(SETS[name].log, "utf8")) as Log;
  if (log.conditions.sentences !== sha256(raw)) throw new Error(`the log was taken on another set (${log.conditions.sentences}, now ${sha256(raw)})`);
  if (log.conditions.question !== QUESTION_HASH) throw new Error(`the log was taken with another wording of the question (${log.conditions.question}, now ${QUESTION_HASH})`);
  console.log(renderTables(set, log));
  return 0;
}

const args = process.argv.slice(2);
const at = args.indexOf("--set");
const name = (at >= 0 ? args.splice(at, 2)[1] : "1") as SetName;
if (!(name in SETS)) throw new Error(`--set is one of ${Object.keys(SETS).join(", ")}`);
const [mode, n] = args;
if (mode === "verify") process.exitCode = verify();
else if (mode === "measure") process.exitCode = await measure(name, Number(n ?? 3));
else if (mode === "score") process.exitCode = score(name);
else throw new Error("usage: node bench/forms/choice/run.ts verify | measure [runs] [--set 2] | score [--set 2]");
