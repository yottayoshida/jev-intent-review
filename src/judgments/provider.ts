// The judgment interface (spec §29) and the wrapper that limits how many judgments run at once.
// Adapters other than Jev implement JudgmentProvider; nothing else changes. The request, byte and
// time budget is enforced by the transport (JevClient), the only place that sees every
// request actually sent, retries included.

import type { ChoiceAnswer } from "../types.ts";
import { ProviderError } from "./client.ts";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export type Questions = Record<string, ChoiceQuestion>;

export interface JudgmentProvider {
  readonly model: string;
  /** One answer per question key. `state` is data only; `questions` are this tool's constants. */
  judge(state: unknown, questions: Questions): Promise<Record<string, ChoiceAnswer>>;
}

/** Runs at most `concurrency` judgments at once, and none that would start after `deadline`. */
export class LimitedProvider implements JudgmentProvider {
  readonly model: string;
  readonly #inner: JudgmentProvider;
  readonly #concurrency: number;
  readonly #deadline: number;
  readonly #now: () => number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(inner: JudgmentProvider, limits: { concurrency: number; deadline: number }, now: () => number = Date.now) {
    this.#inner = inner;
    this.model = inner.model;
    this.#concurrency = limits.concurrency;
    this.#deadline = limits.deadline;
    this.#now = now;
  }

  async judge(state: unknown, questions: Questions): Promise<Record<string, ChoiceAnswer>> {
    if (this.#now() > this.#deadline) throw new ProviderError("budget", "time limit reached");
    // A finished call hands its slot straight to the next waiter, so a newcomer can never slip in
    // between the release and the waiter resuming.
    if (this.#running >= this.#concurrency) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#running += 1;
    try {
      // The wait for a slot can outlast the deadline; check again before starting.
      if (this.#now() > this.#deadline) throw new ProviderError("budget", "time limit reached");
      return await this.#inner.judge(state, questions);
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running -= 1;
    }
  }
}
