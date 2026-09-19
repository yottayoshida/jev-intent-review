// The human-readable report: printed to the terminal and, in GitHub Actions, written to the job
// summary. Everything that comes from the repository, the pull request or a model (paths,
// requirement text, code, author names) is put inside a code span or code block, where GitHub
// renders neither Markdown nor HTML. The result line is drawn from the verdict enum only.

import { probabilityOf } from "../review/requirement.ts";
import type { CandidateOutcome, CandidateResult, Location, ReviewReport, RequirementResult, Status } from "../types.ts";

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
function note(text: string): string {
  // Brackets too: a note can carry text an endpoint chose, and `[click](http://…)` in a pull
  // request's summary is a link the reader did not ask for.
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[[\]]/g, (b) => `\\${b}`)
    // A bare address is a link on GitHub without any brackets at all. As a code span it reads the
    // same wherever the report is shown, and links nowhere.
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s`]+/gi, (address) => `\`${address}\``);
}

export function where(location: Location): string {
  const lines = location.startLine === location.endLine ? `${location.startLine}` : `${location.startLine}-${location.endLine}`;
  return codeSpan(`${location.path}:${lines}`);
}

const MARK: Record<CandidateOutcome, string> = {
  satisfies: "✓",
  violates: "✗",
  unknown: "?",
  not_applicable: "–",
  unrelated: "·",
};

// VERIFIED is not here: its headline carries the path count (requirementSection).
const HEADLINE: Record<Exclude<Status, "verified">, string> = {
  violation: "VIOLATION",
  unknown: "UNKNOWN",
  not_applicable: "NOT APPLICABLE",
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function resultLine(report: ReviewReport): string {
  const total = report.requirements.length;
  const count = (status: Status) => report.requirements.filter((r) => r.status === status).length;
  const paths = report.discovery.candidateCount;
  switch (report.verdict) {
    case "violation":
      return `**Result: VIOLATION.** ${count("violation")} of ${plural(total, "requirement")} ${count("violation") === 1 ? "has" : "have"} a violation.`;
    case "unknown":
      return `**Result: UNKNOWN.** No violation was found, but ${count("unknown")} of ${plural(total, "requirement")} could not be verified.`;
    case "no_violation_found":
      return `**Result: no violation found** in ${plural(paths, "discovered path")}. This is not proof that the change is correct.`;
    case "skipped":
      return `**Result: skipped.** ${note(report.skipReason ?? "")}`;
    case "incomplete":
      return "**Result: incomplete.** The review did not finish; see the notes below.";
  }
}

function candidateLine(result: CandidateResult): string[] {
  const c = result.candidate;
  const parts = [`${MARK[result.outcome]} ${result.outcome.replace("_", " ")}`, where(c)];
  if (c.symbol) parts.push(codeSpan(c.symbol));
  if (c.changed) parts.push("changed in this pull request");
  // The same number the policy used: the probability of the chosen answer, not Jev's `confidence`.
  const answer = result.satisfaction ?? result.relevance;
  if (answer) parts.push(`p ${probabilityOf(answer, answer.choice).toFixed(2)}`);
  const lines = [`- ${parts.join(" · ")}`];
  for (const location of result.evidence) lines.push(`  - evidence: ${where(location)}`);
  for (const text of result.notes) lines.push(`  - ${note(text)}`);
  return lines;
}

function requirementSection(report: ReviewReport, result: RequirementResult): string[] {
  const requirement = report.intent.requirements.find((r) => r.id === result.requirementId);
  const checked = result.candidates.filter((c) => c.outcome !== "unrelated").length;
  const headline = result.status === "verified" ? `VERIFIED over ${plural(checked, "discovered path")}` : HEADLINE[result.status];
  const lines = [`### ${result.requirementId} · ${headline}`, "", codeSpan(requirement?.text ?? ""), "", `Coverage: ${result.coverage}`, ""];
  const shown = result.candidates.filter((c) => c.outcome !== "unrelated");
  for (const candidate of shown) lines.push(...candidateLine(candidate));
  const hidden = result.candidates.length - shown.length;
  if (hidden > 0) lines.push(`- ${plural(hidden, "other candidate")} judged unrelated or only supporting`);
  for (const text of result.notes) lines.push(`- ${note(text)}`);
  lines.push("");
  return lines;
}

const CLOUDFLARE_ORIGIN = "https://api.cloudflare.com";

export function renderMarkdown(report: ReviewReport): string {
  const out: string[] = ["# jev-intent-review", "", resultLine(report), ""];

  const m = report.metadata;
  out.push(`Base ${codeSpan(m.base.slice(0, 12))} → head ${codeSpan(m.head.slice(0, 12))} in ${codeSpan(m.repository)}`);
  if (report.sources.length > 0) {
    const sources = report.sources.map((s) => `${codeSpan(s.id)}${s.author ? ` by ${codeSpan(s.author)}` : ""}`);
    out.push(`Intent from ${sources.join(", ")}`);
  }
  // Whoever answers the judgments decides this report, so an endpoint other than the default is
  // said where a reader of the summary sees it, not only in the section at the end.
  if (report.sent.endpoint !== undefined && report.sent.endpoint !== CLOUDFLARE_ORIGIN) {
    out.push(`Judged by ${codeSpan(report.sent.endpoint)}, not ${codeSpan(CLOUDFLARE_ORIGIN)}`);
  }
  out.push("");

  if (report.requirements.length > 0) {
    out.push("## Requirements", "");
    for (const result of report.requirements) out.push(...requirementSection(report, result));
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

  const d = report.discovery;
  const count = (status: Status) => report.requirements.filter((r) => r.status === status).length;
  out.push("## Coverage", "");
  out.push(
    `- Requirements: ${report.requirements.length} · verified ${count("verified")} · violation ${count("violation")} · unknown ${count("unknown")} · not applicable ${count("not_applicable")}`,
  );
  out.push(`- Repository candidates examined: ${d.candidateCount} (in changed files ${d.changedCandidates}, in unchanged files ${d.unchangedCandidates})`);
  for (const reason of d.incompleteReasons) out.push(`- Incomplete: ${note(reason)}`);
  for (const text of m.notes) out.push(`- ${note(text)}`);
  out.push("");

  out.push("## Sent to the judgment model", "");
  out.push(`- ${plural(report.sent.requests, "request")}, ${report.sent.bytes.toLocaleString("en-US")} bytes, model ${codeSpan(m.model)}, questions ${codeSpan(m.questionsHash)}, config ${codeSpan(m.configSource)}`);
  if (report.sent.endpoint !== undefined) out.push(`- Endpoint: ${codeSpan(report.sent.endpoint)}`);
  if (report.sent.locations.length > 0) {
    out.push("", `<details><summary>${plural(report.sent.locations.length, "location")} sent</summary>`, "");
    for (const location of report.sent.locations) out.push(`- ${where(location)}`);
    out.push("", "</details>");
  }
  out.push("");
  return out.join("\n");
}

export function renderJson(report: ReviewReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
