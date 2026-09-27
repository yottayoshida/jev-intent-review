// What the retrospective's tools share about calling GitHub (#89).

import { execFileSync } from "node:child_process";

/** A child's output is read, never passed through: its errors can carry a candidate's text (screen.ts). */
export const PIPED: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

/** One REST call through `gh api`, its output read, never passed through. */
export const ghApi = (path: string) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: PIPED }));

/** The reason a fix is skipped when GitHub does not serve its diff: one string, read by calibrate.ts and screen.ts. */
export const DIFF_NOT_SERVED = "its diff is not served";

/** Whether an error is GitHub refusing to serve a pull request's diff: too large (HTTP 406). A fact about the fix. */
export function diffRefused(error: unknown): boolean {
  return /HTTP 406/.test(`${(error as { stderr?: unknown } | null)?.stderr ?? ""} ${String(error)}`);
}

/** Whether an error is GitHub no longer having the record: a fact about the case, not a failure to stop on. */
export function isGone(error: unknown): boolean {
  return /did not merge|Could not resolve to a PullRequest|HTTP (404|410)/.test(`${(error as { stderr?: unknown } | null)?.stderr ?? ""} ${String(error)}`);
}
