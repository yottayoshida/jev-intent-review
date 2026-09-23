// What the runs of one pull request have sent together (ADR 0014). One line is written to
// `sent.log`, in the directory of kept answers, just before each request leaves — a retry included —
// so a run stopped halfway, or cancelled by a later push, has still counted what it sent.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { ProviderError } from "./client.ts";
import { privateParent } from "./trace.ts";

const FILE = "sent.log";

class BudgetRefused extends Error {}

const refused = (what: "symlink" | "not_directory" | "not_private") =>
  new BudgetRefused({ symlink: "its path goes through a symlink", not_directory: "a part of its path is not a directory", not_private: "its directory is readable by others" }[what]);

export class PullRequestBudget {
  readonly #file: string;
  /** What earlier runs of the pull request sent, read once when the run starts. */
  readonly before: number;
  /** Requests this run did not send because their line could not be written. */
  unwritten = 0;

  private constructor(file: string, before: number) {
    this.#file = file;
    this.before = before;
  }

  /** The count so far, or why it cannot be kept here — a file or directory others can read, or a symlink. */
  static async open(dir: string): Promise<PullRequestBudget | { refused: string }> {
    const file = join(dir, FILE);
    try {
      await privateParent(file, refused);
      let existing;
      try {
        existing = lstatSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing?.isSymbolicLink()) throw new BudgetRefused("its file is a symlink");
      let before = 0;
      if (existing) {
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stats = fstatSync(fd);
          if (!stats.isFile()) throw new BudgetRefused("its file is not a regular file");
          if ((stats.mode & 0o077) !== 0) throw new BudgetRefused("its file is readable by others");
          before = readFileSync(fd, "utf8").split("\n").filter((line) => line.trim() !== "").length;
        } finally {
          closeSync(fd);
        }
      }
      return new PullRequestBudget(file, before);
    } catch (error) {
      return { refused: error instanceof BudgetRefused ? error.message : "it could not be read" };
    }
  }

  /**
   * One request is about to leave. Synchronous, so the line is on disk before the request is: a run
   * killed while it waits for the answer has still counted it. A line that cannot be written stops
   * the request — sending it uncounted would pass the limit without a word.
   */
  record(): void {
    try {
      const fd = openSync(this.#file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        if ((fstatSync(fd).mode & 0o077) !== 0) throw new BudgetRefused("not private");
        writeSync(fd, "1\n");
      } finally {
        closeSync(fd);
      }
    } catch {
      this.unwritten += 1;
      throw new ProviderError("budget", "the pull request's count could not be written, so the request was not sent");
    }
  }
}
