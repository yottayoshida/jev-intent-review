// The checks a pull request had at its merge (#89, RETRO.md v3, "Caught before the merge"): the check
// runs and commit statuses on its head that had finished by the time it merged, each as its name and
// result (every run, not only the latest of each name: a run again after the merge does not hide the one
// before it). None at all is `none`; a list GitHub cut short, or one that cannot be read, is `unknown`.

import { ghApi as api, isGone } from "./gh.ts";
import type { Checks } from "./screen.ts";

export interface RawChecks {
  mergedAt: string | null;
  runs: { total: number; items: { name: string; conclusion: string | null; completed_at: string | null }[] };
  statuses: { context: string; state: string; updated_at: string }[];
}

/** The checks finished by the merge, from what GitHub answered. */
export function checksAt(raw: RawChecks): Checks {
  if (raw.mergedAt === null) return { state: "unknown" };
  // More check runs than one page holds: the list is cut, and a cut list is not "none of them said so".
  if (raw.runs.total > raw.runs.items.length || raw.statuses.length >= 100) return { state: "unknown" };
  const items = [
    ...raw.runs.items.filter((r) => r.completed_at !== null && r.completed_at <= raw.mergedAt!).map((r) => `${r.name}: ${r.conclusion ?? "none"}`),
    ...raw.statuses.filter((s) => s.updated_at <= raw.mergedAt!).map((s) => `${s.context}: ${s.state}`),
  ];
  // "none" is a pull request with no check at all; checks that had not finished by the merge are read as an empty list.
  return raw.runs.total === 0 && raw.statuses.length === 0 ? { state: "none" } : { state: "read", items };
}

export function fetchChecks(repo: string, number: number): Checks {
  try {
    const p = api(`repos/${repo}/pulls/${number}`) as { merged_at: string | null; head: { sha: string } };
    const runs = api(`repos/${repo}/commits/${p.head.sha}/check-runs?per_page=100&filter=all`) as { total_count: number; check_runs: RawChecks["runs"]["items"] };
    const statuses = api(`repos/${repo}/commits/${p.head.sha}/statuses?per_page=100`) as RawChecks["statuses"];
    return checksAt({ mergedAt: p.merged_at, runs: { total: runs.total_count, items: runs.check_runs }, statuses });
  } catch (error) {
    // GitHub having no such record is a fact about the case; a rate limit or the network is not, and stops the run.
    if (isGone(error)) return { state: "unknown" };
    throw error;
  }
}
