// The second search of #80's sealed set (PROTOCOL.md, "Dev and sealed", rule 1): the same four phrases as
// search-v1.json, over 2026-01-01 to 2026-06-30, every range split until no phrase reaches gh search's
// silent limit of 100. Taken and committed before any of its rows is read.
//
//   node bench/eval/search-v2.ts          writes bench/eval/search-v2.json
//
// Why that range: search-v1.json took each phrase's best 100 matches with no date, so three of its four
// phrases were cut; #89's own search (retro/search-v1.json) takes everything merged from 2026-07-01 with
// the same phrases, and its repositories are left out of this set. So this set's further rows come from
// before July. A repository on the split, in search-v1.json or in #89's search is left out and counted; one
// only in pool.json is left for rule 1 to skip when its row is examined.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHRASES, queryOf, searchRange, type Hit, type Window } from "./retro/search.ts";
import type { Split } from "./split.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const SEARCH_V2 = join(HERE, "search-v2.json");
export const FROM = "2026-01-01";
export const TO = "2026-06-30";
/**
 * gh search allows 30 requests a minute; one every 2.5 s stays under it alone. `gh search prs --json` does
 * not report GitHub's `incomplete_results` (a search that timed out and returned part), so a window cut
 * short that way is not seen here — as in #89's search. A window that returns 100 is split, and none did.
 */
const PAUSE_MS = 2500;

export interface Row {
  order: number;
  ref: string;
  repo: string;
  title: string;
  closedAt: string;
  queries: string[];
}

/**
 * The rows of the range, newest merge first, numbered after search-v1.json's rows, with the repositories
 * already somewhere left out and counted. One row per reference, with every phrase that found it.
 */
export function rowsOf(hits: ReadonlyMap<string, Hit[]>, skip: { split: ReadonlySet<string>; v1: ReadonlySet<string>; retro: ReadonlySet<string> }, start: number) {
  const byRef = new Map<string, Row>();
  const seen = new Set<string>();
  const left = { onSplit: 0, inSearchV1: 0, inRetroSearch: 0, outsideRange: 0 };
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
      if (skip.split.has(repo)) left.onSplit += 1;
      else if (skip.v1.has(repo)) left.inSearchV1 += 1;
      else if (skip.retro.has(repo)) left.inRetroSearch += 1;
      else if (h.closedAt.slice(0, 10) < FROM || h.closedAt.slice(0, 10) > TO) left.outsideRange += 1;
      else byRef.set(ref, { order: 0, ref, repo, title: h.title, closedAt: h.closedAt, queries: [phrase] });
    }
  }
  const rows = [...byRef.values()].sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : a.ref < b.ref ? -1 : 1));
  rows.forEach((r, i) => (r.order = start + i + 1));
  return { rows, left };
}

function main() {
  if (existsSync(SEARCH_V2)) throw new Error(`${SEARCH_V2} exists: search-v2 is taken once, before any of its rows is read`);
  const read = <T>(p: string) => JSON.parse(readFileSync(join(HERE, p), "utf8")) as T;
  const split = new Set(read<Split>("split.json").repos.map((r) => r.repo.toLowerCase()));
  const v1 = read<{ rows: { repo: string }[] }>("search-v1.json").rows;
  const retro = new Set(read<{ rows: { repo: string }[] }>("retro/search-v1.json").rows.map((r) => r.repo.toLowerCase()));
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let calls = 0;
  let waits = 0;
  // The search quota is the account's, shared with every other session searching at the same time, so a
  // pause alone does not keep under it (the first attempt hit 403 part way). On a rate-limit answer, wait
  // until the quota resets, as GitHub says, and ask the same search again.
  const run = (p: string, f: string, t: string): Hit[] => {
    if (calls++ > 0) sleep(PAUSE_MS);
    for (let attempt = 1; ; attempt++) {
      try {
        return JSON.parse(execFileSync("gh", queryOf(p, f, t), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as Hit[];
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        if (!/rate limit/i.test(stderr) || attempt > 10) throw error;
        const reset = Number(execFileSync("gh", ["api", "rate_limit", "--jq", ".resources.search.reset"], { encoding: "utf8" }).trim());
        const ms = Math.max(5_000, reset * 1000 - Date.now() + 2_000);
        waits += 1;
        console.error(`rate limited on "${p}" ${f}..${t}; waiting ${Math.round(ms / 1000)} s`);
        sleep(ms);
      }
    }
  };
  const { windows, hits } = searchRange(FROM, TO, run, PHRASES);
  const { rows, left } = rowsOf(hits, { split, v1: new Set(v1.map((r) => r.repo.toLowerCase())), retro }, v1.length);
  const takenOn = new Date().toISOString().slice(0, 10);
  const cut = windows.filter((w: Window) => w.cut.length > 0);
  const book = {
    protocolVersion: 4,
    what: "The second search of #80's sealed set (PROTOCOL.md, rule 1): reference, title and merge time only. No body was read. Taken, and committed, before any of its rows is read.",
    phrases: PHRASES,
    range: { from: FROM, to: TO, takenOn, windows, calls, rateLimitWaits: waits, cut: cut.map((w) => ({ from: w.from, to: w.to, phrases: w.cut })) },
    order: "after search-v1.json's rows; closedAt descending, then reference",
    left,
    rows,
  };
  writeFileSync(SEARCH_V2, `${JSON.stringify(book, null, 2)}\n`);
  console.log(`${FROM}..${TO}: ${windows.length} windows, ${calls} searches, ${rows.length} rows kept (${new Set(rows.map((r) => r.repo)).size} repositories); left out ${JSON.stringify(left)}${cut.length > 0 ? `; CUT on ${cut.length} one-day windows` : ""}`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
