// The Rust functions a pair of commits changes, as `(path, name)`, from the diff alone.
//
//   node bench/acceptance/changed-functions.ts <clone> <base> <head> [<base> <head> ...]
//
// Every version of a case must change the same functions as the shipped version: a version that
// changes one more puts its defect inside the diff, and the kind of place it was built for is gone.
// This is checked before a version's commits are fixed, and it reads nothing of what the tool does
// with the change — only the hunks and the functions around them — so it cannot be steered by where
// the tool happens to reach. Names, not ids: ids are positional and move when a helper is added.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const git = (clone: string, args: string[]) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** `[start, end, name]` of every function in a Rust source, 1-based and inclusive. */
export function functionSpans(source: string): [number, number, string][] {
  const lines = source.split("\n");
  const spans: [number, number, string][] = [];
  const head = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/;
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]!);
    if (!m) continue;
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === "{") (depth += 1), (opened = true);
        else if (ch === "}") depth -= 1;
      }
      if (opened && depth <= 0) {
        spans.push([i + 1, j + 1, m[1]!]);
        break;
      }
      if (!opened && lines[j]!.trimEnd().endsWith(";")) break;
    }
  }
  return spans;
}

/** The innermost function around each line. */
function namesAt(spans: [number, number, string][], lines: number[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    const around = spans.filter(([s, e]) => s <= line && line <= e).sort((a, b) => a[1] - a[0] - (b[1] - b[0]))[0];
    if (around) out.add(around[2]);
  }
  return out;
}

export function changedFunctions(clone: string, base: string, head: string): string[] {
  const diff = git(clone, ["diff", "-U0", "--no-color", base, head, "--", "*.rs"]);
  const out = new Set<string>();
  let oldPath = "";
  let newPath = "";
  const oldLines = new Map<string, number[]>();
  const newLines = new Map<string, number[]>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) oldPath = line === "--- /dev/null" ? "" : line.slice(6);
    else if (line.startsWith("+++ ")) newPath = line === "+++ /dev/null" ? "" : line.slice(6);
    else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)!;
      const [os, oc, ns, nc] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
      if (oldPath) for (let k = 0; k < Math.max(oc, 1); k++) (oldLines.get(oldPath) ?? oldLines.set(oldPath, []).get(oldPath)!).push(oc === 0 ? os : os + k);
      if (newPath) for (let k = 0; k < Math.max(nc, 1); k++) (newLines.get(newPath) ?? newLines.set(newPath, []).get(newPath)!).push(nc === 0 ? ns : ns + k);
    }
  }
  for (const [path, lines] of oldLines) for (const name of namesAt(functionSpans(git(clone, ["show", `${base}:${path}`])), lines)) out.add(`${path} · ${name}`);
  for (const [path, lines] of newLines) for (const name of namesAt(functionSpans(git(clone, ["show", `${head}:${path}`])), lines)) out.add(`${path} · ${name}`);
  return [...out].sort();
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const [clone, ...pairs] = process.argv.slice(2);
  if (!clone || pairs.length < 2 || pairs.length % 2 !== 0) {
    console.error("usage: changed-functions.ts <clone> <base> <head> [<base> <head> ...]");
    process.exit(2);
  }
  const sets = [];
  for (let i = 0; i < pairs.length; i += 2) sets.push(changedFunctions(clone, pairs[i]!, pairs[i + 1]!));
  const first = JSON.stringify(sets[0]);
  sets.forEach((s, i) => console.log(`${pairs[2 * i]!.slice(0, 7)}..${pairs[2 * i + 1]!.slice(0, 7)} ${JSON.stringify(s) === first ? "SAME" : "DIFFERS"} ${JSON.stringify(s)}`));
  process.exitCode = sets.every((s) => JSON.stringify(s) === first) ? 0 : 1;
}
