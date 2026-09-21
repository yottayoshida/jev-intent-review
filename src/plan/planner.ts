// The planner: the model choosing, by id, which calls a requirement governs.
//
// It is given the requirement's text and a listing built from the commit, and nothing else. It
// cannot name a function or a call that is not in the listing — the ids are checked — and it
// cannot write the answer anywhere, because the condition is generated from what it picks.
//
// `clause` is what makes an observation bear on the requirement. A pick without one is still added
// to the set and still asked about; its answer is reported as an observation about code. Measured
// beforehand: the same model, given only the requirement's one-sentence property, picked calls
// whose names match the requirement's words rather than the mechanism it was fixed by, so what it
// is given here matters as much as what it is asked.

import { COMPILER_MODEL, readModelJson } from "../intent/compiler.ts";
import type { CloudflareClient } from "../judgments/cloudflare.ts";
import type { listingFor } from "./candidates.ts";
import type { Pick } from "./select.ts";

const MAX_PICKS = 4;

const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      maxItems: MAX_PICKS,
      items: { type: "object", properties: { callId: { type: "string" }, clause: { type: "string", maxLength: 300 } }, required: ["callId", "clause"] },
    },
    notCovered: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
  },
  required: ["picks"],
};

const INSTRUCTIONS = `You are given one requirement and a listing of the functions and calls in one file, each with an id.

Pick every call the requirement governs — the calls whose failure the requirement is about. For each, say in your own words which part of the requirement it checks.

- picks[].callId: a call id from the listing.
- picks[].clause: which part of the requirement that call is governed by, quoted or paraphrased from the requirement itself.
- notCovered: what checking these calls leaves unchecked about the requirement.

Pick the calls the requirement is about, not every call in the file, and not only one if several apply. Do not invent ids.`;

export function modelPlanner(client: CloudflareClient) {
  return {
    async pick(input: { requirement: string; file: string; listing: ReturnType<typeof listingFor> }): Promise<{ picks: Pick[]; notCovered?: string[]; failed?: string }> {
      const body = {
        messages: [
          { role: "system", content: INSTRUCTIONS },
          { role: "user", content: JSON.stringify({ requirement: input.requirement, file: input.file, listing: input.listing }) },
        ],
        response_format: { type: "json_schema", json_schema: SCHEMA },
        max_tokens: 1200,
        temperature: 0,
      };
      try {
        const answer = readModelJson(await client.post({ model: COMPILER_MODEL, input: body }, { timeoutMs: 120_000, maxRetries: 1 })) as { picks?: Pick[]; notCovered?: string[] };
        return { picks: (answer.picks ?? []).slice(0, MAX_PICKS), ...(answer.notCovered ? { notCovered: answer.notCovered } : {}) };
      } catch (error) {
        // A planner that cannot answer selects nothing, and the run goes on with whatever else
        // found candidates rather than failing the whole review. But an empty list of picks and a
        // failed request are different things, and a report that shows both as "no call carries a
        // clause" is a silent refusal wearing the clothes of a decision. So say which it was.
        return { picks: [], failed: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
