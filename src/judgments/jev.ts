// Jev (TypeSafe's typed-judgment model on Workers AI).
// https://developers.cloudflare.com/ai/models/typesafe/jev/

import type { ChoiceAnswer } from "../types.ts";
import { ProviderError, type CloudflareClient } from "./cloudflare.ts";
import type { JudgmentProvider, Questions } from "./provider.ts";

export const JEV_MODEL = "typesafe/jev";

/**
 * The object holding `answers`. The docs show it at the top level; measured, it arrives as
 * `{ result: { state: "Completed", result: { answers } } }`. Searched a few levels down either way.
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

/** Checks one answer against its question; anything off-shape is a bad response, not a guess. */
export function readChoice(key: string, raw: unknown, criteria: Record<string, string>): ChoiceAnswer {
  if (!raw || typeof raw !== "object") throw new ProviderError("bad_response", `Jev gave no answer for '${key}'`);
  const answer = raw as Record<string, unknown>;
  const choice = answer.choice;
  const confidence = answer.confidence;
  // Object.hasOwn, not `in`: "constructor" or "toString" must not pass as a choice.
  if (typeof choice !== "string" || !Object.hasOwn(criteria, choice)) throw new ProviderError("bad_response", `Jev's choice for '${key}' is not one of the offered choices`);
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) throw new ProviderError("bad_response", `Jev's confidence for '${key}' is not between 0 and 1`);
  const probabilities: Record<string, number> = {};
  if (answer.probabilities && typeof answer.probabilities === "object") {
    for (const [option, p] of Object.entries(answer.probabilities as Record<string, unknown>)) {
      if (Object.hasOwn(criteria, option) && typeof p === "number") probabilities[option] = p;
    }
  }
  return { choice, confidence, probabilities };
}

export class JevProvider implements JudgmentProvider {
  readonly model = JEV_MODEL;
  readonly #client: CloudflareClient;

  constructor(client: CloudflareClient) {
    this.#client = client;
  }

  async judge(state: unknown, questions: Questions): Promise<Record<string, ChoiceAnswer>> {
    const payload = await this.#client.post({ model: JEV_MODEL, input: { state, questions } });
    const answers = unwrapAnswers(payload);
    if (!answers) throw new ProviderError("bad_response", "Jev's response has no answers");
    const result: Record<string, ChoiceAnswer> = {};
    for (const [key, question] of Object.entries(questions)) result[key] = readChoice(key, answers[key], question.criteria);
    return result;
  }
}
