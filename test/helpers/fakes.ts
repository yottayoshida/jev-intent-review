// Scripted stand-ins for the judgment provider. They decide from the evidence packet (what the real
// model sees), so a test states which paths it treats as violating and nothing else.

import { isTestPath } from "../../src/discovery/discover.ts";
import type { JudgmentProvider, Questions } from "../../src/judgments/provider.ts";
import type { ChoiceAnswer } from "../../src/types.ts";

export function answer(choice: string, p = 0.9): ChoiceAnswer {
  return { choice, confidence: p, probabilities: { [choice]: p } };
}

export interface PacketLike {
  candidate?: { path?: string; symbol?: string };
  evidence?: { code?: string; related?: { path: string; code: string }[]; truncated?: boolean };
  found?: unknown[];
}

export class ScriptedProvider implements JudgmentProvider {
  readonly model = "scripted";
  readonly calls: { state: PacketLike; questions: string[] }[] = [];
  readonly #script: (state: PacketLike, questions: Questions) => Record<string, ChoiceAnswer>;

  constructor(script: (state: PacketLike, questions: Questions) => Record<string, ChoiceAnswer>) {
    this.#script = script;
  }

  async judge(state: unknown, questions: Questions): Promise<Record<string, ChoiceAnswer>> {
    this.calls.push({ state: state as PacketLike, questions: Object.keys(questions) });
    return this.#script(state as PacketLike, questions);
  }
}

/**
 * Violations where the candidate's code reaches `governed` without `guard` in it or in its related
 * context; satisfied where the guard is there; unrelated elsewhere. `complete` answers the
 * completeness question.
 */
export function guardProvider(governed: string, guard: string, complete = "likely_complete"): ScriptedProvider {
  return new ScriptedProvider((state, questions): Record<string, ChoiceAnswer> => {
    if ("completeness" in questions) return { completeness: answer(complete) };
    const code = state.evidence?.code ?? "";
    const context = [code, ...(state.evidence?.related ?? []).map((r) => r.code)].join("\n");
    // As the real model answered for the fixture's test file (unrelated, 0.83).
    if (isTestPath(state.candidate?.path ?? "")) return { relevance: answer("unrelated"), satisfaction: answer("not_applicable") };
    if (!code.includes(`${governed}(`)) return { relevance: answer("unrelated"), satisfaction: answer("not_applicable") };
    if (context.includes(guard)) return { relevance: answer("directly_enforces"), satisfaction: answer("satisfies") };
    return { relevance: answer("may_violate"), satisfaction: answer("violates") };
  });
}
