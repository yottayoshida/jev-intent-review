// The code region around a line, found from indentation alone so it works across languages.
//
// ponytail: a heuristic, not a parser. It relies on code being indented the way people indent it.
// Minified files, and bodies whose closing brace sits at the header's indentation mid-line, give
// a wrong or oversized region; oversized regions fall back to a fixed window around the line.
// Language-aware extraction (tree-sitter) is spec Phase 4.

export interface Block {
  startLine: number; // 1-based, inclusive
  endLine: number;
  name?: string; // what the header defines, when it defines something
  windowed: boolean; // true when no fitting block was found and a window was used instead
}

const COMMENT = /^\s*(\/\/|#|\/\*|\*|--|;|<!--)/;
const CONTROL =
  /^\s*(\}\s*)?(if|else|elif|for|foreach|while|switch|case|default|catch|try|finally|do|with|return|except|unless|until|loop|match|select|when|synchronized|using|lock|defer|go)\b/;

const HEADERS: RegExp[] = [
  /\bfunction\b/, // JS / TS / PHP / Lua
  /^\s*(async\s+)?def\s+[\w.?!]+/, // Python / Ruby
  /^\s*func\b/, // Go / Swift
  /^\s*(pub(\([\w:]+\))?\s+)?(export\s+)?(inline\s+)?(async\s+)?(const\s+)?(unsafe\s+)?(extern\s+("\w+"\s+)?)?fn\s+\w+/, // Rust / Zig
  /\b(fun|sub|proc|method)\s+[\w$]+\s*[(<]/, // Kotlin / Perl / Nim / Raku
  /^\s*(export\s+)?(default\s+)?(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*(:[^=]+)?=>/, // arrow function assigned
  // An arrow function with a body. What precedes the arrow has to be a parameter list or a single
  // name, and it has to follow an `=`, an opening bracket, a comma, a colon or the start of the
  // line — otherwise every `Err(_) => {` and `.ok => {` reads as a function. `Err(_) => {` was
  // taken for one named `Err`, which every Rust file then has more than one of, so the evidence
  // for those places carried another arm's surroundings and the answers about them were voided.
  /(^|[=(,:[]\s*)(async\s+)?(\([^)]*\)(\s*:[^=]+)?|[a-z$][\w$]*)\s*=>\s*\{\s*$/,
  // `name(args) {`, `Type name(args) {`, `name(args): Type {`. Must open a block, or a plain call
  // in a brace-less language (`save(record)`) would read as a definition.
  /^\s*([\w$<>[\],.?*&:]+\s+)*[\w$]+\s*\([^;]*\)\s*(:\s*[^={};]+)?\s*(throws\s+[\w.,\s]+)?\s*(->\s*[^={};]+)?\{\s*$/,
  // Methods with modifiers, including a brace on the next line or a parameter list that wraps.
  /^\s*((public|private|protected|internal|static|async|override|readonly|abstract|final|virtual|sealed|open|suspend)\s+)+([\w$<>[\],.?]+\s+)*[\w$]+\s*[(<]/,
];

const DEFINES: RegExp[] = [
  /\bfunction\s*\*?\s*([\w$]+)/,
  /\bdef\s+(?:self\.)?([\w?!]+)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([\w]+)/,
  /\bfn\s+(\w+)/,
  /^\s*(?:sub|proc|method|fun)\s+(\w+)/,
  /\b(?:class|struct|interface|trait|impl|module|object|enum|type)\s+([\w$]+)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([\w$]+)/,
  /^\s*(?:[\w$<>[\],.?*&:]+\s+)*([\w$]+)\s*\(/,
];

const CONTINUATION = /^\s*([)\]]|\{\s*$)/;

const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "function", "new", "await", "async", "else", "do", "with", "yield"]);

/**
 * Lines inside a test region of a source file: Rust's `#[cfg(test)] mod tests`, Zig's
 * `test "..." {`. A definition in one is not the definition a path outside it reaches, and both
 * languages keep their tests in the file they test, where a path filter cannot see them.
 */
export function testRegions(lines: readonly string[]): { start: number; end: number }[] {
  const regions: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const cfgTest = /^\s*#\[cfg\(test\)\]/.test(line);
    const zigTest = /^\s*test\s+("[^"]*"|[\w.]+)?\s*\{/.test(line);
    if (!cfgTest && !zigTest) continue;
    // The region is the block that opens on this line or the next one.
    let open = i;
    while (open < lines.length && !(lines[open] as string).includes("{")) open += 1;
    if (open >= lines.length) continue;
    // Counted by braces, not by indentation: `mod tests {}` opens and closes on its own line, and
    // looking for the next closing brace instead put every production definition after it inside
    // the region.
    let depth = 0;
    let end = open;
    for (let j = open; j < lines.length; j++) {
      const text = lines[j] as string;
      if (isSkippable(text)) continue;
      for (const ch of text) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      end = j;
      if (depth <= 0) break;
    }
    regions.push({ start: i + 1, end: end + 1 });
    i = end;
  }
  return regions;
}

export function isSkippable(line: string): boolean {
  return line.trim() === "" || COMMENT.test(line);
}

export function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

// Headers are short. Matching only the start of a line keeps a crafted 20,000-character line from
// making these patterns backtrack for seconds.
const MAX_HEADER_CHARS = 400;
const clip = (line: string) => (line.length > MAX_HEADER_CHARS ? line.slice(0, MAX_HEADER_CHARS) : line);

export function looksLikeHeader(line: string): boolean {
  const text = clip(line);
  if (CONTROL.test(text) || isSkippable(text)) return false;
  return HEADERS.some((p) => p.test(text));
}

/** Whether `line` is the header that defines `name`: its definition, not a use of it. */
export function defines(line: string, name: string): boolean {
  return looksLikeHeader(line) && definedName(line) === name;
}

export function definedName(line: string): string | undefined {
  const text = clip(line);
  if (CONTROL.test(text)) return undefined;
  for (const pattern of DEFINES) {
    const name = pattern.exec(text)?.[1];
    if (name && !NOT_NAMES.has(name)) return name;
  }
  return undefined;
}

/** The last line of the block that starts at `start` (0-based indexes). */
export function blockEnd(lines: readonly string[], start: number): number {
  const base = indentOf(lines[start] ?? "");
  let last = start;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j] as string;
    if (isSkippable(line)) continue;
    if (indentOf(line) <= base) {
      const trimmed = line.trim();
      // `{` alone (brace on its own line), `) {`, `} else {`, `}) => {` continue the same
      // construct; `}` / `end` / `)` close it.
      if (trimmed === "{" || (/^[)\]}]/.test(trimmed) && /[{(:[]\s*$/.test(trimmed))) {
        last = j;
        continue;
      }
      if (/^([)\]}]|end\b|fi\b|done\b|esac\b)/.test(trimmed)) return j;
      return last;
    }
    last = j;
  }
  return last;
}

const CLOSER_ONLY = /^\s*[)\]}][)\]};,]*\s*$/;

export interface BlockOptions {
  maxLines?: number;
  window?: number;
  /** Where to look for code when `lineNo` is blank or a comment: the next code line (default) or the one above. */
  from?: "below" | "above";
}

/**
 * Block lookups over one file. Everything that walks the file is computed once and reused, so
 * asking about every line of a 20,000-line file stays linear-ish instead of quadratic.
 */
export class BlockIndex {
  readonly lines: readonly string[];
  readonly #indent: number[];
  readonly #skip: boolean[];
  readonly #parent: Int32Array; // nearest code line above with smaller indentation, or -1
  readonly #next: Int32Array; // first code line at or below, or -1
  readonly #prev: Int32Array; // last code line at or above, or -1
  readonly #ends = new Map<number, number>();
  readonly #headers = new Map<number, number>();

  /** Lines inside a test region of this file, so a definition in one can be told apart. */
  readonly testRegions: readonly { start: number; end: number }[];

  constructor(lines: readonly string[]) {
    this.lines = lines;
    this.testRegions = testRegions(lines);
    const n = lines.length;
    this.#indent = lines.map(indentOf);
    this.#skip = lines.map(isSkippable);
    this.#parent = new Int32Array(n).fill(-1);
    this.#next = new Int32Array(n).fill(-1);
    this.#prev = new Int32Array(n).fill(-1);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      this.#prev[i] = this.#skip[i] ? (i > 0 ? (this.#prev[i - 1] as number) : -1) : i;
      if (this.#skip[i]) continue;
      while (stack.length > 0 && (this.#indent[stack[stack.length - 1] as number] as number) >= (this.#indent[i] as number)) stack.pop();
      this.#parent[i] = stack.length > 0 ? (stack[stack.length - 1] as number) : -1;
      stack.push(i);
    }
    for (let i = n - 1; i >= 0; i--) this.#next[i] = this.#skip[i] ? (i < n - 1 ? (this.#next[i + 1] as number) : -1) : i;
  }

  /**
   * Where lines removed after line `after` (0 = before the first line) belong. A removal belongs to
   * the block above it when the code on both sides is in that block, or when the removed lines
   * were indented deeper than the code below them (the last lines of a Python or Ruby body,
   * followed by the next `def` or an `end`). Otherwise, and when the removal starts with a
   * definition (a whole function or method going away), it belongs to neither neighbour and is a
   * one-line block at `after`.
   */
  removalBlock(after: number, removed: readonly string[]): Block {
    const anchor = Math.max(after, 1);
    const point = { startLine: anchor, endLine: anchor, windowed: false };
    if (after <= 0) return point;
    const above = this.enclosing(anchor, { from: "above" });
    if (above.windowed) return point;
    const below = anchor < this.lines.length ? this.enclosing(anchor + 1) : undefined;
    if (below && above.startLine === below.startLine && above.endLine === below.endLine) return above;

    const first = removed.find((line) => line.trim() !== "");
    if (first === undefined || looksLikeHeader(first)) return point;
    let removedIndent = Number.POSITIVE_INFINITY;
    for (const line of removed) if (line.trim() !== "") removedIndent = Math.min(removedIndent, indentOf(line));
    const next = anchor < this.lines.length ? (this.#next[anchor] as number) : -1;
    return next >= 0 && removedIndent > (this.#indent[next] as number) ? above : point;
  }

  #end(start: number): number {
    let end = this.#ends.get(start);
    if (end === undefined) {
      end = blockEnd(this.lines, start);
      this.#ends.set(start, end);
    }
    return end;
  }

  /**
   * `): Type {` ends a parameter list that wrapped, and a `{` alone follows a header written on
   * the line before it; either way the construct starts further up.
   *
   * ponytail: the upward scan is memoised per line but not shared between lines, so tens of
   * thousands of alternating `)` lines and deeper lines cost seconds. Only a crafted file has that
   * shape; sharing the scan (a stack of open continuations) is the fix if a real one appears.
   */
  #header(i: number): number {
    if (!CONTINUATION.test(this.lines[i] as string)) return i;
    let header = this.#headers.get(i);
    if (header === undefined) {
      header = i;
      const indent = this.#indent[i] as number;
      for (let k = i - 1; k >= 0; k--) {
        if (!this.#skip[k] && (this.#indent[k] as number) <= indent && !CONTINUATION.test(this.lines[k] as string)) {
          header = k;
          break;
        }
      }
      this.#headers.set(i, header);
    }
    return header;
  }

  /**
   * The innermost function-like block containing `lineNo` (1-based). Without one, the outermost
   * enclosing block; when that is longer than `maxLines`, a window of `window` lines on each side.
   */
  enclosing(lineNo: number, options: BlockOptions = {}): Block {
    const { maxLines = 300, window = 40, from = "below" } = options;
    const n = this.lines.length;
    if (n === 0) return { startLine: 1, endLine: 1, windowed: true };
    const idx = Math.min(Math.max(lineNo - 1, 0), n - 1);
    const found = (from === "above" ? this.#prev[idx] : this.#next[idx]) as number;
    // Only blank lines and comments on that side (a comment added after the last function): the
    // line is a region of its own, not a window borrowed from the code on the other side.
    if (found < 0) return { startLine: idx + 1, endLine: idx + 1, windowed: false };
    let anchor = found;
    // A line that only closes brackets (`}`, `});`) belongs to the block it closes, which the line
    // above it is inside of.
    if (CLOSER_ONLY.test(this.lines[anchor] as string) && anchor > 0) {
      const above = this.#prev[anchor - 1] as number;
      if (above >= 0 && (this.#indent[above] as number) > (this.#indent[anchor] as number)) anchor = above;
    }

    // Headers of the blocks that contain the line, innermost first.
    const chain: number[] = [];
    if (looksLikeHeader(this.lines[anchor] as string)) chain.push(anchor);
    for (let p = this.#parent[anchor] as number; p >= 0; ) {
      const header = this.#header(p);
      chain.push(header);
      p = this.#parent[header] as number;
    }

    const fits = (start: number) => this.#end(start) - start + 1 <= maxLines && this.#end(start) >= idx;
    const fn = chain.find((h) => looksLikeHeader(this.lines[h] as string) && fits(h));
    const outer = chain.length > 0 ? (chain[chain.length - 1] as number) : anchor;
    const start = fn ?? (fits(outer) ? outer : chain.find(fits));

    if (start === undefined) {
      return { startLine: Math.max(1, idx + 1 - window), endLine: Math.min(n, idx + 1 + window), windowed: true };
    }
    const name = definedName(this.lines[start] as string);
    return { startLine: start + 1, endLine: this.#end(start) + 1, ...(name ? { name } : {}), windowed: false };
  }
}

export function enclosingBlock(lines: readonly string[], lineNo: number, maxLines = 300, window = 40): Block {
  return new BlockIndex(lines).enclosing(lineNo, { maxLines, window });
}
