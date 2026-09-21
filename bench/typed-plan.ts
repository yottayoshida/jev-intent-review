// A check plan as a shape that can be verified against the code, and the question built from it.
//
// `#20`'s plans were prose: a function name, an operation, a `yields` string. Two of the three
// went wrong in ways a machine could have caught before a request — a callee named as the target,
// an operation the code does not call — and `yields` went wrong in a way no existence check helps
// with: it held the expected answer instead of the operation's returned value.
//
// So the two constraints are different constraints:
//
//   - **the operation must exist in the code**, and is therefore chosen by id from a listing built
//     from the commit;
//   - **the assumed result must not**. `Err(io_error)` need not appear anywhere in the source to
//     be assumed. It is a *kind* — `"err"` — and the question's wording is generated from it, so
//     there is no field for a verdict to be written into.
//
// What a plan needs and does not get to invent: which function, which call, what that call is
// assumed to return, and what the check leaves unchecked.

import type { CallCandidate, Candidates, FunctionCandidate } from "./code-candidates.ts";
import type { ConditionV5 } from "./check-questions-v5.ts";

export const PROPERTIES = {
  call_failure_not_returned_as_success: "When the named call returns an error, the target does not return a success.",
} as const;

export type PropertyId = keyof typeof PROPERTIES;

export interface TypedPlan {
  property: PropertyId;
  targetId: string;
  failure: { kind: "call_result"; callId: string; result: "err" };
  notCovered?: string[];
}

export type PlanStage = "shape" | "property" | "target" | "call" | "binding";

export type PlanCheck =
  | { ok: true; target: FunctionCandidate; call: CallCandidate }
  | { ok: false; stage: PlanStage; reason: string };

/**
 * Whether the plan names things that are there, in stages — so a failure can be counted as the
 * kind of failure it is rather than as one undifferentiated miss. Every stage here is decided
 * against the listing, before any request.
 */
export function checkPlan(plan: unknown, candidates: Candidates): PlanCheck {
  if (!plan || typeof plan !== "object") return { ok: false, stage: "shape", reason: "the plan is not an object" };
  const p = plan as Partial<TypedPlan>;
  if (typeof p.targetId !== "string" || !p.failure || typeof p.failure !== "object") return { ok: false, stage: "shape", reason: "the plan has no targetId or no failure" };
  if (typeof p.property !== "string" || !(p.property in PROPERTIES)) return { ok: false, stage: "property", reason: `the property ${String(p.property)} is not one this bench checks` };
  const f = p.failure as Partial<TypedPlan["failure"]>;
  if (f.kind !== "call_result") return { ok: false, stage: "shape", reason: `the failure kind ${String(f.kind)} is not one this bench builds a question for` };
  if (f.result !== "err") return { ok: false, stage: "shape", reason: `the assumed result ${String(f.result)} is not one this bench builds a question for` };
  const target = candidates.functions.find((x) => x.id === p.targetId);
  if (!target) return { ok: false, stage: "target", reason: `${p.targetId} is not a function in the listing` };
  if (typeof f.callId !== "string") return { ok: false, stage: "shape", reason: "the failure has no callId" };
  const call = candidates.calls.find((x) => x.id === f.callId);
  if (!call) return { ok: false, stage: "call", reason: `${f.callId} is not a call in the listing` };
  if (call.functionId !== target.id) {
    // Two trait impls in one file are both `default`, so the ids go in the message: without them
    // a rejection reads "call-1 is inside default, not inside default".
    const owner = candidates.functions.find((x) => x.id === call.functionId);
    return { ok: false, stage: "binding", reason: `${f.callId} is inside ${owner?.name ?? "?"} (${call.functionId}), not inside ${target.name} (${target.id})` };
  }
  return { ok: true, target, call };
}

/**
 * The condition, built from the plan rather than written by whoever made it.
 *
 * `setup` says the call is reached, which is what makes an early return above it irrelevant
 * without anyone having to notice the early return. `yields` comes from the kind, so the field
 * that held "an error instead of hanging the process" in `#20` no longer exists to be filled.
 *
 * **It names the call and quotes nothing.** The first version said
 * `Execution reaches line 322, \`let content = …?;\`` — and the mutation rewrites that very line,
 * so the condition contradicted the body it was asked about and the answer weakened to 1 of 3
 * (`bench/logs/typed-plan-v1.json`). A condition has to hold across the versions being compared,
 * and a line number and a source line are the two things a mutation moves.
 */
export function conditionFrom(target: FunctionCandidate, call: CallCandidate): ConditionV5 {
  return {
    target: target.name,
    setup: `Execution reaches the call to \`${call.callee}\` inside \`${target.name}\`.`,
    occurrence: "There",
    operation: `\`${call.callee}\``,
    yields: "an error",
    others: "Every other operation the function reaches succeeds.",
    extra: "",
  };
}

/**
 * What a question of this kind needs in the packet besides the target's body.
 *
 * `call_result` stipulates what the call returns, so the callee's body settles nothing further —
 * measured in `bench/logs/referent-needed-v1.json`, where taking it out left every cell at
 * 0.98-1.00. A kind that assumed an *input* to the callee instead would need it, which is why
 * this is a function of the kind rather than a field a plan fills in.
 */
export function referentsFor(kind: TypedPlan["failure"]["kind"]): string[] {
  switch (kind) {
    case "call_result":
      return [];
    default:
      return [];
  }
}
