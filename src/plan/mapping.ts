// Whether a requirement requires anything of a particular call — and what can be checked about
// that answer in code.
//
// The local check can now find the call a change was made at and read what the function returns
// when it fails. That is a fact about code. Turning it into something a person should look at
// needs one more link: does the requirement *require* that of this call? Nothing measured so far
// answers it. The planner's clause is written while choosing where to look, about a file the
// requirement's words opened; a call the diff found has no clause at all.
//
// So the mapping is asked separately, about the calls that are actually being checked, and it is
// given the requirement, the call and the function — **never the local answer**. An answer that
// knew what the code does would be free to agree with it.
//
// Two things are kept apart here, and the distinction is the point of the file:
//
//   - **what code can check**: the call id is one this run offered, the quote is really in the
//     requirement, the shape is the shape asked for. A mapping that fails these is refused.
//   - **whether it is right**: nothing here establishes that. A mapping can name a real call and
//     quote the requirement accurately and still be wrong about what the sentence requires.
//
// `unknown` is a first-class answer, and so is a request that did not come back. They are not the
// same as `does_not_apply`, and a report that shows the three alike would be the silent-refusal
// shape this path keeps running into.

import { COMPILER_MODEL, readModelJson } from "../intent/compiler.ts";
import { redact } from "../evidence/redact.ts";
import type { CloudflareClient } from "../judgments/cloudflare.ts";

/**
 * The only property this asks about, for now.
 *
 * It is the one the local check can observe: `#18`–`#23` settled its wording, and `#27` measured
 * that the observation tracks what the program does. A second property would need its own
 * question and its own measurement.
 */
export const MAPPING_PROPERTY = "call_failure_not_returned_as_success" as const;

export type MappingVerdict = "applies" | "does_not_apply" | "unknown";

export interface Mapping {
  callId: string;
  requirementId: string;
  verdict: MappingVerdict;
  /** The words from the requirement that decide it, copied from the requirement. */
  quote: string;
  /** Why those words govern this call. */
  reason: string;
  property: typeof MAPPING_PROPERTY;
}

export type MappingCheck =
  | { ok: true; mapping: Mapping }
  | { ok: false; kind: "unknown_call" | "quote_not_in_requirement" | "bad_shape"; reason: string };

/** Short enough and a quote is a word or two — long enough and it has to come from the sentence. */
const MIN_QUOTE = 12;

const flatten = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * What code can say about a mapping: the call is one that was offered, the quote is in the
 * requirement, the verdict is one of the three.
 *
 * Passing is not being right. A mapping that names a real call and quotes the sentence exactly can
 * still be wrong about what the sentence requires, and no check here would notice.
 */
export function checkMapping(raw: unknown, context: { callIds: ReadonlySet<string>; requirementId: string; requirementText: string }): MappingCheck {
  if (typeof raw !== "object" || raw === null) return { ok: false, kind: "bad_shape", reason: "the answer was not an object" };
  const { callId, verdict, quote, reason } = raw as Record<string, unknown>;
  if (typeof callId !== "string" || typeof verdict !== "string" || typeof quote !== "string" || typeof reason !== "string") {
    return { ok: false, kind: "bad_shape", reason: "the answer is missing callId, verdict, quote or reason" };
  }
  if (verdict !== "applies" && verdict !== "does_not_apply" && verdict !== "unknown") {
    return { ok: false, kind: "bad_shape", reason: `${verdict} is not one of applies, does_not_apply, unknown` };
  }
  if (!context.callIds.has(callId)) return { ok: false, kind: "unknown_call", reason: `${callId} is not a call this run offered` };
  // A verdict that does not apply needs no quote from the sentence: there may be nothing in it to
  // point at. One that does is a claim about particular words, and those words have to be there.
  if (verdict === "applies") {
    const flat = flatten(quote);
    if (flat.length < MIN_QUOTE) return { ok: false, kind: "quote_not_in_requirement", reason: `the quote is ${flat.length} characters, too short to have come from the requirement` };
    if (!flatten(context.requirementText).includes(flat)) return { ok: false, kind: "quote_not_in_requirement", reason: "the quote is not in the requirement's text" };
  }
  return { ok: true, mapping: { callId, requirementId: context.requirementId, verdict, quote: redact(quote).text.replace(/\s+/g, " ").trim(), reason: redact(reason).text.replace(/\s+/g, " ").trim(), property: MAPPING_PROPERTY } };
}

export interface MappingRequest {
  requirementId: string;
  requirementText: string;
  callId: string;
  /** The call, as the condition names it. Already redacted. */
  call: string;
  function: string;
  /** The function's body, as the packet carries it. Already redacted. */
  body: string;
}

export interface Mapper {
  /** `failed` separates a request that did not come back from an answer of `unknown`. */
  map(request: MappingRequest): Promise<{ raw?: unknown; failed?: string }>;
}

const SCHEMA = {
  type: "object",
  properties: {
    callId: { type: "string" },
    verdict: { type: "string", enum: ["applies", "does_not_apply", "unknown"] },
    quote: { type: "string", maxLength: 300 },
    reason: { type: "string", maxLength: 400 },
  },
  required: ["callId", "verdict", "quote", "reason"],
};

const INSTRUCTIONS = `You are given one requirement, one function, and one call inside that function.

Decide one thing: does the requirement require that, when **that call** fails, **that function** does not return a success to its caller?

- verdict: "applies" when the requirement requires that of this call. "does_not_apply" when it does not — including when the requirement explicitly allows the function to carry on, or when it is about something else entirely. "unknown" when the requirement does not settle it.
- quote: the words of the requirement that decide it, copied exactly from the requirement. Required when the verdict is "applies".
- reason: why those words govern this call.
- callId: the id you were given, copied back.

Decide what the requirement says. Do not decide what the code ought to do, and do not assume the code is right or wrong. If the requirement is about a different operation, or says nothing about what happens on a failure here, that is "does_not_apply" or "unknown" — those are proper answers, not failures.`;

export function modelMapper(client: CloudflareClient): Mapper {
  return {
    async map(request: MappingRequest): Promise<{ raw?: unknown; failed?: string }> {
      const body = {
        messages: [
          { role: "system", content: INSTRUCTIONS },
          {
            role: "user",
            content: JSON.stringify({
              requirement: { id: request.requirementId, text: redact(request.requirementText).text },
              call: { id: request.callId, expression: request.call, in: request.function },
              function: { name: request.function, code: request.body },
            }),
          },
        ],
        response_format: { type: "json_schema", json_schema: SCHEMA },
        max_tokens: 700,
        temperature: 0,
      };
      try {
        return { raw: readModelJson(await client.post({ model: COMPILER_MODEL, input: body }, { timeoutMs: 120_000, maxRetries: 1 })) };
      } catch (error) {
        return { failed: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
