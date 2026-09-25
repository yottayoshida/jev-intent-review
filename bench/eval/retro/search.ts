// The searches for the retrospective's later fixes (#89, bench/eval/RETRO.md, "Candidates").
//
//   node bench/eval/retro/search.ts <from YYYY-MM-DD> <to YYYY-MM-DD>   one range of merge dates
//
// The same four phrases as #80's search (`bench/eval/search-v1.json`), merged pull requests in Rust.
// `gh search` returns at most 100 results and says nothing when it stops there, so a range where any
// phrase returns 100 is split in two and each half searched again, down to a single day; a day that
// still returns 100 is recorded as cut. Only days that have ended are searched. A repository already on
// the split, or in #80's search, is left out: this measurement's sealed repositories are its own
// (agreed with the #80 side, 2026-09-25). Only reference, title and merge time are kept; no body is read.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Split } from "../split.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** This measurement's search — not `bench/eval/search-v1.json`, which is #80's. */
export const SEARCH = join(HERE, "search-v1.json");

export const PHRASES = ["propagate error instead of silently", "error treated as success", "ignored error", "swallow error"] as const;

/** The earliest merge of a later fix: after the annotators' model's training data ends (June 2026). */
export const EARLIEST_FIX = "2026-07-01";

/** `gh search`'s most results for one query. */
export const LIMIT = 100;

export interface Row {
  order: number;
  ref: string;
  repo: string;
  title: string;
  closedAt: string;
  queries: string[];
}

export interface Window {
  from: string;
  to: string;
  /** Results per phrase; a phrase at `LIMIT` on a single day is in `cut`. */
  found: Record<string, number>;
  cut: string[];
}

export interface Search {
  what: string;
  earliestFix: string;
  ranges: { from: string; to: string; takenOn: string; windows: Window[]; kept: number; left: { onSplit: number; inSearchOf80: number; beforeEarliest: number } }[];
  rows: Row[];
}

export interface Hit {
  number: number;
  title: string;
  repository: { nameWithOwner: string };
  closedAt: string;
}

export const queryOf = (phrase: string, from: string, to: string) => ["search", "prs", "--language", "rust", "--merged", "--merged-at", `${from}..${to}`, "--limit", String(LIMIT), "--json", "number,title,repository,url,closedAt", "--", phrase];

const day = (d: string, plus: number) => new Date(Date.parse(`${d}T00:00:00Z`) + plus * 86_400_000).toISOString().slice(0, 10);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * Every result of the phrases in `from..to`, splitting any range where a phrase reaches `LIMIT`.
 * `run` is the search itself, put in so a test can give a fake. `phrases` defaults to this search's
 * four; #80's `search-v2.ts` passes the same four for its own range.
 */
export function searchRange(from: string, to: string, run: (phrase: string, from: string, to: string) => Hit[], phrases: readonly string[] = PHRASES): { windows: Window[]; hits: Map<string, Hit[]> } {
  const found = new Map(phrases.map((p) => [p, run(p, from, to)] as const));
  const full = [...found].filter(([, h]) => h.length >= LIMIT).map(([p]) => p);
  if (full.length > 0 && from < to) {
    const mid = day(from, Math.floor(days(from, to) / 2) - 1);
    const a = searchRange(from, mid, run, phrases);
    const b = searchRange(day(mid, 1), to, run, phrases);
    return { windows: [...a.windows, ...b.windows], hits: new Map(phrases.map((p) => [p, [...a.hits.get(p)!, ...b.hits.get(p)!]])) };
  }
  return { windows: [{ from, to, found: Object.fromEntries([...found].map(([p, h]) => [p, h.length])), cut: full }], hits: found as Map<string, Hit[]> };
}

/**
 * The rows of a range, newest merge first, with the repositories of the split and of #80's search and
 * the fixes merged before `EARLIEST_FIX` left out and counted.
 */
export function rowsOf(hits: ReadonlyMap<string, Hit[]>, split: ReadonlySet<string>, of80: ReadonlySet<string>, start: number): { rows: Row[]; left: Search["ranges"][number]["left"] } {
  const byRef = new Map<string, Row>();
  const seen = new Set<string>();
  const left = { onSplit: 0, inSearchOf80: 0, beforeEarliest: 0 };
  for (const [phrase, list] of hits) {
    for (const h of list) {
      const repo = h.repository.nameWithOwner.toLowerCase();
      const ref = `${h.repository.nameWithOwner}#${h.number}`;
      const had = byRef.get(ref);
      if (had) {
        if (!had.queries.includes(phrase)) had.queries.push(phrase);
        continue;
      }
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (split.has(repo)) left.onSplit += 1;
      else if (of80.has(repo)) left.inSearchOf80 += 1;
      else if (h.closedAt < EARLIEST_FIX) left.beforeEarliest += 1;
      else byRef.set(ref, { order: 0, ref, repo, title: h.title, closedAt: h.closedAt, queries: [phrase] });
    }
  }
  const rows = [...byRef.values()].sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : a.ref < b.ref ? -1 : 1));
  rows.forEach((r, i) => (r.order = start + i + 1));
  return { rows, left };
}

/**
 * The repositories of #80's searches — `search-v1.json`, and `search-v2.json` since #80's protocol
 * version 4 — which this search leaves out, so the two measurements never share a repository.
 */
export function searchOf80(evalDir: string): Set<string> {
  const out = new Set<string>();
  for (const f of ["search-v1.json", "search-v2.json"]) {
    const p = join(evalDir, f);
    if (!existsSync(p)) continue;
    for (const r of (JSON.parse(readFileSync(p, "utf8")) as { rows: { repo: string }[] }).rows) out.add(r.repo.toLowerCase());
  }
  return out;
}

/** Days a range's last day must be behind today (UTC): GitHub's search index takes a while to fill in. */
export const SETTLE_DAYS = 2;

/**
 * Why a range may not be searched, or `null`. Ranges go newest first and never overlap, so the rows'
 * recorded order is newest first: a new range ends before every range already searched begins.
 */
export function rangeProblem(from: string, to: string, today: string, searched: readonly { from: string }[]): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return "usage: search.ts <from YYYY-MM-DD> <to YYYY-MM-DD>";
  if (from < EARLIEST_FIX) return `fixes merged before ${EARLIEST_FIX} are not candidates`;
  if (to > day(today, -SETTLE_DAYS)) return `${to} is less than ${SETTLE_DAYS} days old (UTC); the search index may not have it all yet`;
  const oldest = searched.map((r) => r.from).sort()[0];
  if (oldest !== undefined && to >= oldest) return `${from}..${to} does not end before ${oldest}, the oldest range searched; ranges are added newest first`;
  return null;
}

/** Dev's extra material for the calibration (RETRO.md v2): the same search, kept to the split's dev repositories. */
export const DEV_SEARCH = join(HERE, "search-dev-v1.json");

/**
 * The dev rows of a range: repositories on the dev side of the split only, fixes from `EARLIEST_FIX`.
 * Written to `DEV_SEARCH`, never to the sealed search: the sealed record's order and counts are its own.
 */
export function devRowsOf(hits: ReadonlyMap<string, Hit[]>, dev: ReadonlySet<string>, start: number): { rows: Row[]; left: { notDev: number; beforeEarliest: number } } {
  const everyone = new Set<string>();
  for (const list of hits.values()) for (const h of list) everyone.add(h.repository.nameWithOwner.toLowerCase());
  const notDev = new Set([...everyone].filter((r) => !dev.has(r)));
  const { rows, left } = rowsOf(hits, notDev, new Set(), start);
  return { rows, left: { notDev: left.onSplit, beforeEarliest: left.beforeEarliest } };
}

function main(first: string, second: string, third: string) {
  const isDev = first === "--dev";
  const [from, to] = isDev ? [second, third] : [first, second];
  const file = isDev ? DEV_SEARCH : SEARCH;
  const today = new Date().toISOString().slice(0, 10);
  const splitRepos = (JSON.parse(readFileSync(join(HERE, "..", "split.json"), "utf8")) as Split).repos;
  const split = new Set(splitRepos.map((r) => r.repo.toLowerCase()));
  const dev = new Set(splitRepos.filter((r) => r.side === "dev").map((r) => r.repo.toLowerCase()));
  const of80 = searchOf80(join(HERE, ".."));
  const what = isDev
    ? "Dev's extra material for the hindsight check's calibration (RETRO.md v2): the same searches, kept to repositories on the dev side of split.json. Not the sealed search."
    : "The raw results of the retrospective's searches (RETRO.md, \"Candidates\"): reference, title and merge time only. No body was read. Ranges are added newest first, each recorded before any of its rows is read.";
  const book: Search = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { what, earliestFix: EARLIEST_FIX, ranges: [], rows: [] };
  const problem = rangeProblem(from, to, today, book.ranges);
  if (problem !== null) throw new Error(problem);
  // GitHub's search allows 30 requests a minute, apart from the API's hourly budget: one every 2.1 s.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const run = (p: string, f: string, t: string) => {
    Atomics.wait(pause, 0, 0, 2100);
    return JSON.parse(execFileSync("gh", queryOf(p, f, t), { encoding: "utf8" })) as Hit[];
  };
  const { windows, hits } = searchRange(from, to, run);
  const kept = isDev ? devRowsOf(hits, dev, book.rows.length) : rowsOf(hits, split, of80, book.rows.length);
  const { rows, left } = kept as { rows: Row[]; left: Search["ranges"][number]["left"] };
  book.ranges.push({ from, to, takenOn: today, windows, kept: rows.length, left });
  book.rows.push(...rows);
  writeFileSync(file, `${JSON.stringify(book, null, 2)}\n`);
  const cut = windows.filter((w) => w.cut.length > 0);
  console.log(`${from}..${to}: ${windows.length} windows, ${rows.length} rows kept; left out ${JSON.stringify(left)}${cut.length > 0 ? `; CUT on ${cut.map((w) => `${w.from} (${w.cut.join(", ")})`).join("; ")}` : ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv[2] ?? "", process.argv[3] ?? "", process.argv[4] ?? "");
