// Scripted stand-ins for the judgment provider. They decide from the evidence packet (what the real
// model sees), so a test states which paths it treats as violating and nothing else.

import type { JudgmentProvider, Questions } from "../../src/judgments/provider.ts";
import type { ChoiceAnswer } from "../../src/types.ts";

export function answer(choice: string, p = 0.9): ChoiceAnswer {
  return { choice, probability: p, confidence: p, probabilities: { [choice]: p } };
}

export interface PacketLike {
  candidate?: { path?: string; symbol?: string };
  evidence?: { code?: string; related?: { path: string; code: string }[]; truncated?: boolean };
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
 * One Jev for the run's questions, reading the packet the way the measured model did on the
 * fixtures: the requirement governs every call it is asked about (`mapping`); under an assumed
 * failure a call followed by `?` propagates and any other returns a success; in the forbidden case
 * a call is made unless a check named `guard` comes before it in the body; and every change is
 * `justification`. The two readings never agree by construction: one is scripted, one is read.
 */
export function formsProvider(options: { mapping?: ChoiceAnswer; guard?: string; justification?: string; form?: ChoiceAnswer } = {}): ScriptedProvider {
  const mapping = options.mapping ?? answer("applies");
  return new ScriptedProvider((state, questions): Record<string, ChoiceAnswer> => {
    const body = state.evidence?.code ?? "";
    const flat = body.replace(/\s+/g, " ");
    const out: Record<string, ChoiceAnswer> = {};
    for (const key of Object.keys(questions)) {
      // The one question about the sentence alone: it names no call, and a scripted `neither` keeps
      // every other test on the default form, as before.
      if (key === "requirement_form") {
        out[key] = options.form ?? answer("neither");
        continue;
      }
      const instructions = (questions[key] as { instructions: string }).instructions;
      // The call the question names. A template that stops naming it would make every reading below
      // trivially true, so this stops instead.
      const named = /the call `([^`]+)`/.exec(instructions)?.[1];
      if (named === undefined && key !== "justification") throw new Error(`the ${key} question does not name its call: ${instructions.slice(0, 80)}`);
      if (key === "requirement_governs") out[key] = mapping;
      else if (key === "on_error_result") out[key] = answer(flat.includes(`${named!}?`) ? "returns_error" : "returns_success");
      else if (key === "on_error_control") out[key] = answer("stops_there");
      else if (key === "in_forbidden_case") {
        const guarded = options.guard !== undefined && body.indexOf(`${options.guard}(`) >= 0 && body.indexOf(`${options.guard}(`) < body.indexOf(named!);
        out[key] = answer(guarded ? "does_not_reach" : "reaches_it");
      } else if (key === "justification") out[key] = answer(options.justification ?? "clearly_required");
      else out[key] = answer("cannot_tell");
    }
    return out;
  });
}
