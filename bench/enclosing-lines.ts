// How `BlockIndex.enclosing` reads every line of five repositories, before and after a function's end
// is read from the line its body opens on (#74). No request is sent.
//
//   node bench/enclosing-lines.ts --acceptance <dir> --before <rev> [--out <file>]
//
// `--acceptance` is the directory holding the clones of moltis, whatsapp-rust, grovedb, Kontor and
// pybun, read at their working trees. Every non-blank line of the tracked `.rs`, `.ts`, `.tsx`, `.js`,
// `.jsx`, `.py`, `.swift`, `.sql` and `.go` files is asked of both tools, and a line the two read
// differently is put in one class:
//
//   - `bodyBelow`: the line is in the body of a function whose body opens below its signature, and is
//     read as that function's — what #74 is for; `implWhereBody` the same for an `impl … where` block,
//     which has no name either way;
//   - `endExtended`: the same function, its end moved down to its closing brace;
//   - `signatureLine`: one of that function's own signature lines;
//   - `toWindow`: now read as a window, the block read whole being over 300 lines;
//   - `other`: in a function over 300 lines, read as the bare block the line is in where it was read
//     as the block around it or a window;
//   - `nonRust`: a line outside Rust. 0 when #74 does what it says.
//
// `renamed` counts the lines read as the same span under another name: a Rust `fn new`, which had
// none (#74).
//
// And the other way round, which a count of differences cannot see, found without `bodyOpens` so that
// a shape it misses is still counted: every `fn` in a `.rs` file, its body found by counting brackets
// outside strings and comments (the first `{` at bracket depth 0, and the `}` that closes it). For
// each whose body opens below its signature, every line of the body is asked of `enclosing` after #74:
// `notTheFunctions` counts the lines read as a block wider than the function — what #74's sentence
// says does not happen — and `overLimit` those of functions over the 300 lines a block is read whole,
// which are read as a window. Counted apart, as `blockEnd`'s indent reading for any function and not
// #74's: `inStringLiteral`, a line inside a string literal, and `besideColumn0String`, a line of a
// function with a string literal line at column 0. Outside test code (which the listing leaves out),
// `listingEndDiffers` counts such functions the listing (`enumerate`) reads with another end, and
// `notListed` those it does not list in a file under its cap, by name in `notListedNames`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BlockIndex as Now, bodyOpens, testRegions } from "../src/change/blocks.ts";
import { enumerate } from "../src/plan/candidates.ts";

const HERE = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { acceptance: { type: "string" }, before: { type: "string" }, out: { type: "string" } } });
if (!values.acceptance || !values.before) throw new Error("usage: node bench/enclosing-lines.ts --acceptance <dir> --before <rev> [--out <file>]");
const ACC = resolve(values.acceptance);
const beforeRev = execFileSync("git", ["-C", HERE, "rev-parse", values.before], { encoding: "utf8" }).trim();
const scratch = mkdtempSync(join(homedir(), ".cctmp", "enclosing-lines-before-"));
execFileSync("sh", ["-c", `git -C "${HERE}" archive "${beforeRev}" src package.json | tar -x -C "${scratch}"`]);
symlinkSync(join(HERE, "node_modules"), join(scratch, "node_modules"));
const Before = (await import(join(scratch, "src/change/blocks.ts"))).BlockIndex as typeof Now;

type B = { startLine: number; endLine: number; windowed: boolean; name?: string };
/**
 * Where a function's body opens and closes, 0-based, by counting brackets outside strings, character
 * literals and comments — independent of \`bodyOpens\` and \`blockEnd\`. \`null\` for a declaration.
 */
function bodyByBrackets(text: string, from: number): { open: number; close: number; inString: Set<number> } | null {
  const inString = new Set<number>();
  let depth = 0;
  let braces = 0;
  let line = 0;
  let open = -1;
  for (let i = 0; i < from; i++) if (text[i] === "\n") line++;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      line++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      i--;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      for (let k = i; k < (end < 0 ? text.length : end); k++) if (text[k] === "\n") line++;
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === "r" && /^r#*"/.test(text.slice(i, i + 8)) && !/[\w]/.test(text[i - 1] ?? "")) {
      const hashes = /^r(#*)"/.exec(text.slice(i, i + 8))![1]!;
      const end = text.indexOf(`"${hashes}`, i + hashes.length + 2);
      for (let k = i; k < (end < 0 ? text.length : end); k++) if (text[k] === "\n") inString.add(++line);
      i = end < 0 ? text.length : end + hashes.length;
      continue;
    }
    if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") i++;
        if (text[i] === "\n") inString.add(++line);
      }
      continue;
    }
    if (ch === "'" && (text[i + 2] === "'" || (text[i + 1] === "\\" && text.indexOf("'", i + 2) - i <= 10))) {
      i = text.indexOf("'", i + 2);
      continue;
    }
    if (open < 0) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (depth === 0 && ch === ";") return null;
      else if (depth === 0 && ch === "{") {
        open = line;
        braces = 1;
      }
      continue;
    }
    if (ch === "{") braces++;
    else if (ch === "}" && --braces === 0) return { open, close: line, inString };
  }
  return null;
}

const range = (b: B) => `${b.startLine}-${b.endLine}${b.windowed ? "W" : ""}(${b.name ?? ""})`;
const EXTS = /\.(rs|ts|tsx|js|jsx|py|swift|sql|go)$/;
const repos: Record<string, Record<string, number | string[] | Record<string, number>>> = {};
for (const repo of ["moltis", "whatsapp-rust", "grovedb", "Kontor", "pybun"]) {
  const dir = join(ACC, repo);
  const files = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" }).split("\n").filter((f) => EXTS.test(f));
  const c = { lines: 0, renamed: 0, nonRust: 0, bodyBelow: 0, implWhereBody: 0, endExtended: 0, signatureLine: 0, toWindow: 0, other: 0, listedFunctions: 0, notListed: 0, listingEndDiffers: 0, inStringLiteral: 0, besideColumn0String: 0, bodyLinesAsked: 0, notTheFunctions: 0, overLimit: 0 };
  const wrong: string[] = [];
  const listingOff: string[] = [];
  const notListedNames: Record<string, number> = {};
  const renamedAs: Record<string, number> = {};
  const odd: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const a = new Before(lines);
    const b = new Now(lines);
    for (let l = 1; l <= lines.length; l++) {
      if (!lines[l - 1]!.trim()) continue;
      c.lines++;
      const x = a.enclosing(l);
      const y = b.enclosing(l);
      if (x.startLine === y.startLine && x.endLine === y.endLine && x.windowed === y.windowed) {
        if (x.name !== y.name) {
          c.renamed++;
          const key = `${x.name ?? "-"} -> ${y.name ?? "-"}`;
          renamedAs[key] = (renamedAs[key] ?? 0) + 1;
        }
        continue;
      }
      const opens = bodyOpens(lines, y.startLine - 1) + 1;
      if (!f.endsWith(".rs")) c.nonRust++;
      else if (!y.windowed && opens > y.startLine && l > opens && l <= y.endLine && y.startLine !== x.startLine) {
        if (/\bfn\s/.test(lines[y.startLine - 1]!)) c.bodyBelow++;
        else c.implWhereBody++;
      }
      else if (!y.windowed && y.startLine === x.startLine && y.endLine > x.endLine && opens > y.startLine) c.endExtended++;
      else if (!y.windowed && l >= y.startLine && l <= opens) c.signatureLine++;
      else if (y.windowed) c.toWindow++;
      else c.other++;
      if ((!f.endsWith(".rs") || (!y.windowed && !(opens > y.startLine))) && odd.length < 20) odd.push(`${f}:${l} ${range(x)} -> ${range(y)}`);
    }
  }
  // The other way round, found by counting brackets (see the header).
  for (const f of files.filter((x) => x.endsWith(".rs"))) {
    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const idx = new Now(lines);
    const { functions: listed, omitted } = enumerate(f, text);
    const tests = testRegions(lines);
    let offset = 0;
    for (let n = 0; n < lines.length; offset += lines[n]!.length + 1, n++) {
      const line = lines[n]!;
      const code = line.replace(/\/\/.*$/, "");
      const m = /\bfn\s+[A-Za-z_]\w*\s*[(<]/.exec(code);
      if (!m || line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      const body = bodyByBrackets(text, offset + m.index);
      if (!body || body.open === n) continue;
      c.listedFunctions++;
      const start = n + 1;
      const end = body.close + 1;
      const inListing = listed.find((fn) => fn.startLine === start);
      const outsideTests = !tests.some((r) => start >= r.start && start <= r.end);
      if (outsideTests && !inListing && omitted.functions === 0) {
        c.notListed++;
        notListedNames[m[0]] = (notListedNames[m[0]] ?? 0) + 1;
      }
      if (outsideTests && inListing && inListing.endLine !== end) {
        c.listingEndDiffers++;
        if (listingOff.length < 12) listingOff.push(` ${f}:${start} ${m[0]} body ${body.open + 1}-${end}, listed ${inListing.startLine}-${inListing.endLine}`);
      }
      // A string literal with a line at column 0 (a closing `"#,`) reads as a block of its own by
      // indent, and so does what follows it: `blockEnd`'s reading for every function, counted apart.
      const column0String = [...body.inString].some((k) => k > body.open && k < body.close && /^\S/.test(lines[k]!));
      for (let l = body.open + 2; l < end; l++) {
        const t = lines[l - 1]!.trim();
        if (!t || t.startsWith("//")) continue;
        // A line inside a string literal (moltis's Python in `r#"…"#`) is read by indent like any
        // other; that is `blockEnd`'s reading for every function, not #74's, and is counted apart.
        if (body.inString.has(l - 1)) {
          c.inStringLiteral++;
          continue;
        }
        c.bodyLinesAsked++;
        const y = idx.enclosing(l);
        if (y.windowed && end - start + 1 > 300) c.overLimit++;
        else if ((y.windowed || y.startLine < start || y.endLine > end) && column0String) c.besideColumn0String++;
        else if (y.windowed || y.startLine < start || y.endLine > end) {
          c.notTheFunctions++;
          if (wrong.length < 12) wrong.push(`${f}:${l} in ${m[0]} ${start}-${end} read as ${range(y)}`);
        }
      }
    }
  }
  repos[repo] = { ...c, examplesOfNonRustOrOther: odd, examplesNotTheFunctions: wrong, examplesListingDisagrees: listingOff, notListedNames, renamedAs };
  console.log(repo, JSON.stringify(c));
}
const result = {
  what: "Every non-blank line of five repositories' tracked source files, read by BlockIndex.enclosing before and after #74, and each line read differently put in one class. No request sent.",
  before: beforeRev,
  after: `src/ sha256 ${execFileSync("sh", ["-c", `cd "${HERE}" && find src -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256`], { encoding: "utf8" }).split(" ")[0]}`,
  clones: Object.fromEntries(["moltis", "whatsapp-rust", "grovedb", "Kontor", "pybun"].map((r) => [r, execFileSync("git", ["-C", join(ACC, r), "rev-parse", "HEAD"], { encoding: "utf8" }).trim()])),
  repos,
};
if (values.out) writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
