// The human-readable report: printed to the terminal and, in GitHub Actions, written to the job
// summary. Everything that comes from the repository, the pull request or a model (paths,
// requirement text, code, author names) is put inside a code span or code block, where GitHub
// renders neither Markdown nor HTML. The result line is drawn from counts only: no requirement
// verdict is stated anywhere (ADR 0007).

import { redact } from "../evidence/redact.ts";
import { hostName } from "../judgments/client.ts";
import { DEFAULT_FORM, FORMS } from "../plan/forms.ts";
import { BAR } from "../plan/local-check.ts";
import type { LocalCheckResult, MappingRecord, Observed } from "../review/local-check-run.ts";
import type { Outcome } from "../review/outcome.ts";
import type { IntentSource, IntentSpec, Location, ReviewReport } from "../types.ts";

/** The longest run of backticks. A loop: spreading every run into Math.max overflows on long text. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

/** Inline code that cannot be broken out of: the delimiter is longer than any backtick run inside. */
export function codeSpan(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ");
  if (flat.trim() === "") return "`(empty)`";
  const fence = "`".repeat(longestBacktickRun(flat) + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** A fenced block whose fence is longer than any backtick run inside. */
export function codeBlock(text: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}\n${text.replace(/\s+$/, "")}\n${fence}`;
}

/** Notes are this tool's own sentences; `<`, `>` and `&` are still escaped so no HTML can form. */
export function note(text: string): string {
  // Brackets too: a note can carry text an endpoint chose, and `[click](http://…)` in a pull
  // request's summary is a link the reader did not ask for.
  return (
    text
      .replace(/[\r\n]+/g, " ")
      // The backslash first: `\[x\](//host)` would otherwise become `\\[x\\](//host)`, an escaped
      // backslash followed by a bracket that still opens a link.
      .replace(/\\/g, "\\\\")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/[[\]]/g, (b) => `\\${b}`)
      // A bare address is a link on GitHub without any brackets at all, `www.` ones included. As a
      // code span it reads the same wherever the report is shown, and links nowhere.
      // Not `\b`: GitHub links `_www.host` and `_http://host` too, and `_` is a word character.
      .replace(/(?:(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/|(?<![a-z0-9])www\.)[^\s`]+/gi, (address) => `\`${address}\``)
  );
}

export function where(location: Location): string {
  const lines = location.startLine === location.endLine ? `${location.startLine}` : `${location.startLine}-${location.endLine}`;
  return codeSpan(`${location.path}:${lines}`);
}

/** Exported for the Action, whose check-run titles count the same things in the same words. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const SOURCE_WORDS: Record<IntentSource["type"], string> = {
  spec: "the spec file",
  cli: "--intent",
  file: "--intent-file",
  acceptance_criteria: "an acceptance-criteria list",
  github_issue: "an issue",
  issue_comment: "an issue comment",
  pr_description: "the pull request's own description",
  commit_message: "a commit message",
};

/**
 * What was read as requirements, word for word and from where, and every source that was not read
 * with the reason (ADR 0004). Requirement text, source ids and authors are code spans; the reasons,
 * what was left out and `notes` (issues the pull request closes that were not read) go through
 * `note`, since a left-out item quotes the source. A requirement whose source was written by the pull
 * request's author says so: it is the author's own claim about their own change.
 */
export function intentSection(intent: IntentSpec, sources: readonly Omit<IntentSource, "text">[], context: { prAuthor?: string; notes?: readonly string[] } = {}): string[] {
  const notes = context.notes ?? [];
  if (intent.requirements.length === 0 && intent.ambiguities.length === 0 && notes.length === 0) return [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  const prAuthor = context.prAuthor ?? sources.find((s) => s.type === "pr_description")?.author;
  const lines = ["## Intent", ""];
  for (const r of intent.requirements.slice(0, 20)) {
    const from = r.sourceRefs.map((ref) => {
      const s = byId.get(ref.sourceId);
      const own = s?.author !== undefined && s.author === prAuthor;
      return `${codeSpan(ref.sourceId)}${s ? ` (${SOURCE_WORDS[s.type]}${s.author ? `, by ${codeSpan(s.author)}` : ""}${own ? ", the pull request's author" : ""})` : ""}`;
    });
    lines.push(`- ${r.id} read from ${from.join(", ") || "the spec file"}: ${codeSpan(redact(r.text).text)}`);
  }
  if (intent.requirements.length > 20) lines.push(`- and ${intent.requirements.length - 20} more`);
  for (const a of intent.ambiguities.slice(0, 20)) lines.push(`- ${note(a.text)}`);
  if (intent.ambiguities.length > 20) lines.push(`- and ${intent.ambiguities.length - 20} more not read or left out`);
  for (const text of notes) lines.push(`- ${note(text)}`);
  lines.push("");
  return lines;
}

const ORIGIN_WORDS: Record<Observed["origin"], string> = {
  changed: "in a function the change touched",
  calls_changed: "in a function that calls one the change touched",
  shares_call: "in a function that calls what the changed code calls, and nothing the change touched",
};

/** The two sentences every report opens the requirements with. */
export const LOCAL_CHECK_INTRO = [
  `Two questions are put to Jev about each call, separately: what the requirement requires of the call, and what the function does under an assumption. Which two is the requirement's form, named with it. The bar for each is ${BAR}.`,
  "",
  "**Nothing here is a requirement verdict.** One rule, the same for every form, reads each call as worth checking, holding, not settled, or not required of by the requirement. The two answers do not check each other, and everything either of them rests on is printed.",
  "",
];

/**
 * Who chose the requirement's form, in the report's own words (ADR 0008): the spec that named it,
 * Jev's reading of the sentence with its number, or the default — and, for the default, why: what
 * Jev read instead, or why it was not asked. A record from before this field reads as the default.
 */
export function formOrigin(r: Pick<LocalCheckResult, "formBy" | "formReading" | "formNotAsked">): string {
  const by = r.formBy ?? "default";
  if (by === "spec") return "named in the spec";
  if (by === "jev") return `Jev read the sentence as this, ${(r.formReading?.probability ?? 0).toFixed(2)}`;
  if (r.formNotAsked === "candidates_only") return "the default: the form was not asked — `--candidates-only` asks nothing";
  if (r.formNotAsked === "no_function") return "the default: the form was not asked — no function was read";
  const reading = r.formReading;
  if (!reading) return "the default";
  if (reading.verdict === "no_answer") return `the default: the form question was not answered${reading.failure === undefined ? "" : ` (${reading.failure})`}`;
  if (reading.verdict === "neither") return `the default: Jev read the sentence as \`neither\`, ${reading.probability.toFixed(2)}`;
  return `the default: Jev's reading of \`${reading.verdict}\` was under the bar, ${reading.probability.toFixed(2)}`;
}

/** A call asked about that came back without an answer — the budget, the time or the host. */
function unansweredIn(r: LocalCheckResult): number {
  const unanswered = new Set(r.mappings.filter((m) => m.verdict === "no_answer").map((m) => m.callId));
  return r.observed.filter((o) => o.result.observation === "withheld" || unanswered.has(o.callId)).length;
}

/** Calls asked about that came back without an answer: the budget, the time or the host. */
export function withoutAnswer(report: ReviewReport): number {
  return report.requirements.reduce((n, r) => n + unansweredIn(r), 0);
}

/** The notes, over every requirement, that say something was not read or not followed. */
function unreachedNotes(report: ReviewReport): number {
  return new Set(report.requirements.flatMap((r) => r.unreached ?? [])).size;
}

/** "1 note under *Notes* says" / "2 notes under *Notes* say". */
const notesSay = (n: number) => `${plural(n, "note")} under *Notes* ${n === 1 ? "says" : "say"} what was not read`;

/**
 * What a run that read calls left, in the words the report's first line and the Action's check run
 * title both use, so the two cannot disagree (#38): the calls not checked, those asked about that
 * came back without an answer, and the notes that say what the listing did not read — a cap, a file
 * that could not be read. Empty only when nothing was left, which is also the one run the check run
 * calls a success.
 */
export function leftParts(report: ReviewReport): string[] {
  const parts: string[] = [];
  const notChecked = counts(report).notChecked;
  if (notChecked > 0) parts.push(`${notChecked} not checked`);
  const none = withoutAnswer(report);
  if (none > 0) parts.push(`${none} without an answer`);
  const unread = unreachedNotes(report);
  if (unread > 0) parts.push(`${plural(unread, "note")} on what was not read`);
  return parts;
}

/**
 * One line of what a requirement's section rests on (#38): of the calls that could be asked — the
 * changed functions', their callers' and the siblings' together — how many were read and answered,
 * read without an answer, held before their question, or over the budgets; and how many could not be
 * asked at all. "All … were read and answered" only when that is every call and none could not be
 * asked, so a requirement that left calls never reads as checked in full.
 */
export function coverageLine(r: LocalCheckResult, context: { nothingSent?: boolean } = {}): string {
  const c = r.counts;
  const s = c.siblings;
  const couldAsk = c.applicable + (s?.applicable ?? 0);
  const asked = c.asked + (s?.asked ?? 0);
  const over = c.overBudget + (s?.overBudget ?? 0);
  const cannot = c.notApplicable + (s?.notApplicable ?? 0);
  const none = unansweredIn(r);
  // `wouldAsk` holds every call a budget took, siblings' too, and a run asks every one of them or
  // holds it before its question with a reason; a record without it reads as none held.
  const budgeted = r.wouldAsk?.length ?? 0;
  const held = Math.max(0, budgeted - asked);
  const cannotPart = cannot > 0 ? ` ${plural(cannot, "more call")} could not be asked.` : "";
  const unread = r.unreached?.length ?? 0;
  const notes = unread > 0 ? ` ${notesSay(unread)}.` : "";
  if (couldAsk === 0) return `No call could be asked.${cannotPart}${notes}`;
  if (context.nothingSent) {
    const parts = [`${budgeted} inside the budgets, nothing asked`, ...(over > 0 ? [`${over} over the budgets`] : [])];
    return `Of the ${plural(couldAsk, "call")} that could be asked: ${parts.join(", ")}.${cannotPart}${notes}`;
  }
  if (asked - none === couldAsk && cannot === 0 && unread === 0) return `All ${plural(couldAsk, "call")} that could be asked were read and answered.${notes}`;
  const parts = [`${asked - none} read and answered`];
  if (none > 0) parts.push(`${none} without an answer`);
  if (held > 0) parts.push(`${held} held before their question`);
  if (over > 0) parts.push(`${over} over the budgets`);
  return `Of the ${plural(couldAsk, "call")} that could be asked: ${parts.join(", ")}.${cannotPart}${notes}`;
}

/**
 * One requirement's section: what is worth checking, then what was read and how each call came out,
 * then what was not checked and why.
 *
 * Every sentence in it is this file's, a form's or the input's. Nothing is a model's prose — the two
 * model answers appear as a choice and a number, named as Jev's, and the reasoning between them is
 * assembled from the parts. The name of no outcome appears: the sections say what each call was
 * read as.
 */
export function requirementSection(r: LocalCheckResult, context: { nothingSent?: boolean } = {}): string[] {
  const lines: string[] = [];
  const c = r.counts;
  // A result built without a form — a record from before forms, a test's — reads as the default.
  const form = FORMS[r.form ?? DEFAULT_FORM];
  // The requirement is the author's text: a code span, so no line of it can become a heading, a
  // comment that hides the rest of the report, or a workflow command; and redacted for display.
  lines.push(`## ${r.requirementId}`, "", `> ${codeSpan(redact(r.requirementText).text)}`, "");
  lines.push(`Form: \`${r.form ?? DEFAULT_FORM}\` (${formOrigin(r)}). ${context.nothingSent ? `Nothing was asked; the form would ask this. ${form.words.intro}` : form.words.intro}`, "");
  lines.push(`Functions reached: ${c.functions.changed} the change touched, ${c.functions.calls_changed} calling one of those.`);
  lines.push(coverageLine(r, context));
  // One line per budget (ADR 0015). A record from before the callers had one says it in one line.
  const o = c.byOrigin;
  if (o) {
    lines.push(`In the functions the change touched: ${o.changed.calls} calls, of which ${o.changed.applicable} could be asked about. Budget ${o.changed.budget}: ${o.changed.asked} read, ${o.changed.mapped} mapped, ${o.changed.governed} of those governed, ${o.changed.overBudget} left over, ${o.changed.notApplicable} not applicable.`);
    lines.push(`In their callers: ${o.calls_changed.calls} calls, of which ${o.calls_changed.applicable} could be asked about. Their own budget, with what the first left, ${o.calls_changed.budget}: ${o.calls_changed.asked} read, ${o.calls_changed.mapped} mapped, ${o.calls_changed.governed} of those governed, ${o.calls_changed.overBudget} left over, ${o.calls_changed.notApplicable} not applicable.`);
  } else {
    lines.push(`Calls in them: ${c.calls}, of which ${c.applicable} could be asked about. Budget ${c.budget}: ${c.asked} read, ${c.mapped} mapped, ${c.governed} of those governed, ${c.overBudget} left over, ${c.notApplicable} not applicable.`);
  }
  if (c.asked > 0) lines.push(`Of the ${c.asked} read: ${c.outcomes.violates} worth checking, ${c.outcomes.satisfies} holding, ${c.outcomes.unknown} not settled, ${c.outcomes.aside} not required of.`);
  // The siblings are counted apart, so the lines above mean what they meant before siblings were
  // read (ADR 0005). Said only when there was something to look for them from.
  const s = c.siblings;
  if (s && s.seeds.length > 0) {
    lines.push(`Siblings of the change: ${s.functions} function${s.functions === 1 ? "" : "s"} calling what the changed code calls (${s.seeds.map((n) => codeSpan(n)).join(", ")}) and nothing it touched.`);
    lines.push(`Calls in them: ${s.calls}, of which ${s.applicable} could be asked about. Their own budget ${s.budget}: ${s.asked} read, ${s.mapped} mapped, ${s.governed} of those governed, ${s.overBudget} left over, ${s.notApplicable} not applicable.`);
    if (s.asked > 0) lines.push(`Of the ${s.asked} read in siblings: ${s.outcomes.violates} worth checking, ${s.outcomes.satisfies} holding, ${s.outcomes.unknown} not settled, ${s.outcomes.aside} not required of.`);
  }
  lines.push("");

  if (r.findings.length > 0) {
    lines.push("### Worth checking", "");
    for (const f of r.findings) {
      lines.push(`#### ${f.file}:${f.lines} · ${f.function} — \`${f.call}\``);
      if (f.origin === "shares_call") lines.push(`- **Reached as**: a sibling of the change — it calls ${codeSpan(f.via ?? "")}, which the changed code calls, and nothing the change touched`);
      lines.push(`- **Requirement ${f.requirementId}**: ${codeSpan(f.quote)}`);
      lines.push(`- **Assumed**: ${f.condition}`);
      lines.push(`- **Jev, on whether the requirement requires it here**: ${f.mapping.verdict} (${f.mapping.probability.toFixed(2)})`);
      lines.push(`- **${form.words.asks}**: ${f.observation} (${f.probability.toFixed(2)})`);
      lines.push(`- **Why it is listed**: ${f.why}`, "");
    }
  }

  if (r.observed.length === 0) {
    lines.push("_Nothing was read._", "");
    // Only the ones that are not already below with a reason of their own. A budgeted call every
    // one of which was held reads, otherwise, as a list of calls nothing was asked about for no
    // stated reason — while the real reasons sit in the next section.
    const withReason = new Set(r.unchecked.map((u) => `${u.function}\u0000${u.call}`));
    const silent = r.wouldAsk.filter((w) => !withReason.has(`${w.function}\u0000${w.call}`));
    if (silent.length > 0) {
      lines.push("### Inside the budget", "", "The calls the budget selected. Nothing was asked about them here.", "");
      for (const w of silent) lines.push(`- ${w.file} · ${w.function} — \`${w.call}\` _(${ORIGIN_WORDS[w.origin]})_`);
      lines.push("");
    }
  }
  for (const o of r.observed) {
    lines.push(`- **${o.file} · ${o.function}** — \`${o.call}\` _(${ORIGIN_WORDS[o.origin]})_`);
    lines.push(`  - ${form.words.observed}: **${o.result.observation}** (${o.result.probability.toFixed(2)}) — ${o.result.why}`);
  }
  // Every call read is in exactly one of these, or under "Worth checking" above: all come off the
  // outcome the rule gave it, so a call cannot be in two readings or in none.
  const mappingOf = new Map(r.mappings.map((m) => [m.callId, m]));
  const section = (outcome: Outcome, heading: string, explained: string | undefined, why: (o: Observed, m: MappingRecord | undefined) => string) => {
    const these = r.observed.filter((o) => o.outcome === outcome);
    if (these.length === 0) return;
    lines.push("", `### ${heading}`, "", ...(explained ? [explained, ""] : []));
    for (const o of these) lines.push(`- ${o.file} · ${o.function} — \`${o.call}\`: ${why(o, mappingOf.get(o.callId))}`);
  };
  section("satisfies", "Read as holding", "Two readings that agree. Where what decides it is in code that was not sent, they can agree and be wrong.", (o, m) => `${m?.why ?? "the mapping was not recorded"}; ${o.result.why} (${o.result.probability.toFixed(2)})`);
  section("unknown", "Not settled", "A call read, and not settled either way by the two answers.", (o, m) => (m?.governs ? `${m.why}, but ${o.result.why}` : (m?.why ?? "the mapping was not recorded")));
  section("aside", "Read, but not required of by the requirement", undefined, (_o, m) => (m ? `read as \`${m.verdict}\` (${m.probability.toFixed(2)}): not a requirement of this call` : "the mapping was not recorded"));
  if (r.unchecked.length > 0) {
    lines.push("", "### Not checked", "");
    for (const u of r.unchecked) lines.push(`- ${u.file} · ${u.function} — \`${u.call}\` _(${ORIGIN_WORDS[u.origin]})_: ${u.why}`);
  }
  if (r.notes.length > 0) {
    lines.push("", "### Notes", "");
    for (const n of r.notes) lines.push(`- ${note(n)}`);
  }
  lines.push("");
  return lines;
}

/**
 * The counts the result line is drawn from. Nothing else is: no verdict is stated. `worthChecking`
 * is the list the report prints under that heading, so the two cannot disagree. Every one of them
 * takes in the siblings of the change (ADR 0005): the lists hold their calls, and so does `read`,
 * or a finding in a sibling would be "worth checking of 0 read".
 */
export function counts(report: ReviewReport): { read: number; worthChecking: number; inBudget: number; notChecked: number } {
  let read = 0;
  let worthChecking = 0;
  let inBudget = 0;
  let notChecked = 0;
  for (const r of report.requirements) {
    read += r.counts.asked + (r.counts.siblings?.asked ?? 0);
    worthChecking += r.findings.length;
    inBudget += r.wouldAsk.length;
    notChecked += r.unchecked.length;
  }
  return { read, worthChecking, inBudget, notChecked };
}

/**
 * A run that built the set and stopped (`--candidates-only`): what it has to say is which calls fit.
 * Told apart from a finished run that sent nothing because every budgeted call was held before its
 * question — a body that did not fit, a call it could not locate — by what such a run leaves: those
 * calls are under *Not checked* with a reason, and a run that stopped puts none of them there.
 */
function nothingSent(report: ReviewReport): boolean {
  // An answer kept from an earlier run was asked, just not again (ADR 0013).
  if (report.skipReason !== undefined || report.sent.requests + report.sent.reused > 0) return false;
  return report.requirements.some((r) => {
    const held = new Set(r.unchecked.map((u) => `${u.function}\u0000${u.call}`));
    return r.wouldAsk.some((w) => !held.has(`${w.function}\u0000${w.call}`));
  });
}

/**
 * How a run ended, as the report's first line says it. The GitHub Action decides its check run
 * from this too (ADR 0009), so the two cannot disagree about whether anything was read.
 */
export type ResultKind =
  | { kind: "skipped" }
  | { kind: "no_requirement" }
  | { kind: "nothing_asked"; inBudget: number; notChecked: number }
  | { kind: "none_read"; notChecked: number }
  | { kind: "read"; read: number; worthChecking: number };

export function resultKind(report: ReviewReport): ResultKind {
  if (report.skipReason !== undefined) return { kind: "skipped" };
  const n = counts(report);
  if (report.requirements.length === 0) return { kind: "no_requirement" };
  if (nothingSent(report)) return { kind: "nothing_asked", inBudget: n.inBudget, notChecked: n.notChecked };
  if (n.read === 0) return { kind: "none_read", notChecked: n.notChecked };
  return { kind: "read", read: n.read, worthChecking: n.worthChecking };
}

function resultLine(report: ReviewReport): string {
  const r = resultKind(report);
  switch (r.kind) {
    case "skipped":
      return `**Result: skipped.** ${note(report.skipReason ?? "")}`;
    case "no_requirement":
      return "**Result: nothing was checked.**";
    case "nothing_asked":
      return `**Result: the set was built and nothing was asked.** ${plural(r.inBudget, "call")} inside the budget, ${plural(r.notChecked, "call")} not checked, for the reasons under each requirement.`;
    case "none_read":
      return `**Result: no call was read.** ${plural(r.notChecked, "call")} not checked, for the reasons under each requirement. No requirement verdict is stated.`;
    case "read": {
      const left = leftParts(report);
      const said = left.length > 0 ? ` ${left.join(", ")}, for the reasons under each requirement.` : "";
      return `**Result: ${plural(r.worthChecking, "call")} worth checking of ${r.read} read.**${said} No requirement verdict is stated.`;
    }
  }
}

export function renderMarkdown(report: ReviewReport): string {
  const out: string[] = ["# jev-intent-review", "", resultLine(report), ""];

  const m = report.metadata;
  out.push(`Base ${codeSpan(m.base.slice(0, 12))} → head ${codeSpan(m.head.slice(0, 12))} in ${codeSpan(m.repository)}`);
  if (report.sources.length > 0) {
    const sources = report.sources.map((s) => `${codeSpan(s.id)}${s.author ? ` by ${codeSpan(s.author)}` : ""}`);
    out.push(`Intent from ${sources.join(", ")}`);
  }
  // Whoever answers the judgments decides this report, so an endpoint the user pointed at by URL,
  // rather than one of the named hosts, is said where a reader of the summary sees it. Decided by
  // how it was chosen, not by its origin: a URL that happens to be Cloudflare's is still a URL.
  if (report.sent.endpoint !== undefined && report.sent.host === "custom") {
    out.push(`Judged by ${codeSpan(report.sent.endpoint)}, an endpoint set by JEV_API_URL`);
  }
  out.push("");
  out.push(...intentSection(report.intent, report.sources, m.pullRequestAuthor === undefined ? {} : { prAuthor: m.pullRequestAuthor }));

  if (report.requirements.length > 0) {
    // With nothing sent, the two questions were not put to anything: say what the run did instead.
    const quiet = nothingSent(report);
    out.push(...(quiet ? ["Nothing was asked: the set was built and the run stopped. Under each requirement, which calls fit the budget and which did not, with a reason each.", ""] : LOCAL_CHECK_INTRO));
    for (const r of report.requirements) out.push(...requirementSection(r, { nothingSent: quiet }));
  }

  if (report.unexpectedChanges.length > 0) {
    out.push("## Changes no requirement asked for", "");
    for (const change of report.unexpectedChanges) {
      out.push(`### ${change.id} · ${change.judgment.replace("_", " ")} · ${where(change.location)} · p ${change.confidence.toFixed(2)}`, "");
      out.push(codeBlock(change.excerpt), "");
      for (const text of change.notes) out.push(`- ${note(text)}`);
    }
    out.push("");
  }

  // Everything the run has to say beside the calls: intent it did not check, what the change did to
  // this tool's footing, what the pass over the changes left out or redacted.
  if (m.notes.length > 0) {
    out.push("## Notes", "");
    for (const text of m.notes) out.push(`- ${note(text)}`);
    out.push("");
  }

  out.push("## Sent to the judgment model", "");
  out.push(`- ${plural(report.sent.requests, "request")}, ${plural(report.sent.answered, "answer")}${report.sent.reused > 0 ? `, ${plural(report.sent.reused, "answer")} reused (${report.sent.reusedFromEarlierRuns} kept from earlier runs, the rest repeats within this one)` : ""}, ${report.sent.bytes.toLocaleString("en-US")} bytes, model ${codeSpan(m.model)}, questions ${codeSpan(m.questionsHash)}, config ${codeSpan(m.configSource)}`);
  if (report.sent.endpoint !== undefined) out.push(`- Endpoint: ${codeSpan(report.sent.endpoint)}${report.sent.host === undefined ? "" : ` (${hostName(report.sent.host)})`}`);
  out.push("");
  return out.join("\n");
}

export function renderJson(report: ReviewReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
