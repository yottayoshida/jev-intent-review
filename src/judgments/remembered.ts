// The answers kept for a pull request (ADR 0013). A judgment whose key is already here is answered
// from here and not sent; every new answer is appended as it comes back, so a run that stops early
// keeps what it was given. The key is what would be sent — host, origin, model, state and the
// questions' words — and the file holds keys and answers only, never the state, which is the
// repository's code.
//
// It wraps the provider from outside the concurrency limit, so a kept answer takes no slot and is
// not refused at the deadline, and outside `deps.judges`, so the tests that replace the judges
// still go through it.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { FORM_QUESTION } from "../plan/forms.ts";
import type { ChoiceAnswer } from "../types.ts";
import { ProviderError } from "./client.ts";
import { readChoice } from "./jev.ts";
import type { JudgmentProvider, Questions } from "./provider.ts";
import { privateParent } from "./trace.ts";

const FILE = "answers.jsonl";
const FORM_KEY = Object.keys(FORM_QUESTION)[0] as string;

class LedgerRefused extends Error {}

const refused = (what: "symlink" | "not_directory" | "not_private") =>
  new LedgerRefused({ symlink: "its path goes through a symlink", not_directory: "a part of its path is not a directory", not_private: "its directory is readable by others" }[what]);

/** What went where, for the report: nothing here is inferred from the callers' own counts. */
export interface LedgerCounts {
  /** Answers taken from the ledger instead of being sent, the form question's included: kept from an earlier run, repeated within this run, or shared with an identical request still in flight. */
  reused: number;
  /** Of `reused`, those kept from an earlier run — the only ones the report calls "from earlier runs". */
  reusedFromEarlierRuns: number;
  /**
   * Judgments — the form question aside — handed to the provider because the ledger had no answer,
   * and how many of those came back. One the run's own budget ended (its time, requests or bytes —
   * before it was sent, or before a retry) is in neither, as the callers do not count it either.
   */
  judgmentsPassedDown: number;
  judgmentsAnsweredDown: number;
  /** Judgments — the form question aside — that the run's budget ended instead (ADR 0014 reads it). */
  judgmentsEndedByBudget: number;
}

export class RememberedProvider implements JudgmentProvider {
  readonly model: string;
  readonly #inner: JudgmentProvider;
  readonly #where: { host: string; origin: string };
  readonly #file: string | null;
  readonly #kept: Map<string, unknown>;
  readonly #inFlight = new Map<string, Promise<Record<string, ChoiceAnswer>>>();
  readonly #notes: string[];
  #writes: Promise<void> = Promise.resolve();
  #unwritten = 0;
  #unusable = 0;
  readonly counts: LedgerCounts = { reused: 0, reusedFromEarlierRuns: 0, judgmentsPassedDown: 0, judgmentsAnsweredDown: 0, judgmentsEndedByBudget: 0 };
  readonly #fromEarlierRuns: Set<string>;

  private constructor(inner: JudgmentProvider, where: { host: string; origin: string }, file: string | null, kept: Map<string, unknown>, notes: string[]) {
    this.#inner = inner;
    this.model = inner.model;
    this.#where = where;
    this.#file = file;
    this.#kept = kept;
    this.#fromEarlierRuns = new Set(kept.keys());
    this.#notes = notes;
  }

  /**
   * Opens the ledger in `dir`. A directory or file that is not private is not read or written — the
   * run goes on without it and a note says why — so an answer planted where others can write is
   * never taken for Jev's.
   */
  static async open(dir: string, inner: JudgmentProvider, where: { host: string; origin: string }): Promise<RememberedProvider> {
    const file = join(dir, FILE);
    const notes: string[] = [];
    const kept = new Map<string, unknown>();
    try {
      await privateParent(file, refused);
      const existing = await lstat(file).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (existing?.isSymbolicLink()) throw new LedgerRefused("its file is a symlink");
      if (existing) {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stats = await handle.stat();
          if (!stats.isFile()) throw new LedgerRefused("its file is not a regular file");
          if ((stats.mode & 0o077) !== 0) throw new LedgerRefused("its file is readable by others");
          let malformed = 0;
          for (const line of (await handle.readFile("utf8")).split("\n")) {
            if (line.trim() === "") continue;
            try {
              const row = JSON.parse(line) as { key?: unknown; answers?: unknown };
              if (typeof row.key !== "string" || !row.answers || typeof row.answers !== "object") throw new Error("shape");
              kept.set(row.key, row.answers);
            } catch {
              malformed += 1;
            }
          }
          if (malformed > 0) notes.push(`${malformed} line(s) of the kept answers could not be read and were not used.`);
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      // Paths can hold any text; the note names the reason only.
      const why = error instanceof LedgerRefused ? error.message : "it could not be read";
      notes.push(`The answers kept in --answers were not used, and none was kept from this run: ${why}.`);
      return new RememberedProvider(inner, where, null, new Map(), notes);
    }
    return new RememberedProvider(inner, where, file, kept, notes);
  }

  /** The notes for the report, including a count of kept answers that no longer fit their question. */
  notes(): string[] {
    const out = [...this.#notes];
    if (this.#unusable > 0) out.push(`${this.#unusable} kept answer(s) did not fit the question asked now and were asked again.`);
    if (this.#unwritten > 0) out.push(`${this.#unwritten} answer(s) from this run could not be kept for a later run; they were used in this report.`);
    return out;
  }

  /** Resolves when every answer of this run has been written, or has failed to be. */
  settled(): Promise<void> {
    return this.#writes;
  }

  keyOf(state: unknown, questions: Questions): string {
    return createHash("sha256").update(JSON.stringify([this.#where.host, this.#where.origin, this.model, state, questions])).digest("hex");
  }

  async judge(state: unknown, questions: Questions): Promise<Record<string, ChoiceAnswer>> {
    const key = this.keyOf(state, questions);
    const kept = this.#file === null ? undefined : this.#kept.get(key);
    if (kept !== undefined) {
      const answers = fit(kept, questions);
      if (answers) {
        this.counts.reused += 1;
        if (this.#fromEarlierRuns.has(key)) this.counts.reusedFromEarlierRuns += 1;
        return answers;
      }
      this.#unusable += 1;
      this.#kept.delete(key);
      this.#fromEarlierRuns.delete(key);
    }
    const flying = this.#inFlight.get(key);
    if (flying) {
      // The same request is already out: share its answer, and its failure. A shared failure is
      // not counted as reused — nothing was.
      const judgment = !Object.hasOwn(questions, FORM_KEY);
      try {
        const answers = await flying;
        this.counts.reused += 1;
        return answers;
      } catch (error) {
        if (judgment && error instanceof ProviderError && error.kind === "budget") this.counts.judgmentsEndedByBudget += 1;
        throw error;
      }
    }
    const judgment = !Object.hasOwn(questions, FORM_KEY);
    const request = this.#inner.judge(state, questions);
    this.#inFlight.set(key, request);
    try {
      const answers = await request;
      if (judgment) {
        this.counts.judgmentsPassedDown += 1;
        this.counts.judgmentsAnsweredDown += 1;
      }
      this.#kept.set(key, answers);
      this.#keep(key, answers);
      return answers;
    } catch (error) {
      const budget = error instanceof ProviderError && error.kind === "budget";
      if (judgment && !budget) this.counts.judgmentsPassedDown += 1;
      if (judgment && budget) this.counts.judgmentsEndedByBudget += 1;
      throw error;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  /** Appends one line; a failure is counted and noted, never thrown — the answer was paid for. */
  #keep(key: string, answers: Record<string, ChoiceAnswer>): void {
    if (this.#file === null) return;
    const file = this.#file;
    const line = Buffer.from(`${JSON.stringify({ key, answers })}\n`, "utf8");
    this.#writes = this.#writes.then(async () => {
      try {
        await privateParent(file, refused);
        const handle = await open(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          const stats = await handle.stat();
          if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw new LedgerRefused("not private");
          const { bytesWritten } = await handle.write(line);
          if (bytesWritten !== line.length) throw new LedgerRefused("short write");
        } finally {
          await handle.close();
        }
      } catch {
        this.#unwritten += 1;
      }
    });
  }
}

/** A kept answer, read again under the question asked now: every key present, every choice offered. */
function fit(kept: unknown, questions: Questions): Record<string, ChoiceAnswer> | null {
  if (!kept || typeof kept !== "object") return null;
  const stored = kept as Record<string, unknown>;
  const out: Record<string, ChoiceAnswer> = {};
  try {
    for (const [key, question] of Object.entries(questions)) {
      if (!Object.hasOwn(stored, key)) return null;
      out[key] = readChoice(key, stored[key], question.criteria);
    }
  } catch {
    return null;
  }
  return out;
}
