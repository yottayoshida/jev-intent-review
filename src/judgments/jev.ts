// Jev (TypeSafe's typed-judgment model), on whichever host the client was given.
// https://docs.typesafe.ai/api · https://developers.cloudflare.com/ai/models/typesafe/jev/

import type { ChoiceAnswer } from "../types.ts";
import { ProviderError, type JevClient } from "./client.ts";
import type { JudgmentProvider, Questions } from "./provider.ts";

/**
 * The object holding `answers`. TypeSafe and Vercel put it at the top level; Cloudflare, measured,
 * as `{ result: { state: "Completed", result: { answers } } }`. Searched a few levels down either way.
 */
export function unwrapAnswers(payload: unknown): Record<string, unknown> | null {
  let node: unknown = payload;
  for (let depth = 0; depth < 5 && node && typeof node === "object"; depth++) {
    const obj = node as Record<string, unknown>;
    if (obj.answers && typeof obj.answers === "object" && !Array.isArray(obj.answers)) return obj.answers as Record<string, unknown>;
    node = obj.result;
  }
  return null;
}

/** A probability: a finite number from 0 to 1. `1e999` parses to Infinity and is not one. */
function isProbability(p: unknown): p is number {
  return typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;
}

/**
 * Checks one answer against its question; anything off-shape is a bad response, not a guess.
 *
 * The number every decision reads is the chosen option's probability: `probabilities[choice]` when
 * the answer gives it, else `confidence`. That number is what is checked, and it is kept as
 * `probability` so that nothing downstream falls back to anything else. `confidence` itself is
 * optional: TypeSafe documents it on every choice answer, but a gateway's copy of the shape may
 * leave it out, and no decision needs it when the probabilities are there.
 */
export function readChoice(key: string, raw: unknown, criteria: Record<string, string>): ChoiceAnswer {
  if (!raw || typeof raw !== "object") throw new ProviderError("bad_response", `Jev gave no answer for '${key}'`);
  const answer = raw as Record<string, unknown>;
  const choice = answer.choice;
  // Object.hasOwn, not `in`: "constructor" or "toString" must not pass as a choice.
  if (typeof choice !== "string" || !Object.hasOwn(criteria, choice)) throw new ProviderError("bad_response", `Jev's choice for '${key}' is not one of the offered choices`);
  const probabilities: Record<string, number> = {};
  if (answer.probabilities !== undefined && answer.probabilities !== null) {
    if (typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)) throw new ProviderError("bad_response", `Jev's probabilities for '${key}' are not a map of options`);
    for (const [option, p] of Object.entries(answer.probabilities as Record<string, unknown>)) {
      if (!Object.hasOwn(criteria, option)) continue; // an option this tool did not offer decides nothing
      if (!isProbability(p)) throw new ProviderError("bad_response", `Jev's probability of '${option}' for '${key}' is not between 0 and 1`);
      probabilities[option] = p;
    }
  }
  // `null` is absent, as for `probabilities`: a gateway that writes every field it knows of is not wrong.
  const confidence = answer.confidence === null ? undefined : answer.confidence;
  if (confidence !== undefined && !isProbability(confidence)) throw new ProviderError("bad_response", `Jev's confidence for '${key}' is not between 0 and 1`);
  const probability = Object.hasOwn(probabilities, choice) ? probabilities[choice] : confidence;
  if (probability === undefined) throw new ProviderError("bad_response", `Jev's answer for '${key}' gives no probability for its choice`);
  return { choice, probability, probabilities, ...(confidence === undefined ? {} : { confidence }) };
}

export class JevProvider implements JudgmentProvider {
  readonly model: string;
  readonly #client: JevClient;

  constructor(client: JevClient) {
    this.#client = client;
    this.model = client.model;
  }

  async judge(state: unknown, questions: Questions): Promise<Record<string, ChoiceAnswer>> {
    const payload = await this.#client.post(this.#client.request(state, questions));
    // An answer this tool cannot read is the host's, and says so: a user on a host the maintainer
    // has not called can report it with where it came from.
    const where = this.#client.where;
    try {
      const answers = unwrapAnswers(payload);
      if (!answers) throw new ProviderError("bad_response", "Jev's response has no answers");
      const result: Record<string, ChoiceAnswer> = {};
      for (const [key, question] of Object.entries(questions)) result[key] = readChoice(key, answers[key], question.criteria);
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw new ProviderError(error.kind, `${where}: ${error.message}`, error.status, where);
      throw error;
    }
  }
}
