// The sentences of the issues in `issues/`, as the bench asks about them (#40, part 2).
//
//   node bench/sentence-choice/units.ts           rewrite units.json from issues/
//   node bench/sentence-choice/units.ts --check   exit 1 if units.json is not what issues/ gives
//
// A unit is one sentence and what a reader sees around it: the issue's title, the heading it sits
// under, the line that leads into it, and its paragraph. Jev is shown exactly that, and never the
// rest of the issue. The annotators who label it read the same fields, with the unit's id and the
// other units of their share beside it (annotate.ts, docs/writing-requirements.md).
//
// 1. Visible lines only: the product's visibleLines (comments, code blocks, reference definitions
//    and characters that display as nothing are left out). Code is not shown to Jev or to the
//    annotators, as the product would not read it either.
// 2. Skipped lines: headings, table rows, lines that are only bold text or only an HTML tag, and
//    checklist items (`- [ ]`, `- [x]`), which are template boilerplate. A bold-only line is taken as
//    a heading.
// 3. Paragraphs: consecutive lines joined with spaces (hard wraps undone); a list item starts a
//    paragraph of its own; a blank line or a heading ends one. `>` markers are dropped.
// 4. The lead-in of a list item is the plain paragraph before the list; the lead-in of a paragraph is
//    the paragraph before it when that one ends with a colon.
// 5. Sentences: a paragraph is split after `.`, `!` or `?` followed by space and an upper-case letter,
//    a quote, a backtick or a bracket — except after a few abbreviations (e.g., i.e., etc., vs.).
// 6. A sentence of fewer than two words is not a unit (as for a requirements item).
//
// The minimum was four words when the issues were collected; it was lowered to two after the
// collecting agents had read the bodies, and before any label or answer existed, because four
// dropped short statements of the wanted behaviour ("No errors", "Run without crashing."). The
// collection's stopping rule was applied again, in the same order, with this count.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visibleLines } from "../../src/intent/compiler.ts";

export interface Issue {
  issue: string; // owner/repo#N
  url: string;
  title: string;
  author: string;
  createdAt: string;
  closedBy: string;
  body: string;
}

export interface Unit {
  id: string; // owner/repo#N:k, k counting from 1 within the issue
  issue: string;
  title: string;
  heading: string;
  leadIn: string;
  paragraph: string;
  sentence: string;
}

const ATX = /^ {0,3}#{1,6}(?:\s|$)/;
const ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const CHECKLIST = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]/;
const BOLD_ONLY = /^\*\*[^*]+\*\*:?$/;
const ABBREVIATION = /(?:\be\.g|\bi\.e|\betc|\bvs|\bcf|\bapprox|\bNo)\.$/i;
const MIN_WORDS = 2;

/** The sentences of one paragraph. */
export function sentences(paragraph: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const m of paragraph.matchAll(/[.!?](?=\s+["'`(\[A-Z])/g)) {
    const end = (m.index as number) + 1;
    if (ABBREVIATION.test(paragraph.slice(Math.max(0, end - 8), end))) continue;
    parts.push(paragraph.slice(start, end).trim());
    start = end;
  }
  parts.push(paragraph.slice(start).trim());
  return parts.filter((p) => p !== "");
}

/** The units of one issue, in the order they appear. */
export function unitsOf(issue: Issue): Unit[] {
  const out: Unit[] = [];
  let heading = "";
  let listLeadIn = "";
  let previous = ""; // the plain paragraph before the current one
  let current: string[] = [];
  let isItem = false;
  const flush = () => {
    const paragraph = current.join(" ").replace(/\s+/g, " ").trim();
    current = [];
    if (paragraph === "") return;
    const leadIn = isItem ? listLeadIn : previous.endsWith(":") ? previous : "";
    for (const sentence of sentences(paragraph)) {
      if (sentence.split(/\s+/).length < MIN_WORDS) continue;
      out.push({ id: `${issue.issue}:${out.length + 1}`, issue: issue.issue, title: issue.title, heading, leadIn, paragraph, sentence });
    }
    if (!isItem) previous = paragraph;
  };
  for (const raw of visibleLines(issue.body)) {
    const line = raw.replace(/^\s{0,3}>\s?/, "");
    const t = line.trim();
    if (t === "") {
      flush();
      continue;
    }
    if (ATX.test(line)) {
      flush();
      heading = t.replace(/^#+\s*/, "").replace(/\s*#+$/, "");
      previous = "";
      continue;
    }
    if (t.startsWith("|") || BOLD_ONLY.test(t) || /^<[^>]+>$/.test(t) || CHECKLIST.test(line)) {
      flush();
      if (BOLD_ONLY.test(t)) {
        heading = t.replace(/\*\*/g, "").replace(/:$/, "");
        previous = "";
      }
      continue;
    }
    if (ITEM.test(line)) {
      flush();
      if (!isItem) listLeadIn = previous;
      isItem = true;
      current.push(line.replace(ITEM, ""));
      continue;
    }
    // A line after an item's first line continues the item; otherwise it starts or continues a
    // plain paragraph.
    if (current.length === 0) isItem = false;
    current.push(t);
  }
  flush();
  return out;
}

const HERE = import.meta.dirname;

export function readIssues(): Issue[] {
  const dir = join(HERE, "issues");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Issue);
}

export function allUnits(): Unit[] {
  return readIssues().flatMap(unitsOf);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = `${JSON.stringify(allUnits(), null, 1)}\n`;
  const path = join(HERE, "units.json");
  if (process.argv.includes("--check")) {
    const same = readFileSync(path, "utf8") === text;
    console.log(same ? "units.json is what issues/ gives" : "units.json differs from what issues/ gives");
    process.exitCode = same ? 0 : 1;
  } else {
    writeFileSync(path, text);
    console.log(`${JSON.parse(text).length} units`);
  }
}
