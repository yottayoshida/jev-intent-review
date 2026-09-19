// The other direction (spec §21): not "is every requirement met" but "is every change asked for".
// One question per changed region — the function the change sits in — and only about code: a
// comment, a blank line or an import is left out before anything is asked, and so is a change in
// a file that holds no code or that must never be read at all.
//
// This is the only place that sends the lines as they were *before* the change. A pull request
// that removes a hardcoded key would hand that key to the endpoint, so a sensitive path is
// dropped here as well as in discovery.
//
// What is reported is the excerpt itself, never a sentence about it: a model that writes "this
// changes the session lifetime" is one more thing that can be wrong. The reader sees the lines.

import type { ChangeAnalysis, ChangedRegion } from "../change/seeds.ts";
import { cut, isSensitivePath, redact } from "../evidence/redact.ts";
import { FATAL_KINDS, ProviderError } from "../judgments/cloudflare.ts";
import type { JudgmentProvider } from "../judgments/provider.ts";
import { CHANGE_QUESTIONS } from "../judgments/questions.ts";
import type { ChangeJudgment, Location, Requirement, UnexpectedChange } from "../types.ts";
import { probabilityOf } from "./requirement.ts";

/**
 * A line that changes nothing a requirement could ask for. Every marker needs its delimiter: `#`
 * opens a comment in Python and a directive in C (`#define MAX 3`) and an attribute in Rust
 * (`#[serde(skip)]`), `--` opens a comment in SQL and decrements in C (`--count;`), `*` continues
 * a block comment and dereferences a pointer (`*out = value;`), and `using` imports in C# and
 * opens a scope (`using (var file = ...)`). A line inside a block comment that carries no marker
 * of its own is not recognised: it costs one question, and the README says so.
 */
const NOT_BEHAVIOUR =
  /^\s*(?:$|\/\/|\/\*|\*\/|\*\s|#\s|;;|"""|'''|<!--|-->|--\s|import\s|from\s+\S+\s+import\s|export\s+\{[^}]*\}\s+from\s|@?use\s+[^(]*$|using\s+[^(]*$|require\(|const\s+\{[^}]*\}\s*=\s*require\()/;

/** Whether anything in this region is a change in behaviour that may be asked about. */
export function changesBehaviour(region: ChangedRegion): boolean {
  if (!region.code) return false; // prose and data are changes, but not ones to read this way
  if (isSensitivePath(region.path)) return false; // never read, and its old lines never sent
  return [...region.added, ...region.removed].some((line) => !NOT_BEHAVIOUR.test(line));
}

const JUDGMENT: Record<string, ChangeJudgment> = {
  clearly_required: "required",
  plausibly_required: "supporting",
  unrelated: "unrequested",
  cannot_tell: "cannot_tell",
};

export interface ChangeReviewInput {
  change: ChangeAnalysis;
  requirements: Requirement[];
  provider: JudgmentProvider;
  maxChars: number;
  /** How sure Jev must be that no requirement asked for it, before the report says so. */
  threshold: number;
  trace: (line: string) => void;
}

export interface ChangeReview {
  unexpected: UnexpectedChange[];
  reached: number; // requests the endpoint answered its own way, right or wrong
  answered: number;
  sent: Location[]; // the ranges whose lines went into a packet
  notes: string[];
}

interface Judged {
  unexpected?: UnexpectedChange;
  failure?: ProviderError;
  quiet?: boolean;
}

/**
 * Every changed region that carries behaviour, judged against the requirements. Only the regions
 * Jev calls unasked-for, and is sure enough about, reach the report; the rest are counted in a
 * note, so a reader can tell "nothing to report" from "nothing was looked at". A failure that
 * makes every later request pointless (a refused token, an empty balance, a URL that runs no
 * models) is thrown, as it is on the requirement side.
 */
export async function reviewChanges(input: ChangeReviewInput): Promise<ChangeReview> {
  const regions = input.change.regions.filter(changesBehaviour);
  const left = input.change.regions.length - regions.length;
  const notes: string[] = [];
  if (left > 0) notes.push(`${left} changed region(s) hold no change in behaviour (comments, blank lines, imports, a file with no code, or a path that is never read) and were not judged.`);
  if (regions.length === 0) return { unexpected: [], reached: 0, answered: 0, sent: [], notes };

  let redactions = 0;
  /** `sent: false` for the excerpt: it is shown, not sent, and must not be counted twice. */
  const clean = (text: string, sent = true) => {
    const r = redact(text);
    if (sent) redactions += r.count;
    return cut(r.text, input.maxChars);
  };
  const requirements = input.requirements.map((r) => ({ id: r.id, text: redact(r.text).text }));
  const sent: Location[] = [];
  let reached = 0;
  let answered = 0;

  const judged = await Promise.all(
    regions.map(async (region): Promise<Judged> => {
      const before = clean(region.removed.join("\n"));
      const after = clean(region.added.join("\n"));
      const excerpt = clean([...region.removed.map((l) => `- ${l}`), ...region.added.map((l) => `+ ${l}`)].join("\n"), false);
      const location: Location = { path: region.path, startLine: region.block.startLine, endLine: region.block.endLine };
      const state = {
        requirements,
        change: {
          path: region.path,
          lines: `${location.startLine}-${location.endLine}`,
          ...(region.block.name ? { symbol: region.block.name } : {}),
          before: before.text,
          after: after.text,
        },
      };
      sent.push(location);
      let choice: string;
      let confidence: number;
      try {
        const answer = (await input.provider.judge(state, CHANGE_QUESTIONS)).justification;
        if (!answer) throw new ProviderError("bad_response", "no answer to the change question");
        reached += 1;
        answered += 1;
        choice = answer.choice;
        confidence = probabilityOf(answer, answer.choice);
      } catch (error) {
        // A fault in this tool, and a failure that makes every later request pointless, both
        // belong to the caller: only an answer this pass can do something with stays here.
        if (!(error instanceof ProviderError) || FATAL_KINDS.has(error.kind)) throw error;
        if (error.kind !== "budget") reached += 1;
        return { failure: error };
      }
      const judgment = JUDGMENT[choice] ?? "cannot_tell";
      input.trace(`change ${region.path}:${state.change.lines} ${choice} ${confidence.toFixed(2)} -> ${judgment}`);
      if (judgment !== "unrequested" || confidence < input.threshold) return { quiet: true };
      return {
        unexpected: {
          id: "",
          location,
          excerpt: excerpt.text,
          judgment,
          mappedRequirements: [],
          confidence,
          notes: before.truncated || after.truncated || excerpt.truncated ? ["the change was longer than the packet and was cut"] : [],
        },
      };
    }),
  );

  const failures = judged.map((j) => j.failure).filter((f): f is ProviderError => f !== undefined);
  // One kind of failure, said once: a hundred regions must not write a hundred identical lines.
  for (const kind of new Set(failures.map((f) => f.kind))) {
    notes.push(`${failures.filter((f) => f.kind === kind).length} change(s) could not be judged (${kind}).`);
  }
  const quiet = judged.filter((j) => j.quiet).length;
  if (quiet > 0) notes.push(`${quiet} changed region(s) were judged and are not shown: a requirement asks for them, or Jev was not sure enough that none does.`);
  if (redactions > 0) notes.push(`${redactions} secret-shaped value(s) were redacted from the changes before sending.`);
  // Numbered after the ones that are shown are known, so the report has C1, C2, C3 and no gaps.
  const unexpected = judged.map((j) => j.unexpected).filter((u): u is UnexpectedChange => u !== undefined).map((u, i) => ({ ...u, id: `C${i + 1}` }));
  return { unexpected, reached, answered, sent, notes };
}
