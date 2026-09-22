// Scores the sentence-choice bench from its record, and writes the table in the docs (#40, part 2).
//
//   node bench/sentence-choice/replay.ts           print the docs section
//   node bench/sentence-choice/replay.ts --write   put it into docs/writing-requirements.md
//   node bench/sentence-choice/replay.ts --check   exit 1 if the docs section is not this
//
// Nothing is sent. The numbers come from bench/logs/sentence-choice-v1.json (Jev's answers), labels.json
// (three annotators' labels for every sentence, made before any answer existed) and rules.json (how to
// score and decide, and how the three labels make one, fixed before any label). Before scoring, every file the record's head names is checked against the
// sha256 written there, and against the commits it names: a record read with other files is not
// scored.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packetProblems } from "./annotate.ts";
import type { Rules } from "./rules.ts";
import type { Unit } from "./units.ts";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..", "..");
export const LOG = join(ROOT, "bench", "logs", "sentence-choice-v1.json");
const DOCS = join(ROOT, "docs", "writing-requirements.md");
const BEGIN = "<!-- sentence-choice:begin -->";
const END = "<!-- sentence-choice:end -->";

/** The files fixed before any label (commit `fixed`), and the labels (commit `labels`). */
export const FIXED_FILES = ["units.json", "rules.json", "question.ts", "annotate.ts", "run.ts", "replay.ts"] as const;
export const LABEL_FILE = "labels.json";

export type Answer = { choice: string; probability: number; probabilities?: Record<string, number> } | { error: string };

export interface Head {
  bench: "sentence-choice";
  tool: string;
  commits: { fixed: string; labels: string };
  sha256: Record<string, string>;
  questionHash: string;
  model: string;
  host: string;
  origin: string;
  started: string;
}

export interface RunRecord {
  run: number;
  started: string;
  finished: string;
  requests: number;
  bytes: number;
  answers: Record<string, Answer>;
}

export interface Log {
  head: Head;
  runs: RunRecord[];
}

export interface Labels {
  /** Who gave the votes, in words: which model, how many annotators, what each was shown. */
  labeler: string;
  labelled: string;
  /** The sha256 of every packet the annotators read (annotate.ts). */
  packets: Record<string, string>;
  /** Each unit's labels, one per annotator, the annotators in the same order for every unit. */
  votes: Record<string, string[]>;
}

/**
 * Each unit's label: the one at least `majority` of the annotators gave, and `noMajority` when none
 * has that many. A unit with the wrong number of votes, or a vote outside the labels, is refused
 * rather than counted.
 */
export function labelsOf(labels: Labels, rules: Rules): Record<string, string> {
  const known = new Set<string>(rules.labels);
  const out: Record<string, string> = {};
  for (const [id, votes] of Object.entries(labels.votes)) {
    const bad = votes.find((v) => !known.has(v));
    if (votes.length !== rules.annotators.count || bad !== undefined) {
      throw new Error(`${id} has ${votes.length} votes${bad === undefined ? "" : ` and a vote "${bad}"`}; each unit needs ${rules.annotators.count}, each one of ${rules.labels.join(", ")}`);
    }
    const count = (label: string) => votes.filter((v) => v === label).length;
    out[id] = votes.find((v) => count(v) >= rules.annotators.majority) ?? rules.annotators.noMajority;
  }
  return out;
}

/** Fleiss' kappa of the annotators on one yes-or-no question: agreement beyond what chance gives. */
export function fleissKappa(yes: readonly number[], raters: number): number {
  if (yes.length === 0) return Number.NaN;
  const agreeing = (k: number) => (k * (k - 1) + (raters - k) * (raters - k - 1)) / (raters * (raters - 1));
  const observed = yes.reduce((sum, k) => sum + agreeing(k), 0) / yes.length;
  const p = yes.reduce((sum, k) => sum + k, 0) / (yes.length * raters);
  const chance = p * p + (1 - p) * (1 - p);
  return chance === 1 ? Number.NaN : (observed - chance) / (1 - chance);
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Every file the head names has the sha256 written there, in the working tree and at its commit, and
 * the commit that fixed the question and rules comes before the one that added the labels.
 */
export function verify(
  head: Head,
  read: (path: string) => string = (p) => readFileSync(join(HERE, p), "utf8"),
  atCommit: (commit: string, path: string) => string = gitShow,
  isAncestor: (earlier: string, later: string) => boolean = gitIsAncestor,
): string[] {
  const problems: string[] = [];
  if (head.commits.fixed === head.commits.labels || !isAncestor(head.commits.fixed, head.commits.labels)) {
    problems.push(`commit ${head.commits.fixed} (question and rules) is not before commit ${head.commits.labels} (labels)`);
  }
  const expected = [...FIXED_FILES.map((f) => [f, head.commits.fixed] as const), [LABEL_FILE, head.commits.labels] as const];
  for (const [file, commit] of expected) {
    const want = head.sha256[file];
    if (want === undefined) {
      problems.push(`the record names no sha256 for ${file}`);
      continue;
    }
    if (sha256(read(file)) !== want) problems.push(`${file} is not the file the record was made with`);
    let committed: string | undefined;
    try {
      committed = atCommit(commit, file);
    } catch {
      problems.push(`${file} cannot be read at commit ${commit} (is the history in this clone?)`);
    }
    if (committed !== undefined && sha256(committed) !== want) problems.push(`${file} at commit ${commit} is not the file the record was made with`);
  }
  return problems;
}

function gitShow(commit: string, file: string): string {
  return execFileSync("git", ["-C", ROOT, "show", `${commit}:bench/sentence-choice/${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function gitIsAncestor(earlier: string, later: string): boolean {
  try {
    execFileSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", earlier, later], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The 95% Wilson interval of k successes in n; with no trials, it says nothing: [0, 1]. */
export function wilson(k: number, n: number, z: number): { value: number; lo: number; hi: number } {
  if (n === 0) return { value: Number.NaN, lo: 0, hi: 1 };
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { value: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export interface Measure {
  chosen: number;
  correct: number;
  precision: { value: number; lo: number; hi: number };
  lenientPrecision: number;
  recall: { value: number; lo: number; hi: number };
  adopt: boolean;
  reject: boolean;
}

export interface Score {
  units: number;
  issues: number;
  positives: number;
  runs: (Measure & { run: number; unanswered: number; nonGoal: { answered: number; labelled: number; both: number }; chooseInIssuesAskingNothing: number })[];
  rule: Measure;
  stable: { any: number; every: number };
  issuesAskingNothing: number;
  labeler: string;
  /** Over every unit: all annotators gave one label, only a majority did, or none did. */
  agreement: { unanimous: number; majority: number; none: number; of: number; positiveUnanimous: number; positiveKappa: number };
  decision: "adopt" | "reject" | "undetermined";
}

function measure(chosen: ReadonlySet<string>, label: Record<string, string>, rules: Rules): Measure {
  const positives = Object.entries(label).filter(([, l]) => l === rules.positive).map(([id]) => id);
  const correct = positives.filter((id) => chosen.has(id)).length;
  const notCounted = new Set<string>(rules.notCounted);
  const lenientDenominator = [...chosen].filter((id) => !notCounted.has(label[id] ?? "")).length;
  const z = rules.interval.z;
  const precision = wilson(correct, chosen.size, z);
  const recall = wilson(correct, positives.length, z);
  return {
    chosen: chosen.size,
    correct,
    precision,
    lenientPrecision: lenientDenominator === 0 ? Number.NaN : correct / lenientDenominator,
    recall,
    adopt: precision.lo >= rules.gate.precision && recall.lo >= rules.gate.recall,
    reject: precision.hi < rules.gate.precision || recall.hi < rules.gate.recall,
  };
}

/** Whether an answer is a choice: `required_behavior` at the bar or above. Anything else is not. */
export function isChoice(answer: Answer | undefined, rules: Rules, choice = rules.positive): boolean {
  return answer !== undefined && "choice" in answer && answer.choice === choice && answer.probability >= rules.bar;
}

export function score(units: readonly Unit[], labels: Labels, log: Log, rules: Rules): Score {
  const ids = units.map((u) => u.id);
  const label = labelsOf(labels, rules);
  const issueOf = new Map(units.map((u) => [u.id, u.issue]));
  const issues = [...new Set(units.map((u) => u.issue))];
  const askingNothing = new Set(issues.filter((issue) => !ids.some((id) => issueOf.get(id) === issue && label[id] === rules.positive)));
  const runs = log.runs.map((r) => {
    const chosen = new Set(ids.filter((id) => isChoice(r.answers[id], rules)));
    const jevNonGoal = new Set(ids.filter((id) => isChoice(r.answers[id], rules, "non_goal")));
    const labelledNonGoal = ids.filter((id) => label[id] === "non_goal");
    return {
      run: r.run,
      ...measure(chosen, label, rules),
      unanswered: ids.filter((id) => r.answers[id] === undefined || "error" in (r.answers[id] as Answer)).length,
      nonGoal: { answered: jevNonGoal.size, labelled: labelledNonGoal.length, both: labelledNonGoal.filter((id) => jevNonGoal.has(id)).length },
      chooseInIssuesAskingNothing: [...askingNothing].filter((issue) => ids.some((id) => issueOf.get(id) === issue && chosen.has(id))).length,
    };
  });
  const heading = new RegExp(rules.baseline.heading, rules.baseline.flags);
  const sentence = new RegExp(rules.baseline.sentence, rules.baseline.flags);
  const byRule = new Set(units.filter((u) => heading.test(u.heading) || sentence.test(u.sentence)).map((u) => u.id));
  const chosenAny = ids.filter((id) => log.runs.some((r) => isChoice(r.answers[id], rules)));
  const chosenEvery = chosenAny.filter((id) => log.runs.every((r) => isChoice(r.answers[id], rules)));
  const votes = ids.map((id) => labels.votes[id] ?? []);
  const most = votes.map((v) => Math.max(0, ...v.map((x) => v.filter((y) => y === x).length)));
  const positiveVotes = votes.map((v) => v.filter((x) => x === rules.positive).length);
  const complete = runs.length === rules.runs;
  return {
    units: ids.length,
    issues: issues.length,
    positives: ids.filter((id) => label[id] === rules.positive).length,
    runs,
    rule: measure(byRule, label, rules),
    stable: { any: chosenAny.length, every: chosenEvery.length },
    issuesAskingNothing: askingNothing.size,
    labeler: labels.labeler,
    agreement: {
      unanimous: most.filter((m) => m === rules.annotators.count).length,
      majority: most.filter((m) => m >= rules.annotators.majority && m < rules.annotators.count).length,
      none: most.filter((m) => m < rules.annotators.majority).length,
      of: ids.length,
      positiveUnanimous: positiveVotes.filter((k) => k === 0 || k === rules.annotators.count).length,
      positiveKappa: fleissKappa(positiveVotes, rules.annotators.count),
    },
    decision: complete && runs.every((r) => r.adopt) ? "adopt" : complete && runs.every((r) => r.reject) ? "reject" : "undetermined",
  };
}

const f2 = (x: number) => (Number.isNaN(x) ? "—" : x.toFixed(2));
const band = (m: { value: number; lo: number; hi: number }) => `${f2(m.value)} (${f2(m.lo)}–${f2(m.hi)})`;

const DECISION: Record<Score["decision"], string> = {
  adopt: "**Decision: adopt.** In every run, both lower bounds clear the bar. Choosing sentences out of prose goes to a separate issue, to be built and checked again on its own.",
  reject: "**Decision: do not adopt.** In every run, an upper bound falls below the bar. Prose is not read as requirements; write them in one of the forms above.",
  undetermined: "**Decision: not shown.** The runs neither clear the bar nor fall below it. That is taken as not adopting: prose is not read as requirements, and there is no second measurement on these issues.",
};

/** The docs section: what was measured, the table, and the decision it gives. */
export function render(s: Score, head: Head, rules: Rules): string {
  const lines = [
    `On ${s.units} sentences of ${s.issues} issues that people wrote in six Rust projects between 2019 and 2022 (\`bench/sentence-choice/issues/\`), Jev was asked ${rules.runs} times whether each sentence states a required behaviour (\`bench/sentence-choice/question.ts\`). The labels, the question and these rules were fixed in commits \`${head.commits.fixed.slice(0, 12)}\` (question, rules, sentences) and \`${head.commits.labels.slice(0, 12)}\` (labels), before the first request; ${head.model} on ${head.host}.`,
    "",
    `The labels are not a person's. At the maintainer's request, ${s.labeler}. A sentence's label is the one at least ${rules.annotators.majority} of the ${rules.annotators.count} gave; with none, it is "${rules.annotators.noMajority.replace("_", " ")}". ${s.positives} sentences are labelled as stating a required behaviour. All ${rules.annotators.count} gave the same label to ${s.agreement.unanimous} of the ${s.agreement.of} sentences, ${rules.annotators.majority} of ${rules.annotators.count} to ${s.agreement.majority}, and none agreed on ${s.agreement.none}; on whether a sentence states a required behaviour, all ${rules.annotators.count} agreed on ${s.agreement.positiveUnanimous} (Fleiss' kappa ${f2(s.agreement.positiveKappa)}). Annotators of one model agreeing is not accuracy: they can share a mistake, and the figures below measure Jev against them, not against the people who wrote the issues.`,
    "",
    "A sentence counts as chosen when Jev answers `required_behavior` with a probability of at least " + f2(rules.bar) + ". Precision counts every sentence chosen, including those labelled \"cannot tell\" or \"not a sentence\"; the lenient figure leaves those out. Ranges are 95% Wilson intervals.",
    "",
    "| | chosen | right | precision | lenient | recall | no answer |",
    "|---|---|---|---|---|---|---|",
    ...s.runs.map((r) => `| Jev, run ${r.run} | ${r.chosen} | ${r.correct} | ${band(r.precision)} | ${f2(r.lenientPrecision)} | ${band(r.recall)} | ${r.unanswered} |`),
    `| Headings and "should/must" (no model) | ${s.rule.chosen} | ${s.rule.correct} | ${band(s.rule.precision)} | ${f2(s.rule.lenientPrecision)} | ${band(s.rule.recall)} | — |`,
    "",
    `- Chosen in every run: ${s.stable.every} of the ${s.stable.any} sentences chosen in any run.`,
    `- Issues that ask for no behaviour (no sentence labelled so): ${s.issuesAskingNothing}. Jev chose a sentence in ${s.runs.map((r) => r.chooseInIssuesAskingNothing).join(" / ")} of them (per run).`,
    `- Not goals: labelled ${s.runs[0]?.nonGoal.labelled ?? 0}; Jev answered \`non_goal\` for ${s.runs.map((r) => r.nonGoal.answered).join(" / ")}, agreeing on ${s.runs.map((r) => r.nonGoal.both).join(" / ")}. Not part of the decision.`,
    "",
    `The rule, fixed before the labels: adopt when, in every run, the lower bound of precision is at least ${f2(rules.gate.precision)} and the lower bound of recall at least ${f2(rules.gate.recall)}; do not adopt when, in every run, an upper bound is below its bar; otherwise the result is not shown, which is taken as not adopting.${s.rule.adopt ? " The model-free rule clears the same bar, so adding it as a form is a separate issue." : ""}`,
    "",
    DECISION[s.decision],
  ];
  return lines.join("\n");
}

function load<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = load<Log>(LOG);
  const rules = load<Rules>(join(HERE, "rules.json"));
  const units = load<Unit[]>(join(HERE, "units.json"));
  const labels = load<Labels>(join(HERE, LABEL_FILE));
  const problems = [...verify(log.head), ...packetProblems(labels, units, rules)];
  if (problems.length > 0) {
    for (const p of problems) console.error(`replay: ${p}`);
    process.exit(1);
  }
  const section = render(score(units, labels, log, rules), log.head, rules);
  const docs = readFileSync(DOCS, "utf8");
  const [before, rest] = docs.split(BEGIN);
  const after = rest?.split(END)[1];
  if (process.argv.includes("--check")) {
    const same = after !== undefined && rest?.split(END)[0] === `\n${section}\n`;
    console.log(same ? "the docs section is the replay" : "the docs section differs from the replay");
    process.exitCode = same ? 0 : 1;
  } else if (process.argv.includes("--write")) {
    if (after === undefined) throw new Error(`docs/writing-requirements.md has no ${BEGIN} … ${END}`);
    writeFileSync(DOCS, `${before}${BEGIN}\n${section}\n${END}${after}`);
  } else {
    console.log(section);
  }
}
