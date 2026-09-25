// Which pull request put the defect in (#89, bench/eval/RETRO.md, "The original pull request").
//
// 1. A pull request the fix, its issue or its commits name as the origin ("regression from #N",
//    "introduced in #N", "broken by #N").
// 2. Otherwise, each line the fix removed or rewrote, blamed at the fix's base with `-w -M -C`, past
//    commits that change only whitespace, and taken to the merged pull request whose merge commit is on
//    the default branch (the earliest, when several are). The pull request that holds the most of the
//    lines is the origin; a tie goes to the one merged first. `share` is its part of the blamed lines.
//    (Not "the earliest of all": a fix that also touches old code elsewhere — omamori #553 rewrote
//    eight lines of `hook.rs` beside the 31 of its defect — would name the old code's pull request.)
// 3. A fix that removes no line, with nothing named, has no origin here.
//
// A case decided by 2 has its defect inside the original pull request's diff by construction: a
// retrospective result can say nothing about reaching beyond the diff from those cases.

import { execFileSync } from "node:child_process";

export type Origin = { number: number; by: "named" } | { number: number; by: "blame"; share: number } | { number: null; why: string };

/** Pull requests a text names as the origin of the defect it fixes. */
export function namedOrigins(texts: readonly string[]): number[] {
  const pattern = /\b(?:regress(?:ion|ed)?|introduced|caused|broken|broke|bug)\b[^.#\n]{0,30}?\b(?:in|by|from|since|with)\s+(?:PR\s*)?#(\d+)\b/gi;
  const found: number[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(pattern)) {
      // "#500 of the tokio crate", "#12 in serde": a number of another project, not this repository's.
      if (/^\s+(?:of|in)\s+(?!this\b)\S/i.test(t.slice(m.index! + m[0].length))) continue;
      if (!found.includes(Number(m[1]))) found.push(Number(m[1]));
    }
  }
  return found;
}

/**
 * Old-side line numbers each file's removed lines had, from a unified diff (`git diff base..head`).
 * A hunk is read for exactly the lines its header counts, so a removed line that itself begins with
 * `-- ` (an SQL or Lua comment) is a removed line, not the next file's header.
 */
export function removedLines(diff: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let file: string | null = null;
  let old = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) {
        if (file !== null) out.set(file, [...(out.get(file) ?? []), old]);
        old += 1;
        oldLeft -= 1;
      } else if (line.startsWith("+")) newLeft -= 1;
      else if (line.startsWith(" ") || line === "") {
        old += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      file = line === "--- /dev/null" ? null : line.replace(/^--- (a\/)?/, "");
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return out;
}

export interface Pull {
  number: number;
  mergedAt: string | null;
  /** The commit the merge made on its base, to ask whether it is on the default branch now. */
  mergeCommit: string | null;
}

/** What the steps ask: of git, and of GitHub. Put in by the caller, so a test can give fakes. */
export interface OriginDeps {
  /** The commit that last touched `line` of `file` at `rev`, by `git blame -w -M -C`; `null` if none. */
  blame(rev: string, file: string, line: number): string | null;
  /** Whether a commit changes whitespace only (`git show -w` of it is empty). */
  whitespaceOnly(sha: string): boolean;
  /** The first parent of a commit, to blame past one that changes whitespace only. */
  parent(sha: string): string | null;
  /** Pull requests that contain the commit. */
  pullsOf(sha: string): Pull[];
  /** The repository's pull request of that number, or `null` when the number is an issue or nothing. */
  pull(number: number): Pull | null;
  /**
   * Whether a commit is on the default branch as it is now. Asked of the merge commit, not the pull
   * request's base name: a repository that renamed `master` to `main` keeps the old name on the pull
   * requests merged before it.
   */
  onDefault(sha: string): boolean;
}

/**
 * The origin of a fix: named first; else by blame of what it removed. `fix` is its base commit and
 * merge time, `fixDiff` its diff. A named number counts only when it is a pull request of the same
 * repository, merged into the default branch before the fix: "a bug reported in #123" names an issue,
 * and "in #500 of the tokio crate" another repository.
 */
export function originOf(named: readonly number[], fix: { base: string; mergedAt: string }, fixDiff: string, deps: OriginDeps): Origin {
  const merged = (p: Pull | null): p is Pull => p !== null && p.mergedAt !== null && p.mergeCommit !== null && deps.onDefault(p.mergeCommit);
  for (const n of named) {
    const p = deps.pull(n);
    if (merged(p) && p.mergedAt! < fix.mergedAt) return { number: n, by: "named" };
  }
  const fixBase = fix.base;
  const removed = removedLines(fixDiff);
  if (removed.size === 0) return { number: null, why: "the fix removes no line and names no pull request that merged before it" };
  const byMerge = (a: Pull, b: Pull) => (a.mergedAt! < b.mergedAt! ? -1 : a.mergedAt! > b.mergedAt! ? 1 : a.number - b.number);
  const pullOf = new Map<string, Pull | null>();
  const lines = new Map<number, { pull: Pull; count: number }>();
  let blamed = 0;
  for (const [file, removedAt] of removed) {
    for (const line of removedAt) {
      // A commit that only changes whitespace is not the one that put the code there: blame past it.
      let sha = deps.blame(fixBase, file, line);
      for (let hops = 0; sha !== null && deps.whitespaceOnly(sha) && hops < 20; hops++) {
        const parent = deps.parent(sha);
        sha = parent === null ? null : deps.blame(parent, file, line);
      }
      if (sha === null) continue;
      blamed += 1;
      if (!pullOf.has(sha)) {
        pullOf.set(sha, deps.pullsOf(sha).filter(merged).sort(byMerge)[0] ?? null);
      }
      const pull = pullOf.get(sha);
      if (!pull) continue;
      const had = lines.get(pull.number);
      lines.set(pull.number, { pull, count: (had?.count ?? 0) + 1 });
    }
  }
  const ranked = [...lines.values()].sort((a, b) => b.count - a.count || byMerge(a.pull, b.pull));
  if (ranked.length === 0) return { number: null, why: "no merged pull request into the default branch holds the lines the fix removed" };
  return { number: ranked[0]!.pull.number, by: "blame", share: ranked[0]!.count / blamed };
}

interface ApiPull {
  number: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

const asPull = (p: ApiPull): Pull => ({ number: p.number, mergedAt: p.merged_at, mergeCommit: p.merged_at === null ? null : p.merge_commit_sha });

/** The deps of `originOf` for a clone of `repo` (`owner/name`) whose `defaultRef` is its default branch now. */
export function realDeps(clone: string, repo: string, defaultRef: string): OriginDeps {
  const git = (...args: string[]) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const api = (path: string) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
  return {
    onDefault(sha) {
      try {
        git("merge-base", "--is-ancestor", sha, defaultRef);
        return true;
      } catch {
        return false; // not an ancestor, or a commit the clone does not have
      }
    },
    pull(number) {
      try {
        return asPull(api(`repos/${repo}/pulls/${number}`) as ApiPull);
      } catch (error) {
        if (/HTTP 404/.test(String(error))) return null; // an issue's number, or none
        throw error;
      }
    },
    blame(rev, file, line) {
      try {
        const out = git("blame", "-w", "-M", "-C", "--porcelain", "-L", `${line},${line}`, rev, "--", file);
        return /^[0-9a-f]{40}/.exec(out)?.[0] ?? null;
      } catch {
        return null; // the file or the line is not there at `rev`
      }
    },
    // `show` rather than `diff sha^ sha`: a repository's first commit has no parent.
    whitespaceOnly: (sha) => git("show", "-w", "--format=", "--stat", sha).trim() === "",
    parent: (sha) => {
      try {
        return git("rev-parse", `${sha}^`).trim();
      } catch {
        return null;
      }
    },
    pullsOf: (sha) => (api(`repos/${repo}/commits/${sha}/pulls`) as ApiPull[]).map(asPull),
  };
}
