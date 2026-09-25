// What the change touched, as search seeds (spec §11). This stage never decides review scope.
//
// The seed that finds missed paths is a call made *around* the changed lines, not on them. A pull
// request that adds `if (!account.active) throw ...` to one sign-in function does not mention
// the call it guards on the added line, but the function it edited calls it; every other caller of
// that call is a place the same check may be missing.

import type { Git } from "../repository/git.ts";
import { BlockIndex, definedName, looksLikeHeader, type Block } from "./blocks.ts";
import { parseDiff, type FileChange } from "./diff.ts";

export interface ChangedRegion {
  path: string;
  code: boolean; // a source file; other text files (docs, config) give no call or identifier seeds
  block: Block;
  changedLines: number[]; // lines at the after commit; a pure removal is placed on the line above it
  added: string[];
  removed: string[];
}

export interface CalledSymbol {
  name: string;
  onChangedLine: boolean; // written on an added or removed line (a guard helper) vs only around them
  regions: number; // how many changed regions call it
  constructed: boolean; // made with `new X(`, `throw X(` or `raise X(`: an object or an error, not a call
}

export interface ChangeAnalysis {
  files: FileChange[];
  changedPaths: string[]; // every path the change touched, at either side
  regions: ChangedRegion[];
  definedSymbols: string[];
  calledSymbols: CalledSymbol[];
  changedIdentifiers: string[];
  concepts: string[];
  skipped: { path: string; reason: string }[];
}

const KEYWORDS = new Set(
  (
    "abstract and as assert async await break case catch class const continue debugger declare def default defer del delete do elif else enum except export extends false final finally fn for foreach from func function go goto if impl implements import in instanceof interface is lambda let loop match mod module mut namespace new nil none not null of or package pass private protected pub public raise readonly return select self static struct super switch this throw throws trait true try type typeof undefined unless until use var void when where while with yield " +
    "None True False Self"
  ).split(" "),
);

// Calls that are never the action a requirement governs: logging, collections, strings, promises,
// language built-ins. Domain verbs (save, send, delete, create) are deliberately absent; discovery
// ranks common ones down by how many files use them instead.
const BUILTIN_CALLS = new Set(
  (
    "console log info warn error debug trace print println printf sprintf format push pop shift unshift map filter reduce forEach some every findIndex includes indexOf lastIndexOf join split slice splice concat sort reverse keys values entries then catch finally resolve reject all allSettled race toString valueOf toJSON trim trimStart trimEnd toLowerCase toUpperCase replace replaceAll startsWith endsWith padStart padEnd charAt charCodeAt parseInt parseFloat isNaN isFinite stringify parse freeze assign isArray setTimeout clearTimeout setInterval clearInterval require len str int float bool list dict tuple range enumerate zip isinstance hasattr getattr setattr append extend unwrap expect clone collect iter into to_string ok_or Some Ok Err Box Vec String Number Boolean Array Object Symbol BigInt Date Math JSON Promise Error TypeError RangeError Set Map WeakMap WeakSet RegExp describe it test beforeEach afterEach assertEqual equal deepEqual strictEqual"
  ).split(" "),
);

// Source files by extension. Prose and configuration are still regions of the change, but reading
// "calls" out of a README only produces noise (measured: 150+ English words as identifiers).
const CODE_EXTENSIONS = new Set(
  "ts tsx mts cts js jsx mjs cjs py pyi go rs zig java kt kts scala swift rb php cs fs c h cc cpp cxx hpp hh m mm lua ex exs erl hrl clj cljs dart sh bash zsh ps1 sql vue svelte astro groovy pl pm r jl nim cr v sol tf hcl erb ejs hbs handlebars twig jinja j2 liquid mustache".split(" "),
);

export function isCode(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") && CODE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

// The lookbehind stops a match from starting inside an identifier; without it a long run of word
// characters with no `(` (an embedded hex string) is rescanned from every position.
const CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const IDENT = /[A-Za-z_$][\w$]*/g;

/** A name worth using as a seed: three characters or more, not a keyword, not a built-in. */
function significant(name: string): boolean {
  return name.length >= 3 && !KEYWORDS.has(name) && !BUILTIN_CALLS.has(name);
}

/**
 * Names called in `text`, minus keywords and built-ins. A definition (`def run(`, `handle(req) {`)
 * has the same shape as a call, so the name a header line defines is not counted on that line. A
 * method call is never a keyword: `db.delete(id)` and `query.select(...)` are calls.
 */
export function calledNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const defines = looksLikeHeader(line) ? definedName(line) : undefined;
    for (const match of line.matchAll(CALL)) {
      const name = match[1] as string;
      const method = line[(match.index ?? 0) - 1] === ".";
      const kept = method ? name.length >= 3 && !BUILTIN_CALLS.has(name) : significant(name);
      if (name !== defines && kept) names.add(name);
    }
  }
  return names;
}

const CONSTRUCTED = /(?:\bnew|\bthrow|\braise)\s+([A-Z][\w$]*)\s*\(/g;

/** Names made with `new X(`, `throw X(` or `raise X(` in `text`. */
export function constructedNames(text: string): Set<string> {
  return new Set([...text.matchAll(CONSTRUCTED)].map((m) => m[1] as string));
}

export function identifiers(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(IDENT)) {
    const name = match[0];
    if (significant(name)) names.add(name);
  }
  return names;
}

/** `activeSince` → active, since; `order_total` → order, total. Words of four letters or more. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4 && !KEYWORDS.has(w));
}

/** `target.push(...items)` without spreading: a spread of 150,000 removed lines overflows the stack. */
function append<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

/**
 * Regions of one changed file. In source files a region is the block around the changed lines;
 * in other text files it is the hunk itself. Overlapping windows are merged into one.
 */
export function regionsOf(file: FileChange, path: string, lines: string[]): ChangedRegion[] {
  const code = isCode(path);
  const index = code ? new BlockIndex(lines, { path }) : null;
  const touched = new Map<string, { region: ChangedRegion; lines: Set<number> }>();
  const regionFor = (block: Block, line: number): ChangedRegion => {
    const key = `${block.startLine}-${block.endLine}`;
    let entry = touched.get(key);
    if (!entry) {
      entry = { region: { path, code, block, changedLines: [], added: [], removed: [] }, lines: new Set() };
      touched.set(key, entry);
    }
    entry.lines.add(line);
    return entry.region;
  };

  for (const hunk of file.hunks) {
    const anchor = Math.max(hunk.newStart, 1);
    if (!index) {
      const block = { startLine: anchor, endLine: Math.max(anchor, hunk.newStart + hunk.newLines - 1), windowed: false };
      const region = regionFor(block, anchor);
      hunk.added.forEach((text, i) => {
        if (text.trim() === "") return;
        regionFor(block, hunk.newStart + i);
        region.added.push(text);
      });
      append(region.removed, hunk.removed);
      continue;
    }
    if (hunk.newLines === 0) {
      append(regionFor(index.removalBlock(hunk.newStart, hunk.removed), anchor).removed, hunk.removed);
      continue;
    }
    // Added line i is line newStart + i of the after commit. Removed lines go to the region of the
    // first non-blank added line. Blank added lines change nothing and would otherwise pull a
    // region's start up to them.
    const firstText = hunk.added.findIndex((text) => text.trim() !== "");
    const firstLine = firstText >= 0 ? hunk.newStart + firstText : anchor;
    append(regionFor(index.enclosing(firstLine), firstLine).removed, hunk.removed);
    hunk.added.forEach((text, i) => {
      if (text.trim() === "") return;
      const line = hunk.newStart + i;
      regionFor(index.enclosing(line), line).added.push(text);
    });
  }

  // Overlapping windows become one region, and so do runs of short top-level statements (imports,
  // constants, the lines of a docstring), which would otherwise be one region per line. A short
  // function is not a fragment: it keeps its own region and its name.
  const short = (b: Block) => !b.windowed && b.endLine - b.startLine < 3 && !looksLikeHeader(lines[b.startLine - 1] ?? "");
  const fragments = new Set<ChangedRegion>();
  const merged: { region: ChangedRegion; lines: Set<number> }[] = [];
  for (const entry of [...touched.values()].sort((a, b) => a.region.block.startLine - b.region.block.startLine)) {
    const last = merged[merged.length - 1];
    const lb = last?.region.block;
    const rb = entry.region.block;
    const windows = lb?.windowed && rb.windowed && rb.startLine <= lb.endLine;
    const run = last && lb && (fragments.has(last.region) || short(lb)) && short(rb) && rb.startLine - lb.endLine <= 2;
    if (last && lb && (windows || run)) {
      last.region.block = { startLine: lb.startLine, endLine: Math.max(lb.endLine, rb.endLine), windowed: lb.windowed };
      for (const line of entry.lines) last.lines.add(line);
      append(last.region.added, entry.region.added);
      append(last.region.removed, entry.region.removed);
      if (run) fragments.add(last.region);
    } else {
      merged.push(entry);
    }
  }

  // A changed doc comment above a function is attributed to the function; widen the region so it
  // still covers every line it claims. (A loop, not Math.min(...lines): a 150,000-line hunk would
  // overflow the argument limit.)
  return merged.map(({ region, lines: changed }) => {
    region.changedLines = [...changed].sort((a, b) => a - b);
    const first = region.changedLines[0] ?? region.block.startLine;
    const last = region.changedLines[region.changedLines.length - 1] ?? region.block.endLine;
    if (first < region.block.startLine || last > region.block.endLine) {
      region.block = { ...region.block, startLine: Math.min(first, region.block.startLine), endLine: Math.max(last, region.block.endLine) };
    }
    return region;
  });
}

export async function analyzeChange(
  git: Git,
  before: string,
  after: string,
  include: (path: string) => boolean,
): Promise<ChangeAnalysis> {
  // The file list first, then a diff of each text file on its own: a binary or oversized file is
  // never diffed at all, so its size cannot blow up the output, and whether it is binary is
  // decided by its bytes, not by an attribute the change could set.
  const changed = await git.changedFiles(before, after);
  const changedPaths = [...new Set(changed.flatMap((f) => [f.oldPath, f.newPath].filter((p): p is string => p !== null)))].sort();
  const files: FileChange[] = [];
  const regions: ChangedRegion[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const linesOf = new Map<string, string[]>(); // each changed file split once, for its regions' bodies below

  for (const entry of changed) {
    const path = entry.newPath;
    const bare: FileChange = { ...entry, binary: false, hunks: [] };
    if (path === null) {
      files.push(bare); // deleted: nothing left to call anything
      continue;
    }
    if (!include(path)) {
      skipped.push({ path, reason: "excluded by repository.include / ignore" });
      files.push(bare);
      continue;
    }
    const [text, old] = await Promise.all([git.readText(after, path), entry.oldPath === null ? "" : git.readText(before, entry.oldPath)]);
    if (text === null || old === null) {
      skipped.push({ path, reason: text === null ? "binary, or larger than the read limit" : "the version before the change is binary, or larger than the read limit" });
      files.push({ ...bare, binary: true });
      continue;
    }
    const pathspec = entry.oldPath !== null && entry.oldPath !== path ? [entry.oldPath, path] : [path];
    const file = parseDiff(await git.diffText(before, after, pathspec)).find((f) => f.newPath === path) ?? bare;
    files.push(file);
    if (file.hunks.length > 0) {
      const lines = text.split("\n");
      linesOf.set(path, lines);
      append(regions, regionsOf(file, path, lines));
    }
  }

  const defined = new Set<string>();
  const calls = new Map<string, CalledSymbol>();
  const changedIds = new Set<string>();
  for (const region of regions) {
    if (!region.code) continue;
    if (region.block.name) defined.add(region.block.name);
    const changedText = [...region.added, ...region.removed].join("\n");
    for (const id of identifiers(changedText)) changedIds.add(id);
    const body = (linesOf.get(region.path) ?? []).slice(region.block.startLine - 1, region.block.endLine).join("\n");
    const onChanged = calledNames(changedText);
    const constructed = constructedNames(`${body}\n${changedText}`);
    for (const name of new Set([...calledNames(body), ...onChanged])) {
      if (name === region.block.name) continue;
      const entry = calls.get(name) ?? { name, onChangedLine: false, regions: 0, constructed: false };
      entry.regions += 1;
      entry.onChangedLine ||= onChanged.has(name);
      entry.constructed ||= constructed.has(name);
      calls.set(name, entry);
    }
  }

  const concepts = new Set<string>();
  for (const name of [...defined, ...calls.keys(), ...changedIds]) for (const word of splitWords(name)) concepts.add(word);

  return {
    files,
    changedPaths,
    regions,
    definedSymbols: [...defined].sort(),
    calledSymbols: [...calls.values()].sort((a, b) => a.name.localeCompare(b.name)),
    changedIdentifiers: [...changedIds].sort(),
    concepts: [...concepts].sort(),
    skipped,
  };
}
