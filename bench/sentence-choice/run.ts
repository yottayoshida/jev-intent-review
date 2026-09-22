// Asks Jev about every sentence of the bench, `runs` times, and records the answers (#40, part 2).
//
//   node bench/sentence-choice/run.ts --fixed <commit> --labels <commit>   measure; a record left
//                                                                          short of its runs is resumed
//   node bench/sentence-choice/run.ts --probe                              one made-up sentence, to
//                                                                          see the host answers
//
// Needs JEV_PROVIDER and that host's key in the environment, as the CLI does. Before anything is
// sent: the two commits and every fixed file are checked (replay.ts `verify`), labels.json must hold
// every annotator's vote for every unit, and the record's head — commits, the sha256 of each fixed file, the question's hash, the
// host — is written first. A record begun under other files is not added to. The record keeps the
// host's origin and the number of requests, never a header or a key. `--probe` sends a sentence made
// up here, never one of the units.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { endpointFromEnv, FATAL_KINDS, JevClient, ProviderError } from "../../src/judgments/client.ts";
import { JevProvider } from "../../src/judgments/jev.ts";
import { LimitedProvider } from "../../src/judgments/provider.ts";
import { VERSION } from "../../src/version.ts";
import { packetProblems } from "./annotate.ts";
import { QUESTION_HASH, SENTENCE_QUESTIONS, stateOf } from "./question.ts";
import { FIXED_FILES, LABEL_FILE, LOG, labelsOf, sha256, verify, type Answer, type Head, type Labels, type Log } from "./replay.ts";
import type { Rules } from "./rules.ts";
import type { Unit } from "./units.ts";

const HERE = import.meta.dirname;
const read = (file: string) => readFileSync(join(HERE, file), "utf8");
const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const endpoint = endpointFromEnv(process.env);
if (!endpoint) throw new Error("set JEV_PROVIDER and that host's key (see the README)");
const deadline = Date.now() + 4 * 60 * 60 * 1000;
const client = new JevClient(endpoint, { deadline, maxRequests: 2000 });
const provider = new LimitedProvider(new JevProvider(client), { concurrency: 8, deadline });

if (process.argv.includes("--probe")) {
  const sentence = "The command should exit with status 2 when the file it is given does not exist.";
  const answer = await provider.judge({ title: "Exit status for a missing file", heading: "Expected behaviour", lead_in: "", paragraph: sentence, sentence }, SENTENCE_QUESTIONS);
  console.log(`${client.where}: ${answer.role?.choice} ${answer.role?.probability}`);
  process.exit(0);
}

const fixed = arg("--fixed");
const labelsCommit = arg("--labels");
if (!fixed || !labelsCommit) throw new Error("usage: node bench/sentence-choice/run.ts --fixed <commit> --labels <commit>");

const units = JSON.parse(read("units.json")) as Unit[];
const rules = JSON.parse(read("rules.json")) as Rules;
const labels = JSON.parse(read(LABEL_FILE)) as Labels;
const unlabelled = units.filter((u) => labels.votes[u.id] === undefined).map((u) => u.id);
if (unlabelled.length > 0) throw new Error(`${unlabelled.length} units have no votes, the first ${unlabelled[0]}`);
labelsOf(labels, rules);
const stale = packetProblems(labels, units, rules);
if (stale.length > 0) throw new Error(`not sent: ${stale.join("; ")}`);

const head: Head = {
  bench: "sentence-choice",
  tool: VERSION,
  commits: { fixed, labels: labelsCommit },
  sha256: Object.fromEntries([...FIXED_FILES, LABEL_FILE].map((f) => [f, sha256(read(f))])),
  questionHash: QUESTION_HASH,
  model: client.model,
  host: endpoint.host,
  origin: client.origin,
  started: new Date().toISOString(),
};
const problems = verify(head);
if (problems.length > 0) throw new Error(`not sent: ${problems.join("; ")}`);

let log: Log = { head, runs: [] };
if (existsSync(LOG)) {
  const earlier = JSON.parse(readFileSync(LOG, "utf8")) as Log;
  const same = (h: Head) => JSON.stringify({ ...h, started: "" });
  if (same(earlier.head) !== same(head)) throw new Error(`${LOG} was begun under other files, commits or another host; it is not added to`);
  log = earlier;
}

function save(): void {
  mkdirSync(dirname(LOG), { recursive: true });
  const partial = `${LOG}.partial`;
  writeFileSync(partial, `${JSON.stringify(log, null, 1)}\n`);
  renameSync(partial, LOG);
}
save();

for (let run = log.runs.length + 1; run <= rules.runs; run++) {
  const started = new Date().toISOString();
  const before = { ...client.sent };
  const answers: Record<string, Answer> = {};
  await Promise.all(
    units.map(async (u) => {
      try {
        const role = (await provider.judge(stateOf(u), SENTENCE_QUESTIONS)).role;
        answers[u.id] = role ? { choice: role.choice, probability: role.probability, probabilities: role.probabilities } : { error: "no_answer" };
      } catch (error) {
        // A refused key, an empty balance or a wrong endpoint ends the measurement: every further
        // request would fail the same way, and a run of them is not a run of answers.
        if (error instanceof ProviderError && FATAL_KINDS.has(error.kind)) throw error;
        answers[u.id] = { error: error instanceof ProviderError ? error.kind : "error" };
      }
    }),
  );
  log.runs.push({ run, started, finished: new Date().toISOString(), requests: client.sent.requests - before.requests, bytes: client.sent.bytes - before.bytes, answers });
  save();
  const failed = Object.values(answers).filter((a) => "error" in a).length;
  console.log(`run ${run}: ${units.length - failed} answered, ${failed} not, ${client.sent.requests - before.requests} requests`);
}
