// The human-readable report: printed to the terminal and, in GitHub Actions, written to the job
// summary. Everything that comes from the repository, the pull request or a model (paths,
// requirement text, code, author names) is put inside a code span or code block, where GitHub
// renders neither Markdown nor HTML. The result line is drawn from the verdict enum only.

import { redact } from "../evidence/redact.ts";
import { hostName } from "../judgments/client.ts";
import { probabilityOf } from "../review/requirement.ts";
import type { CandidateOutcome, CandidateResult, IntentSource, IntentSpec, Location, ReviewReport, RequirementResult, Status } from "../types.ts";

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

const MARK: Record<CandidateOutcome, string> = {
  satisfies: "✓",
  violates: "✗",
  unknown: "?",
  aside: "·",
};

// VERIFIED is not here: its headline carries the scope it is a claim over (requirementSection).
const HEADLINE: Record<Exclude<Status, "verified">, string> = {
  violation: "VIOLATION",
  unknown: "UNKNOWN",
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function resultLine(report: ReviewReport): string {
  const total = report.requirements.length;
  const count = (status: Status) => report.requirements.filter((r) => r.status === status).length;
  // The paths the requirements were judged over, which is what "no violation found" covers —
  // not every place a judgment was asked about.
  const paths = report.requirements.reduce((n, r) => n + r.scope.paths, 0);
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

/**
 * What the result is a claim over, in the line under it. VERIFIED says how many paths it holds
 * for, and every status says how many places were judged of how many were found, how many were
 * set aside, and how many leads were not followed — a reader who takes the headline alone should
 * at least see the size of what it covers.
 */
function scopeLine(result: RequirementResult): string {
  const s = result.scope;
  const aside = new Map<string, number>();
  for (const c of result.candidates) if (c.outcome === "aside") aside.set(c.aside ?? "set aside", (aside.get(c.aside ?? "set aside") ?? 0) + 1);
  const why = [...aside].map(([kind, n]) => `${n} ${kind.replace(/_/g, " ")}`).join(", ");
  const parts = [`${s.judged} of ${s.found} place(s) judged`, `${s.paths} path(s)`, `${s.setAside} set aside${why ? ` (${why})` : ""}`];
  if (s.notFollowed.length > 0) parts.push(`${s.notFollowed.length} lead(s) not followed`);
  if (s.unjudged.length > 0) parts.push(`${s.unjudged.length} reason(s) places went unjudged`);
  return `Coverage: ${result.coverage} — ${parts.join(", ")}`;
}

function requirementSection(report: ReviewReport, result: RequirementResult): string[] {
  const requirement = report.intent.requirements.find((r) => r.id === result.requirementId);
  const headline = result.status === "verified" ? `VERIFIED over ${plural(result.scope.paths, "discovered path")}` : HEADLINE[result.status];
  const lines = [`### ${result.requirementId} · ${headline}`, "", codeSpan(requirement?.text ?? ""), "", scopeLine(result), ""];
  const shown = result.candidates.filter((c) => c.outcome !== "aside");
  for (const candidate of shown) lines.push(...candidateLine(candidate));
  const hidden = result.candidates.length - shown.length;
  if (hidden > 0) lines.push(`- ${plural(hidden, "other place")} set aside: not a path this requirement holds or fails on`);
  for (const text of result.scope.notFollowed) lines.push(`- Not followed: ${note(text)}`);
  for (const text of result.scope.unjudged) lines.push(`- Not judged: ${note(text)}`);
  for (const text of result.notes) lines.push(`- ${note(text)}`);
  lines.push("");
  return lines;
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
  // The notes stay in Coverage, where every run has always put them.
  out.push(...intentSection(report.intent, report.sources, m.pullRequestAuthor === undefined ? {} : { prAuthor: m.pullRequestAuthor }));

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
    `- Requirements: ${report.requirements.length} · verified ${count("verified")} · violation ${count("violation")} · unknown ${count("unknown")}`,
  );
  out.push(`- Repository candidates examined: ${d.candidateCount} (in changed files ${d.changedCandidates}, in unchanged files ${d.unchangedCandidates})`);
  for (const reason of d.incompleteReasons) out.push(`- Incomplete: ${note(reason)}`);
  for (const text of m.notes) out.push(`- ${note(text)}`);
  out.push("");

  out.push("## Sent to the judgment model", "");
  out.push(`- ${plural(report.sent.requests, "request")}, ${report.sent.bytes.toLocaleString("en-US")} bytes, model ${codeSpan(m.model)}, questions ${codeSpan(m.questionsHash)}, config ${codeSpan(m.configSource)}`);
  if (report.sent.endpoint !== undefined) out.push(`- Endpoint: ${codeSpan(report.sent.endpoint)}${report.sent.host === undefined ? "" : ` (${hostName(report.sent.host)})`}`);
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
