// 01's N=1 record around the first `claude -p` of a sealed run (BASELINE.md, "Sealed"): the workspace's
// `origin/main` and omamori's audit log, before and after. #80's own copy of what #89's
// `retro/calibrate.ts` has, so that a change there does not change a file `run.ts` holds a sealed
// opening to (the second opening, cccf7838, was refused for that: #118 changed `retro/calibrate.ts`
// between its `open` and its `run`).

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUDIT = join(homedir(), ".local", "share", "omamori", "audit.jsonl");

/** The workspace's main and tree, and the audit log's size. */
export function workspaceState() {
  const ws = join(homedir(), "claude_workspace");
  return {
    originMain: execFileSync("git", ["-C", ws, "log", "origin/main", "--format=%H %s", "-1"], { encoding: "utf8" }).trim(),
    statusLines: execFileSync("git", ["-C", ws, "status", "--short"], { encoding: "utf8" }).split("\n").filter(Boolean).length,
    auditBytes: existsSync(AUDIT) ? statSync(AUDIT).size : null,
  };
}

/**
 * Whether the N=1 runs left a mark of their own. Other sessions work in the same workspace, so a moved
 * `origin/main` or a longer `git status` is recorded and not taken for these runs': what refuses is what
 * only they could make — an auto-backup commit (the SessionEnd hook, which a `claude -p` loading user
 * settings would fire) or the audit log naming their directory — or no answer to count.
 */
export function n1Problem(arrived: readonly string[], appendedAudit: string, emptyDir: string, counted: boolean): string | null {
  if (!counted) return "the N=1 run gave no answer that could be counted";
  // Every commit that reached main during the run, not only the newest: another session's may be on top.
  const backup = arrived.find((subject) => /^Auto-backup:/.test(subject));
  if (backup !== undefined) return `an auto-backup commit reached the workspace's main during the N=1 run: ${backup}`;
  if (appendedAudit.includes(emptyDir)) return "omamori's audit log names the N=1 run's directory";
  return null;
}

/** Subjects of the commits on the workspace's `origin/main` after `from` and up to `to`. */
export function arrivedBetween(from: string, to: string): string[] {
  if (from === to) return [];
  const ws = join(homedir(), "claude_workspace");
  return execFileSync("git", ["-C", ws, "log", "--format=%s", `${from.split(" ")[0]}..${to.split(" ")[0]}`], { encoding: "utf8" }).split("\n").filter(Boolean);
}

/** What the audit log gained since it was `from` bytes long (a rotated log is read from its start). */
export function readAppended(from: number | null): string {
  if (from === null || !existsSync(AUDIT)) return "";
  const size = statSync(AUDIT).size;
  if (size < from) from = 0;
  if (size === from) return "";
  const fd = openSync(AUDIT, "r");
  try {
    const buf = Buffer.alloc(Math.min(size - from, 16 * 1024 * 1024));
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
