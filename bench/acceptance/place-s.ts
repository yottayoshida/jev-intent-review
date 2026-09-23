// The rule `placeS` of candidates-v2.json, applied to one pull request: where a sibling's defect is
// put, from the repository's text and `git grep`, without running this tool (issue #37).
//
//   node bench/acceptance/place-s.ts <clone> <base> <head>
//
// Nothing of src/ is imported except `isTestPath` (the rule names it) and the changed functions come
// from `changed-functions.ts`, which reads only the hunks and the functions around them. Rust is
// read with regular expressions here on purpose: this is the rule's reading, and where the tool
// reads more (which definition a call reaches) that is what the measurement is about.

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { isTestPath } from "../../src/discovery/discover.ts";

const [cloneArg, base, head] = process.argv.slice(2);
if (!cloneArg || !base || !head) throw new Error("usage: node bench/acceptance/place-s.ts <clone> <base> <head>");
const clone = resolve(cloneArg);
const HERE = resolve(import.meta.dirname, "..", "..");
const git = (...args: string[]) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
const IGNORED = [/^vendor\//, /(^|\/)node_modules\//, /^dist\//, /\.generated\./];
const outsideTests = (path: string) => path.endsWith(".rs") && !isTestPath(path) && !IGNORED.some((r) => r.test(path));

/** The text of a file at head, split into lines. */
const cache = new Map<string, string[]>();
const lines = (path: string, rev = head): string[] => {
  const key = `${rev}:${path}`;
  if (!cache.has(key)) cache.set(key, git("show", key).split("\n"));
  return cache.get(key)!;
};

interface Fn {
  path: string;
  name: string;
  start: number; // 1-based line of `fn`
  end: number;
  header: string; // from `fn` to the `{` or `;`
  body: string;
}

/** The `#[cfg(test)]` modules of a file, as line ranges. */
function testModules(text: string[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    if (!/#\[cfg\(test\)\]/.test(text[i]!)) continue;
    for (let j = i + 1; j < Math.min(text.length, i + 4); j++) {
      if (/^\s*(pub\s+)?mod\s+\w+\s*\{/.test(text[j]!)) {
        out.push([j + 1, closeOf(text, j) + 1]);
        break;
      }
    }
  }
  return out;
}

/** The 0-based line of the brace that closes the first `{` at or after `from`. */
function closeOf(text: string[], from: number): number {
  let depth = 0;
  let opened = false;
  for (let i = from; i < text.length; i++) {
    const code = text[i]!.replace(/"(\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/, "");
    for (const ch of code) {
      if (ch === "{") {
        depth += 1;
        opened = true;
      } else if (ch === "}") {
        depth -= 1;
        if (opened && depth === 0) return i;
      }
    }
  }
  return text.length - 1;
}

/** Every `fn` of a file at head, outside `#[cfg(test)]` modules. */
function functionsOf(path: string): Fn[] {
  const text = lines(path);
  const tests = testModules(text);
  const out: Fn[] = [];
  for (let i = 0; i < text.length; i++) {
    const m = /^\s*(pub(\([^)]*\))?\s+)?(const\s+)?(async\s+)?(unsafe\s+)?(extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/.exec(text[i]!);
    if (!m) continue;
    if (tests.some(([s, e]) => i + 1 >= s && i + 1 <= e)) continue;
    let j = i;
    let header = "";
    while (j < text.length) {
      header += `${text[j]} `;
      if (/[{;]/.test(text[j]!.replace(/"(\\.|[^"\\])*"/g, ""))) break;
      j += 1;
    }
    header = header.replace(/\{.*$/, "").trim();
    if (header.endsWith(";")) continue;
    const end = closeOf(text, i);
    out.push({ path, name: m[7]!, start: i + 1, end: end + 1, header, body: text.slice(i, end + 1).join("\n") });
  }
  return out;
}

const returnType = (f: Fn) => (/->\s*([\s\S]*?)(\bwhere\b|$)/.exec(f.header)?.[1] ?? "").trim();
const returnsResult = (f: Fn) => /\bResult\b/.test(returnType(f));
const CALL = /(?<![\w.])(?:[A-Za-z_]\w*::)*([a-z_]\w*)\s*(?:::<[^>]*>)?\s*\(/g;
const calledNamesIn = (text: string) => new Set([...text.matchAll(CALL)].map((m) => m[1]!).filter((n) => !["if", "while", "for", "match", "return", "loop", "fn", "Some", "Ok", "Err"].includes(n)));
const callCount = (f: Fn) => [...f.body.split("\n").slice(1).join("\n").matchAll(/\b[A-Za-z_]\w*\s*(?:::<[^>]*>)?\s*\(/g)].length;

// ---- changed functions ----
const changedOut = execFileSync("node", [join(HERE, "bench/acceptance/changed-functions.ts"), clone, base, head], { encoding: "utf8" });
const changedPairs = (JSON.parse(changedOut.slice(changedOut.indexOf("["))) as string[]).map((s) => {
  const [path, name] = s.split(" · ");
  return { path: path!, name: name! };
});
const changedFns: Fn[] = [];
for (const { path, name } of changedPairs) {
  if (!outsideTests(path)) continue;
  const f = functionsOf(path).find((x) => x.name === name);
  if (f) changedFns.push(f);
}
const changedNames = new Set(changedFns.map((f) => f.name));
const isChanged = (f: Fn) => changedFns.some((c) => c.path === f.path && c.start === f.start);

// Names on the change's lines (added and removed), for "called on a changed line".
const diff = git("diff", "--unified=0", base, head, "--", ...[...new Set(changedFns.map((f) => f.path))]);
const onChangedLines = calledNamesIn(diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)).map((l) => l.slice(1)).join("\n"));
const removedNames = calledNamesIn(diff.split("\n").filter((l) => /^-[^-]/.test(l)).map((l) => l.slice(1)).join("\n"));

// ---- seeds ----
const allRust = git("ls-tree", "-r", "--name-only", head).split("\n").filter(outsideTests);
const definitionsOf = (name: string): Fn[] => {
  const hits = (() => {
    try {
      return git("grep", "-n", "-E", `fn[[:space:]]+${name}([^[:alnum:]_]|$)`, head, "--", "*.rs").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  })();
  const paths = [...new Set(hits.map((h) => h.split(":")[1]!).filter(outsideTests))];
  return paths.flatMap((p) => functionsOf(p).filter((f) => f.name === name));
};
const filesUsing = (name: string): number => {
  try {
    return new Set(git("grep", "-l", "-w", name, head, "--", "*.rs").split("\n").filter(Boolean).map((l) => l.slice(head.length + 1)).filter(outsideTests)).size;
  } catch {
    return 0;
  }
};

const candidates = new Map<string, { name: string; onChangedLine: boolean; regions: number }>();
for (const f of changedFns) {
  for (const name of calledNamesIn(f.body.split("\n").slice(1).join("\n"))) {
    const c = candidates.get(name) ?? { name, onChangedLine: onChangedLines.has(name), regions: 0 };
    c.regions += 1;
    candidates.set(name, c);
  }
}
for (const name of removedNames) if (!candidates.has(name)) candidates.set(name, { name, onChangedLine: true, regions: 1 });

const seedRows = [];
const refused: Record<string, string> = {};
for (const c of [...candidates.values()]) {
  if (c.name.length < 3) {
    refused[c.name] = "shorter than 3";
    continue;
  }
  if (changedNames.has(c.name)) {
    refused[c.name] = "a changed function";
    continue;
  }
  const defs = definitionsOf(c.name);
  if (defs.length !== 1) {
    refused[c.name] = `${defs.length} definitions outside tests`;
    continue;
  }
  if (!returnsResult(defs[0]!)) {
    refused[c.name] = `returns \`${returnType(defs[0]!) || "()"}\``;
    continue;
  }
  const files = filesUsing(c.name);
  if (files > 20) {
    refused[c.name] = `used in ${files} files`;
    continue;
  }
  seedRows.push({ ...c, files, definedAt: `${defs[0]!.path}:${defs[0]!.start}` });
}
seedRows.sort((a, b) => Number(b.onChangedLine) - Number(a.onChangedLine) || b.regions - a.regions || a.files - b.files || a.name.localeCompare(b.name));
const seeds = seedRows.slice(0, 8);

// ---- the place S ----
const considered = [];
let chosen: { seed: string; fn: Fn; target: string } | null = null;
for (const seed of seeds) {
  const hitPaths = (() => {
    try {
      return [...new Set(git("grep", "-l", "-w", seed.name, head, "--", "*.rs").split("\n").filter(Boolean).map((l) => l.slice(head.length + 1)).filter(outsideTests))].sort();
    } catch {
      return [];
    }
  })();
  for (const path of hitPaths) {
    for (const f of functionsOf(path)) {
      if (f.name === seed.name && `${f.path}:${f.start}` === seed.definedAt) continue;
      const body = f.body.split("\n").slice(1).join("\n");
      const calls = [...body.matchAll(new RegExp(`(?<![\\w])([\\w:]*?)(\\.)?${seed.name}\\s*(?:::<[^>]*>)?\\s*\\(`, "g"))];
      if (calls.length === 0) continue;
      const why = [];
      if (isChanged(f)) why.push("a changed function");
      const callsChangedName = [...calledNamesIn(body)].filter((n) => changedNames.has(n));
      if (callsChangedName.length > 0) why.push(`calls ${callsChangedName.join(", ")} by name`);
      if (!returnsResult(f)) why.push(`returns \`${returnType(f) || "()"}\``);
      if (callCount(f) > 40) why.push(`makes ${callCount(f)} calls`);
      const free = calls.find((m) => m[2] !== ".");
      if (!free) why.push("calls the seed only as a method");
      considered.push({ seed: seed.name, fn: `${f.path}:${f.start} ${f.name}`, why: why.length === 0 ? "S" : why.join("; ") });
      if (why.length === 0 && !chosen) {
        const at = f.body.split("\n").slice(1).join("\n").indexOf(free![0]);
        const rest = f.body.split("\n").slice(1).join("\n").slice(at);
        chosen = { seed: seed.name, fn: f, target: rest.slice(0, rest.indexOf("\n") < 0 ? undefined : rest.indexOf("\n")).trim() };
      }
    }
  }
}
console.log(JSON.stringify({ changed: changedFns.map((f) => `${f.path}:${f.start} ${f.name}`), seeds, refused, considered, chosen: chosen && { seed: chosen.seed, function: `${chosen.fn.path}:${chosen.fn.start} ${chosen.fn.name}`, returns: returnType(chosen.fn), targetLine: chosen.target } }, null, 1));
