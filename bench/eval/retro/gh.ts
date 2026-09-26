// What the retrospective's tools share about calling GitHub (#89).

import { execFileSync } from "node:child_process";

/** A child's output is read, never passed through: its errors can carry a candidate's text (screen.ts). */
export const PIPED: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

/** One REST call through `gh api`, its output read, never passed through. */
export const ghApi = (path: string) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: PIPED }));

/** Whether an error is GitHub no longer having the record: a fact about the case, not a failure to stop on. */
export function isGone(error: unknown): boolean {
  return /did not merge|Could not resolve to a PullRequest|HTTP (404|410)/.test(`${(error as { stderr?: unknown } | null)?.stderr ?? ""} ${String(error)}`);
}
