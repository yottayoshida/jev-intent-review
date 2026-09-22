// From intent text to requirements (spec §9), with no model: the forms an author writes are read as
// written (ADR 0004, `docs/writing-requirements.md`). Each source is read on its own, and a source
// in none of the forms is named with the reason, never guessed at. The model that once wrote
// requirements from prose is gone; the reading of its JSON further down is kept only because the
// saved bench logs were produced with it.

import { cut, redact } from "../evidence/redact.ts";
import { ProviderError, type JevClient } from "../judgments/client.ts";
import { EXIT, REQUIREMENT_KINDS, ToolError, type Ambiguity, type IntentSource, type IntentSpec, type Requirement } from "../types.ts";
import { MAX_REQUIREMENT_CHARS, validateIntentSpec } from "./schema.ts";

/** Kept for a caller that supplies its own; nothing in this repository implements it any more. */
export interface IntentCompiler {
  readonly name: string;
  compile(sources: IntentSource[]): Promise<IntentSpec>;
}

const MAX_REQUIREMENTS = 20;
/** How many of one source's left-out items are quoted; past it they are counted. */
const MAX_LEFT_OUT_SHOWN = 20;

// Every pattern below is anchored and bounded, or replaced by a loop, so reading stays linear in the
// length of a text someone else wrote: a pull request's description is up to 65,536 characters.

// The words a requirements section is headed with. The whole heading has to be one of them —
// "requirements.txt was bumped" is a sentence, not a heading.
const SECTION_WORDS = new Set(["acceptance criteria", "acceptance", "requirements", "definition of done", "done when", "受け入れ条件", "要件", "完了条件"]);
const ATX = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const ITEM_START = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const TASK_BOX = /^\[[ xX]\]\s+/;
const QUOTE = /^ {0,3}>/;
// A paragraph that begins with the label: `Property:`, `**Property** —`, `Property —`,
// `Property (added here):`, `**Property** (from docs/cli.md):`, `**Property:**`. A dash needs a
// space on both sides, so "Property-based testing" is not one.
const PROPERTY = /^ {0,3}(?:\*\*|__)?Property(?:\*\*|__)?(?: ?\([^)\n]{1,200}\))?(?:\*\*|__)?(?:[:：](?:\*\*|__)?| +(?:—|–|-{1,2}) )/;
const FENCE = /^(`{3,}|~{3,})/;
const LABEL = /^\[((?:\\.|[^\\[\]\n]){1,999})\]:/;
// Characters that display as nothing: Unicode's default-ignorable code points (zero-width spaces and
// joiners, direction controls, tag characters, variation selectors, fillers, the ranges reserved for
// more of them), format characters, and the braille blank. On the page they are invisible, so
// nothing written in them is a requirement a reader could have seen.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** `text` without the characters in `chars` at either end. A loop: `/[…]+$/` is quadratic. */
function strip(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start] as string)) start += 1;
  while (end > start && chars.includes(text[end - 1] as string)) end -= 1;
  return text.slice(start, end);
}

/** The column `text` ends at, a tab moving to the next multiple of four. */
function column(text: string): number {
  let at = 0;
  for (const c of text) at = c === "\t" ? at - (at % 4) + 4 : at + 1;
  return at;
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n += 1;
  return column(line.slice(0, n));
}

/** Where a line's content starts: after its indentation and any list or quote markers. */
function contentStart(line: string): number {
  let at = 0;
  for (;;) {
    while (at < line.length && (line[at] === " " || line[at] === "\t")) at += 1;
    const marker = /^(?:(?:[-*+]|\d{1,9}[.)])(?=[ \t])|>)/.exec(line.slice(at, at + 12));
    if (!marker) return at;
    at += marker[0].length;
  }
}

function isThematicBreak(line: string): boolean {
  if (indentOf(line) > 3) return false;
  const marks = line.replace(/[ \t]/g, "");
  return marks.length >= 3 && /^(?:-+|\*+|_+)$/.test(marks);
}

function isSectionHeading(line: string): boolean {
  // Indented code, a list item (`* Requirements`) and a quotation are not headings.
  if (/^ {4}/.test(line) || ITEM_START.test(line) || QUOTE.test(line)) return false;
  const withoutHashes = line.trimStart().replace(/^#{1,6}/, "");
  return SECTION_WORDS.has(strip(withoutHashes, " \t*_:：").toLowerCase());
}

/** A heading of either kind: `## …`, or a line that is nothing but bold text (`**Scope:**`). */
function isHeading(line: string): boolean {
  if (ATX.test(line)) return true;
  const t = strip(line, " \t:：");
  return t.length > 4 && t.startsWith("**") && t.endsWith("**") && !t.slice(2, -2).includes("*");
}

/** `## …` is level 2; a heading made of bold text, or of the word alone, ranks below every `#` level. */
function headingLevel(line: string): number {
  return (ATX.exec(line)?.[1] as string | undefined)?.length ?? 7;
}

/** Whether a line starts a block, which ends a paragraph an HTML comment was opened in. */
function startsBlock(line: string): boolean {
  return line.trim() === "" || ITEM_START.test(line) || ATX.test(line) || QUOTE.test(line) || isThematicBreak(line) || FENCE.test(line.slice(contentStart(line)));
}

/** A block opened inside a quotation or a list item ends with it; a code block or comment at the top level does not. */
interface Container {
  quoted: boolean;
  indent: number; // a list item's content column, 0 outside one
}

/** What a block opened at `start` of `line` is inside, given the content columns of the list items open around it. */
function containerAt(line: string, start: number, list: readonly number[]): Container {
  const prefix = line.slice(0, start);
  if (prefix.includes(">")) return { quoted: true, indent: 0 };
  if (prefix.trim() !== "") return { quoted: false, indent: column(prefix) }; // opened on the item's own line
  const innermost = list.at(-1) ?? 0;
  return { quoted: false, indent: innermost > 0 && column(prefix) >= innermost ? innermost : 0 };
}

/** Whether `line` is past the end of `c`: a quotation ends at a line without `>`, a list item at one less indented than its content. */
function containerEnded(c: Container, line: string): boolean {
  if (c.quoted) return !QUOTE.test(line);
  return c.indent >= 2 && line.trim() !== "" && indentOf(line) < c.indent;
}

/**
 * The lines of `text` as a reader of the rendered page sees them. Left out: fenced code blocks (their
 * fences included), HTML comments, link reference definitions, and characters that display as
 * nothing. What is inside any of them is not read — a form written there is not a requirement, and
 * hidden words would otherwise go to Jev unseen. Everything else is kept as written.
 *
 * It follows the page, not a shortcut through it: a `<!--` inside a code span is text, and a code
 * span may run onto the next lines of its paragraph; a comment that is not closed before its
 * paragraph ends is text too, unless it began a line, in which case the page hides the rest of the
 * quotation or list item it is in, or everything after it; a comment that runs across lines joins what
 * is before it to what is after it, which is how the page shows them; and a code block inside a
 * quotation or a list item ends with it.
 */
export function visibleLines(text: string): string[] {
  const raw = text.replace(/\r\n?/g, "\n").replace(INVISIBLE, "").split("\n");
  // Read once, so that no question below rescans the text: every backtick run by its length, in text
  // order, and for each line the first line at or after it that starts a block.
  const runs = new Map<number, [line: number, index: number][]>();
  raw.forEach((line, i) => {
    for (const m of line.matchAll(/`+/g)) {
      const same = runs.get(m[0].length) ?? [];
      same.push([i, m.index]);
      runs.set(m[0].length, same);
    }
  });
  const blockFrom: number[] = new Array<number>(raw.length + 1).fill(raw.length);
  for (let i = raw.length - 1; i >= 0; i--) blockFrom[i] = startsBlock(raw[i] as string) ? i : (blockFrom[i + 1] as number);
  /**
   * Where the code span that the run of `length` backticks at `line`:`index` opens ends — [line, index
   * after its closing run] — or null when it opens none: the next run of that length, on the same line
   * or a later one of its paragraph.
   */
  const spanEnd = (length: number, line: number, index: number): [number, number] | null => {
    const same = runs.get(length) ?? [];
    let lo = 0;
    let hi = same.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const [l, x] = same[mid] as [number, number];
      if (l < line || (l === line && x <= index)) lo = mid + 1;
      else hi = mid;
    }
    const next = same[lo];
    return next && (next[0] === line || next[0] < (blockFrom[line + 1] as number)) ? [next[0], next[1] + length] : null;
  };

  const shown: string[] = [];
  let fence: { char: string; length: number; container: Container } | null = null;
  let noCloseBefore = -1; // an inline `<!--` found no `-->` in its paragraph, which ends before this line
  const list: number[] = []; // content columns of the list items open around the current line
  let blankSince = false;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] as string;
    if (fence) {
      if (!containerEnded(fence.container, line)) {
        const t = strip(fence.container.quoted ? line.slice(contentStart(line)) : line, " \t");
        if (t.length >= fence.length && [...t].every((c) => c === fence?.char)) fence = null;
        shown.push("");
        continue;
      }
      fence = null;
    }
    // Which list items this line is in. A line wrapped lazily into an item stays in it.
    if (line.trim() === "") blankSince = true;
    else {
      const item = isThematicBreak(line) ? null : ITEM_START.exec(line);
      if (item || blankSince || QUOTE.test(line) || ATX.test(line)) while ((list.at(-1) ?? -1) > indentOf(line)) list.pop();
      if (item) list.push(column(item[0]));
      blankSince = false;
    }
    const start = contentStart(line);
    const opening = FENCE.exec(line.slice(start));
    if (opening && !(opening[1]?.startsWith("`") && line.slice(start + (opening[1] as string).length).includes("`"))) {
      fence = { char: (opening[1] as string)[0] as string, length: (opening[1] as string).length, container: containerAt(line, start, list) };
      shown.push("");
      continue;
    }
    // The line with its comments taken out, the lines a comment ran across joined to it, and the lines
    // a code span ran onto kept as they are.
    let at = i;
    let current = line;
    let blockAt = start; // where a comment would begin a block rather than sit in a paragraph
    let noCloseOnLine = false;
    let out = "";
    let copied = 0; // what is before this on the current line is in `out`, or was a comment
    let pos = 0; // where to look for the next code span or comment
    const token = /`+|<!--/g;
    for (;;) {
      token.lastIndex = pos;
      const m = token.exec(current);
      if (!m) {
        out += current.slice(copied);
        break;
      }
      if (m[0].startsWith("`")) {
        const end = spanEnd(m[0].length, at, m.index);
        if (end === null) {
          pos = m.index + m[0].length; // opens no code span: shown as written
          continue;
        }
        if (end[0] !== at) {
          // The span runs onto later lines of its paragraph: they are shown as they are.
          shown.push(out + current.slice(copied));
          for (let j = at + 1; j < end[0]; j++) shown.push(raw[j] as string);
          at = end[0];
          current = raw[at] as string;
          blockAt = -1;
          noCloseOnLine = false;
          out = "";
          copied = 0;
        }
        pos = end[1];
        continue;
      }
      const block = m.index === blockAt;
      // Where the comment ends: [line, index after `-->`], or null when it is not a comment at all.
      let close: [number, number] | null = null;
      const sameLine = noCloseOnLine ? -1 : current.indexOf("-->", m.index + 4);
      if (sameLine !== -1) close = [at, sameLine + 3];
      else {
        noCloseOnLine = true;
        if (block) {
          const container = containerAt(current, blockAt, list);
          let j = at + 1;
          for (; j < raw.length; j++) {
            const next = raw[j] as string;
            if (containerEnded(container, next)) break;
            const end = next.indexOf("-->");
            if (end !== -1) {
              close = [j, end + 3];
              break;
            }
          }
          close ??= [j - 1, (raw[j - 1] as string).length];
        } else if (at >= noCloseBefore) {
          let j = at + 1;
          for (; j < (blockFrom[at + 1] as number); j++) {
            const end = (raw[j] as string).indexOf("-->");
            if (end !== -1) {
              close = [j, end + 3];
              break;
            }
          }
          if (close === null) noCloseBefore = j;
        }
      }
      if (close === null) {
        pos = m.index + 4; // not a comment: shown as written
        continue;
      }
      out += current.slice(copied, m.index);
      if (close[0] !== at) {
        at = close[0];
        current = raw[at] as string;
        blockAt = -1;
        noCloseOnLine = false;
      }
      pos = close[1];
      copied = close[1];
    }
    shown.push(out);
    i = at;
  }
  return withoutReferenceDefinitions(shown);
}

/**
 * The index of the closing quote of a link title that opens at `lines[i][from]`, running across
 * lines but not across a blank one, with nothing after it on its line: [line, index], or null.
 */
function titleEnd(lines: string[], i: number, from: number): [number, number] | null {
  const open = (lines[i] as string)[from] as string;
  const closer = open === "(" ? ")" : open;
  for (let j = i, at = from + 1; j < lines.length; j++, at = 0) {
    const line = lines[j] as string;
    if (j > i && startsBlock(line)) return null; // a title does not run into the next block
    for (let k = at; k < line.length; k++) {
      if (line[k] === "\\") k += 1;
      else if (line[k] === closer) return line.slice(k + 1).trim() === "" ? [j, k] : null;
    }
  }
  return null;
}

/**
 * The last line of the link reference definition that begins at `lines[i][from]` (`[x]: /url "title"`),
 * or -1 if none does. A footnote (`[^1]:`) is shown on the page and is not one; nor is a line whose
 * destination is followed by anything but a title (`[Note]: this must hold` is a sentence).
 */
function referenceDefinitionEnd(lines: string[], i: number, from: number): number {
  const line = lines[i] as string;
  const label = LABEL.exec(line.slice(from));
  if (!label || (label[1] as string).startsWith("^") || (label[1] as string).trim() === "") return -1;
  let j = i;
  let text = line;
  let at = from + label[0].length;
  while (at < text.length && (text[at] === " " || text[at] === "\t")) at += 1;
  if (at === text.length) {
    // The destination may start the next line.
    j = i + 1;
    text = lines[j] ?? "";
    if (startsBlock(text)) return -1;
    at = text.length - text.trimStart().length;
  }
  if (text[at] === "<") {
    const close = text.indexOf(">", at);
    if (close === -1 || text.slice(at + 1, close).includes("<")) return -1;
    at = close + 1;
  } else {
    while (at < text.length && text[at] !== " " && text[at] !== "\t") at += 1;
  }
  const afterDestination = at;
  while (at < text.length && (text[at] === " " || text[at] === "\t")) at += 1;
  if (at === text.length) {
    // A title may be on the next line; if what is there is not one, the definition ends here.
    const next = lines[j + 1] ?? "";
    const t = next.length - next.trimStart().length;
    if (`"'(`.includes(next[t] ?? "x") && !startsBlock(next)) {
      const end = titleEnd(lines, j + 1, t);
      if (end) return end[0];
    }
    return j;
  }
  if (at === afterDestination || !`"'(`.includes(text[at] as string)) return -1;
  const end = titleEnd(lines, j, at);
  return end ? end[0] : -1;
}

/** `lines` with each link reference definition blanked, where one can stand: at the start of a block. */
function withoutReferenceDefinitions(lines: string[]): string[] {
  const out = [...lines];
  let blockStart = true;
  for (let i = 0; i < out.length; i++) {
    const line = out[i] as string;
    const start = contentStart(line);
    const marked = start > 0 && line.slice(0, start).trim() !== ""; // a list or quote marker opens a block
    if ((blockStart || marked) && line.trim() !== "") {
      const end = referenceDefinitionEnd(out, i, start);
      if (end !== -1) {
        for (let j = i; j <= end; j++) out[j] = "";
        i = end;
        blockStart = true; // another definition may follow
        continue;
      }
    }
    blockStart = line.trim() === "" || ATX.test(line) || isThematicBreak(line);
  }
  return out;
}

/** Words joined as they would be read: every run of whitespace, line breaks included, is one space. */
function joined(parts: string[]): string {
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

interface Found {
  line: number;
  text: string;
}

/**
 * Items of a requirements section, one requirement per item, and the lines they took. An item is what
 * the page shows in it: lines that wrap onto the next, and, after a blank line, paragraphs indented
 * under it. A nested item is an item of its own. The section runs to a heading of its own level or
 * above — a deeper one (`### Errors` under `## Acceptance criteria`) continues it. A paragraph after
 * its list ends it; one before the list is its lead-in.
 */
function sectionItems(lines: string[]): { found: Found[]; used: Set<number>; emptySection: boolean } {
  const found: Found[] = [];
  const used = new Set<number>();
  let level = 0; // the section's heading level, 0 outside one
  let seenItem = false;
  let emptySection = false;
  let sectionStart = 0; // how many items there were when this section began
  let current: { line: number; content: number; parts: string[]; afterBlank: boolean } | null = null;
  const close = () => {
    // An item with nothing displayed in it — a template's `- <!-- one per item -->` left as it was — is
    // no item at all, not one "too short to check".
    const text = current ? joined(current.parts) : "";
    if (current && text !== "") found.push({ line: current.line, text });
    current = null;
  };
  const leave = () => {
    close();
    // Empty means nothing displayed was listed: no items, or only items that were blank.
    if (level > 0 && found.length === sectionStart) emptySection = true;
    level = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (isSectionHeading(line)) {
      if (level > 0 && headingLevel(line) > level) close();
      else {
        leave();
        level = headingLevel(line);
        sectionStart = found.length;
      }
      seenItem = false;
      continue;
    }
    if (level === 0) continue;
    if (isThematicBreak(line)) {
      close();
      continue;
    }
    if (line.trim() === "") {
      if (current) (current as { afterBlank: boolean }).afterBlank = true;
      continue;
    }
    const start = ITEM_START.exec(line);
    if (start) {
      close();
      current = { line: i, content: column(start[0]), parts: [line.slice(start[0].length).replace(TASK_BOX, "")], afterBlank: false };
      used.add(i);
      seenItem = true;
      continue;
    }
    if (isHeading(line)) {
      if (headingLevel(line) > level) {
        close();
        seenItem = false;
      } else leave();
      continue;
    }
    const item = current as { content: number; parts: string[]; afterBlank: boolean } | null;
    // After a blank line only what is indented under the item is still in it; without one, a line
    // wraps into it unless it starts a quotation of its own.
    if (item && (indentOf(line) >= item.content || (!item.afterBlank && !QUOTE.test(line)))) {
      item.parts.push(line);
      item.afterBlank = false;
      used.add(i);
      continue;
    }
    close();
    if (seenItem) leave();
  }
  leave();
  return { found, used, emptySection };
}

/**
 * Each paragraph that begins with the `Property` label, without the label, to a blank line, a
 * heading, a list or a quotation. The label counts only where a paragraph begins — a line wrapped
 * into a list item or another paragraph is part of that — and a line a requirements section already
 * took is not read twice.
 */
function propertyParagraphs(lines: string[], used: Set<number>): Found[] {
  const found: Found[] = [];
  let atStart = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "" || isHeading(line) || isThematicBreak(line)) {
      atStart = true;
      continue;
    }
    const mark = atStart && !used.has(i) ? PROPERTY.exec(line) : null;
    if (!mark) {
      atStart = false;
      continue;
    }
    const parts = [line.slice(mark[0].length)];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j] as string;
      if (used.has(j) || next.trim() === "" || isHeading(next) || isThematicBreak(next) || ITEM_START.test(next) || QUOTE.test(next) || PROPERTY.test(next)) break;
      parts.push(next);
    }
    const text = joined(parts);
    if (text !== "") found.push({ line: i, text });
    i = j - 1;
    atStart = true; // the next line, if it has the label, begins a paragraph of its own
  }
  return found;
}

// A person wrote these under an explicit heading, so the bar is lower than for a model's output:
// "Rate limit logins" (three words) is a criterion. A single word is not, and is recorded, not lost.
const MIN_ITEM_WORDS = 2;

export const NOT_IN_A_FORM = "no requirements section (Acceptance criteria, Acceptance, Requirements, Definition of done, Done when) and no Property: paragraph";

export interface Unread {
  sourceId: string;
  type: IntentSource["type"];
  reason: string;
}

export interface Reading {
  /** The requirements read, and in `ambiguities` every source not read and everything left out. */
  spec: IntentSpec;
  unread: Unread[];
  /** Requirements read past the first `MAX_REQUIREMENTS`, by source: named, and not checked. */
  notChecked: { sourceId: string; count: number }[];
}

/**
 * Requirements read from each source's forms, as written: the items of a requirements section and
 * each `Property` paragraph. Sources are read in order of authority, so the first
 * `MAX_REQUIREMENTS` are from the highest sources — with the default `intent.prefer_issue`, the
 * issue's before the pull request's. Nothing is cut: a requirement over the length limit is left
 * out and said to be.
 */
export function readRequirements(sources: IntentSource[]): Reading {
  const ordered = sources.filter((s) => s.type !== "spec").sort((a, b) => b.authority - a.authority);
  const unread: Unread[] = [];
  const leftOut: { sourceId: string; text: string }[] = [];
  const taken: { source: IntentSource; text: string }[] = [];
  for (const source of ordered) {
    const lines = visibleLines(source.text);
    const sections = sectionItems(lines);
    const found = [...sections.found, ...propertyParagraphs(lines, sections.used)].sort((a, b) => a.line - b.line);
    if (found.length === 0) {
      unread.push({ sourceId: source.id, type: source.type, reason: sections.emptySection ? "its requirements section lists no items" : NOT_IN_A_FORM });
      continue;
    }
    const seen = new Set<string>();
    const left: string[] = [];
    let kept = 0;
    for (const f of found) {
      if (seen.has(f.text)) continue;
      seen.add(f.text);
      if (f.text.length > MAX_REQUIREMENT_CHARS) left.push(`A requirement of ${f.text.length} characters, over the limit of ${MAX_REQUIREMENT_CHARS}, was left out rather than cut: ${f.text.slice(0, 200)}`);
      else if (!isStatement(f.text, MIN_ITEM_WORDS)) left.push(`A listed item too short to check was left out: ${f.text.slice(0, 200)}`);
      else {
        taken.push({ source, text: f.text });
        kept += 1;
      }
    }
    // Quoted up to a point and counted past it: a text of one-word items is not a report of thousands of lines.
    for (const text of left.slice(0, MAX_LEFT_OUT_SHOWN)) leftOut.push({ sourceId: source.id, text });
    if (left.length > MAX_LEFT_OUT_SHOWN) leftOut.push({ sourceId: source.id, text: `${left.length - MAX_LEFT_OUT_SHOWN} more items were left out the same ways.` });
    if (kept === 0) unread.push({ sourceId: source.id, type: source.type, reason: "everything it states in a requirements form was left out (see below)" });
  }
  const over = new Map<string, number>();
  for (const t of taken.slice(MAX_REQUIREMENTS)) over.set(t.source.id, (over.get(t.source.id) ?? 0) + 1);
  const notChecked = [...over].map(([sourceId, count]) => ({ sourceId, count }));
  // Sources not read and requirements not checked first: a report that shows only so many lines
  // still shows those, ahead of the items each source left out.
  const ambiguities: Ambiguity[] = [
    ...unread.map((u) => ({ text: `${u.sourceId} was not read as requirements: ${u.reason}.`, sourceRefs: [] })),
    ...(notChecked.length > 0
      ? [{ text: `${taken.length - MAX_REQUIREMENTS} requirements beyond the first ${MAX_REQUIREMENTS} were not checked: ${notChecked.map((n) => `${n.count} from ${n.sourceId}`).join(", ")}`, sourceRefs: [] }]
      : []),
    ...leftOut.map((l) => ({ text: `${l.sourceId}: ${l.text}`, sourceRefs: [] })),
  ].map((a, n) => ({ id: `A${n + 1}`, ...a }));
  return {
    spec: {
      version: 1,
      title: "",
      summary: "",
      requirements: taken.slice(0, MAX_REQUIREMENTS).map(({ source, text }, i) => ({
        id: `R${i + 1}`,
        text,
        kind: "behavior",
        priority: "required",
        sourceRefs: [{ sourceId: source.id, quote: text }],
        searchHints: [],
      })),
      nonGoals: [],
      ambiguities,
    },
    unread,
    notChecked,
  };
}

/** Whether every requirement read came from the pull request's own description. */
export function onlyFromPullRequest(spec: IntentSpec, sources: IntentSource[]): boolean {
  const type = new Map(sources.map((s) => [s.id, s.type]));
  return spec.requirements.length > 0 && spec.requirements.every((r) => r.sourceRefs.length > 0 && r.sourceRefs.every((ref) => type.get(ref.sourceId) === "pr_description"));
}

/**
 * Sources that were not read and that no source which was read outranks (SPEC §28): an issue in prose
 * beside a pull request whose `Property` was read, or beside another issue whose list was. Checking
 * what was read while intent as high went unread is not a review of that intent.
 */
export function unreadNotOutranked(reading: Reading, sources: IntentSource[]): Unread[] {
  const authority = new Map(sources.map((s) => [s.id, s.authority]));
  const readFrom = new Set(reading.spec.requirements.flatMap((r) => r.sourceRefs.map((ref) => ref.sourceId)));
  if (readFrom.size === 0) return [];
  const highest = Math.max(...[...readFrom].map((id) => authority.get(id) ?? 0));
  return reading.unread.filter((u) => (authority.get(u.sourceId) ?? 0) >= highest);
}

/**
 * What the review cannot stand on after reading (ADR 0004), each a reason no verdict can overcome: a
 * source as high as anything read and itself unread, and requirements read past the first twenty,
 * which were not checked.
 */
export function readingBlockers(reading: Reading, sources: IntentSource[]): string[] {
  return [
    ...unreadNotOutranked(reading, sources).map((u) => `${u.sourceId}, which no source that was read outranks, was not read as requirements (${u.reason})`),
    ...reading.notChecked.map((n) => `${n.count} requirement(s) from ${n.sourceId} were read past the first ${MAX_REQUIREMENTS} and not checked`),
  ];
}

/**
 * Case, runs of whitespace, Markdown marks (`code`, *emphasis*), curly quotes and trailing
 * punctuation do not count against a quote. Measured: every item of a real issue written in
 * Markdown was dropped because the model quoted it without its backticks.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*~]|(?<!\w)_|_(?!\w)/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.。!?:;,]+$/, "");
}

// Japanese, Chinese and Korean are written without spaces between words, so length there is
// counted in characters, roughly two to three per word.
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
function wordCount(text: string): number {
  const t = text.trim();
  if (CJK.test(t)) return Math.floor(t.replace(/\s+/g, "").length / 2.5);
  return t.split(/\s+/).filter((w) => w !== "").length;
}

/**
 * A quote holds a requirement only if it is part of a statement (three words or more) and appears
 * in the text. Measured: the model once returned field names as requirements ("kind") quoting
 * fragments like "remediation_hint", which a bare substring test accepted.
 */
export function quoteIsIn(quote: string, text: string): boolean {
  const q = normalise(quote);
  return wordCount(q) >= 3 && normalise(text).includes(q);
}

/** A requirement the model wrote is a sentence, not a word: four words or more. */
export function isStatement(text: string, minWords = 4): boolean {
  return wordCount(text) >= minWords;
}

// The requirements are never written by a model. `readRequirements` above reads the documented
// forms as they are written, and names every source it could not read. What follows is the reading
// of a model's JSON, kept because the saved bench logs were produced with it and their records
// still have to be parsed.

/** The model's JSON, whichever of the gateway's shapes carries it. */
export function readModelJson(payload: unknown): unknown {
  // Cloudflare's REST wraps the model's answer in `result`; a proxy that returns what its own
  // `env.AI.run()` gave it does not. Both are read, so either kind of endpoint works.
  const top = (payload ?? {}) as Record<string, unknown>;
  const result = (typeof top.result === "object" && top.result !== null ? top.result : top) as Record<string, unknown>;
  const choice = (result.choices as { finish_reason?: unknown; message?: { content?: unknown } }[] | undefined)?.[0];
  if (choice?.finish_reason === "length") throw new Error("the model ran out of room before finishing its answer");
  if (typeof result.response === "object" && result.response !== null) return result.response;
  const content = choice?.message?.content ?? result.response;
  if (typeof content !== "string") throw new Error("no answer text in the response");
  try {
    return JSON.parse(content);
  } catch {
    // Not `JSON.parse`'s own message: it quotes the text it choked on, and that text is whatever
    // the endpoint sent, newlines and all, on its way to stderr.
    throw new Error("the answer was not the JSON that was asked for");
  }
}

type Obj = Record<string, unknown>;

/** The model's answer as an IntentSpec, with every requirement whose quote is not in its source dropped. */
/**
 * The model does not always fill the shape it was given: measured over ten real pull requests,
 * every one of 38 requirements came back with its search hints written into the sentence ("…, with
 * search hints: stderr, json object"), nine of them with the record's own field names in front
 * ("kind: behavior, quote: …"), and some with fragments of a serialized structure at the end
 * ("…installed.', 'search_hints': '…'}], {"). Each was then cut to `MAX_REQUIREMENT_CHARS`, which
 * hid the tail and left something that read like a long requirement. The hints never reached the
 * field, so the search fell back to the words of the sentence — including `search_hints`, `quote`
 * and `kind` themselves.
 *
 * What can be read off the sentence is taken (the hints); what is left is a requirement or it is
 * not, and `isStatement` decides that as before.
 */
const FIELD_HEAD = /^\s*kind\s*:\s*\w+\s*,\s*quote\s*:\s*/i;
const HINTS_TAIL = /[,;]?\s*(with\s+)?search[_ ]hints?\s*[:=]\s*(.*)$/is;
// Only a serialized field name reads as debris: `', 'search_hints': …`. A quoted list in an
// ordinary sentence — "accepts 'wrappers', 'syscalls' and rejects everything else" — is the
// requirement, and cutting at the comma took two thirds of that one away.
const DEBRIS = /(['"]\s*,\s*['"]?(?:search_hints|kind|quote|source|text)['"]?\s*:|['"]\s*\}|\}\s*\]|,\s*source\s*:).*$/s;

export function readRequirementText(raw: string, cutAtLimit = false): { text: string; hints: string[] } {
  // A sentence with none of the record's marks on it is the requirement as written: it is handed
  // back untouched, so nothing here can shorten a requirement that was never contaminated.
  if (!cutAtLimit && !FIELD_HEAD.test(raw) && !HINTS_TAIL.test(raw) && !DEBRIS.test(raw)) return { text: raw, hints: [] };
  let text = raw.replace(FIELD_HEAD, "");
  let hints: string[] = [];
  const tail = HINTS_TAIL.exec(text);
  if (tail) {
    hints = (tail[2] ?? "")
      .replace(/^[[\s'"]+|[\]\s'"}]+$/g, "")
      .split(/[,\n]/)
      .map((h) => h.trim().replace(/^['"[\]]+|['"[\]]+$/g, ""))
      .filter((h) => h !== "" && h.length <= 40 && !/^(source|kind|quote)\s*:/i.test(h))
      .slice(0, 4);
    text = text.slice(0, tail.index);
  }
  text = text.replace(DEBRIS, "").trim().replace(/[,;]+$/, "").trim();
  if (!text.endsWith(".")) {
    // Only what this tool cut is cut back: `cutAtLimit` says the answer was longer than the
    // requirement limit, so the tail is a clause that stops mid-word and says nothing. With no
    // earlier sentence to fall back to, it is left open rather than closed with a full stop: the
    // one this repair used to add turned `…and instead report an '未` into something that reads
    // like a finished requirement, which is the same trick the truncation played in the first
    // place. A sentence the model simply left unpunctuated is closed — nothing was lost there.
    const cut = Math.max(text.lastIndexOf(". "), text.lastIndexOf(".\n"));
    if (cutAtLimit) text = cut > 40 ? text.slice(0, cut + 1) : text;
    else text = `${text.replace(/[\s,;-]+$/, "")}.`;
  }
  return { text: text.trim(), hints };
}

export function toSpec(value: unknown, sources: IntentSource[]): IntentSpec {
  const answer = (value && typeof value === "object" ? value : {}) as Obj;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const ambiguities: Ambiguity[] = [];
  const findSource = (sourceId: unknown, quote: string): IntentSource | undefined => {
    const named = typeof sourceId === "string" ? byId.get(sourceId) : undefined;
    if (named && quoteIsIn(quote, named.text)) return named;
    return sources.find((s) => quoteIsIn(quote, s.text));
  };

  const requirements: Requirement[] = [];
  for (const item of Array.isArray(answer.requirements) ? (answer.requirements as Obj[]) : []) {
    const whole = typeof item.text === "string" ? item.text.trim() : "";
    const raw = whole.slice(0, MAX_REQUIREMENT_CHARS);
    const read = readRequirementText(raw, whole.length > MAX_REQUIREMENT_CHARS);
    const text = read.text;
    const quote = typeof item.quote === "string" ? item.quote.trim() : "";
    if (text === "") continue;
    if (!isStatement(text)) {
      ambiguities.push({ id: `A${ambiguities.length + 1}`, text: `Dropped a requirement that is not a sentence: ${text.slice(0, 200)}`, sourceRefs: [] });
      continue;
    }
    const source = findSource(item.source, quote);
    if (!source) {
      ambiguities.push({ id: `A${ambiguities.length + 1}`, text: `Dropped a requirement whose quote is not a statement in any source: ${text.slice(0, 200)}`, sourceRefs: [] });
      continue;
    }
    if (requirements.length >= MAX_REQUIREMENTS) break;
    const kind = REQUIREMENT_KINDS.includes(item.kind as never) ? (item.kind as Requirement["kind"]) : "behavior";
    const given = Array.isArray(item.search_hints) ? (item.search_hints as unknown[]).filter((h): h is string => typeof h === "string" && h.trim() !== "").map((h) => h.trim().slice(0, 100)).slice(0, 4) : [];
    const hints = given.length > 0 ? given : read.hints;
    requirements.push({ id: `R${requirements.length + 1}`, text, kind, priority: "required", sourceRefs: [{ sourceId: source.id, quote: quote.slice(0, 2000) }], searchHints: hints });
  }
  const nonGoals = (Array.isArray(answer.non_goals) ? (answer.non_goals as Obj[]) : [])
    .map((item) => ({ text: typeof item.text === "string" ? item.text.trim().slice(0, MAX_REQUIREMENT_CHARS) : "", quote: typeof item.quote === "string" ? item.quote.trim() : "", source: item.source }))
    .filter((n) => n.text !== "" && findSource(n.source, n.quote))
    .map((n, i) => ({ id: `N${i + 1}`, text: n.text, sourceRefs: [{ sourceId: (findSource(n.source, n.quote) as IntentSource).id, quote: n.quote.slice(0, 2000) }] }));
  for (const item of Array.isArray(answer.ambiguities) ? (answer.ambiguities as Obj[]) : []) {
    if (typeof item.text === "string" && item.text.trim() !== "") ambiguities.push({ id: `A${ambiguities.length + 1}`, text: item.text.trim().slice(0, MAX_REQUIREMENT_CHARS), sourceRefs: [] });
  }
  return validateIntentSpec({ version: 1, title: "", summary: "", requirements, nonGoals, ambiguities: ambiguities.slice(0, 20) }, "acceptance-criteria list, read as written");
}
