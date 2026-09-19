// One bounded evidence packet per requirement × candidate (spec §15). Everything in a packet is
// data for Jev's `state`; the questions stay constant.
//
// The related context is what decides a guard that lives outside the candidate: the lines that
// call or register it (a route, a job, an event handler), and one hop further, the definition of a
// function named on those lines (the middleware on the route). Measured on the missed-path
// fixture: with the route line alone Jev answers "insufficient evidence" for a path the
// middleware protects; with the middleware's body it answers "satisfies".

import { defines } from "../change/blocks.ts";
import { calledNames, identifiers } from "../change/seeds.ts";
import { IMPORT_LINE, type Discoverer } from "../discovery/discover.ts";
import type { Candidate, Location, Requirement } from "../types.ts";
import { cut, redact } from "./redact.ts";

export interface EvidenceLimits {
  maxPrimaryChars: number;
  maxRelatedChars: number;
}

export interface Related {
  path: string;
  lines: string;
  code: string;
}

export interface Packet {
  requirement: { id: string; text: string };
  candidate: { path: string; lines: string; symbol?: string; changed_by_pull_request: boolean };
  evidence: { code: string; related: Related[]; truncated: boolean };
}

export interface Evidence {
  packet: Packet;
  truncated: boolean; // the candidate or its context was cut, or stood in for by a window
  sent: Location[]; // every range whose text is in the packet
  redactions: number;
  callSites: Location[]; // where the candidate's governed calls sit, to point a reader at
}

const MAX_CALLERS = 6;
const MAX_DEFINITIONS = 8;
const CALLER_CONTEXT = 1; // lines above and below a caller line that is not inside a short function
const CALLER_BLOCK_LINES = 40;

const span = (start: number, end: number) => (start === end ? `${start}` : `${start}-${end}`);

/** A line with its string literals emptied: a route path like "/login/api-key" names no function. */
export function withoutStrings(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

function slice(lines: readonly string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join("\n");
}

export async function buildEvidence(discoverer: Discoverer, requirement: Requirement, candidate: Candidate, limits: EvidenceLimits): Promise<Evidence> {
  const index = await discoverer.index(candidate.path);
  const lines = index?.lines ?? [];
  let redactions = 0;
  const clean = (text: string) => {
    const r = redact(text);
    redactions += r.count;
    return r.text;
  };

  const body = slice(lines, candidate.startLine, candidate.endLine);
  const primary = cut(clean(body), limits.maxPrimaryChars);
  const sent: Location[] = [{ path: candidate.path, startLine: candidate.startLine, endLine: candidate.endLine }];
  const related: Related[] = [];
  let relatedTruncated = false;
  let room = limits.maxRelatedChars;

  const push = (path: string, start: number, end: number, text: string): boolean => {
    const code = clean(text);
    if (code.length > room) {
      relatedTruncated = true;
      return false;
    }
    room -= code.length;
    related.push({ path, lines: span(start, end), code });
    sent.push({ path, startLine: start, endLine: end });
    return true;
  };

  // Where the candidate is called or registered from. If its name is defined more than once in the
  // repository, these lines may belong to the other definition (no name resolution here), so the
  // context cannot vouch for anything.
  const nearby: string[] = [];
  const symbol = candidate.symbol;
  if (symbol && limits.maxRelatedChars > 0) {
    const { hits, more } = await discoverer.search(symbol);
    const definitions = hits.filter((h) => defines(h.text, symbol));
    if (definitions.length > 1) relatedTruncated = true;
    const outside = hits.filter(
      (h) =>
        !(h.path === candidate.path && h.line >= candidate.startLine && h.line <= candidate.endLine) &&
        !defines(h.text, symbol) &&
        !IMPORT_LINE.test(h.text),
    );
    if (more || outside.length > MAX_CALLERS) relatedTruncated = true;
    for (const hit of outside.slice(0, MAX_CALLERS)) {
      const callerIndex = await discoverer.index(hit.path);
      if (!callerIndex) continue;
      // The whole calling function when it is short: a guard often sits in the caller, a few lines
      // away from the call (measured: with the call line alone, a helper whose caller checks the
      // user right after it answered "insufficient evidence"). A route table line stays a line.
      const block = callerIndex.enclosing(hit.line);
      const whole = !block.windowed && block.name !== undefined && block.endLine - block.startLine < CALLER_BLOCK_LINES;
      const start = whole ? block.startLine : Math.max(1, hit.line - CALLER_CONTEXT);
      const end = whole ? block.endLine : Math.min(callerIndex.lines.length, hit.line + CALLER_CONTEXT);
      if (!push(hit.path, start, end, slice(callerIndex.lines, start, end))) break;
      nearby.push(hit.text);
    }
  }

  // One hop: the bodies of functions named on those lines (a middleware on a route) and of
  // functions the candidate itself calls (a guard helper such as `assertActive(user)`). A body that
  // exists but does not fit marks the evidence cut: the guard could be in it.
  const named = new Set<string>();
  for (const text of nearby) for (const id of identifiers(withoutStrings(text))) if (id !== symbol && id.length >= 5) named.add(id);
  for (const name of calledNames(withoutStrings(body))) if (name !== symbol) named.add(name);
  let definitions = 0;
  for (const name of limits.maxRelatedChars > 0 ? named : []) {
    // Past the limit with the cut already recorded, no further name can change the packet.
    if (definitions >= MAX_DEFINITIONS && relatedTruncated) break;
    const { hits } = await discoverer.search(name);
    // ponytail: the first definition found stands for the name; two functions of the same name in
    // different modules are not told apart without name resolution (spec Phase 4).
    const definition = hits.find((h) => defines(h.text, name));
    if (!definition) continue;
    const defIndex = await discoverer.index(definition.path);
    if (!defIndex) continue;
    const block = defIndex.enclosing(definition.line);
    // Too long to take as a block: not sent, and the guard could be in it, as with one too large.
    if (block.windowed) {
      relatedTruncated = true;
      continue;
    }
    if (definition.path === candidate.path && block.startLine >= candidate.startLine && block.endLine <= candidate.endLine) continue;
    if (definitions >= MAX_DEFINITIONS || !push(definition.path, block.startLine, block.endLine, slice(defIndex.lines, block.startLine, block.endLine))) {
      relatedTruncated = true;
      continue;
    }
    definitions += 1;
  }

  // The lines in the candidate that make the calls the change protects, for a reader to look at.
  const callSites: Location[] = [];
  for (const reason of candidate.reasons) {
    const called = /^calls ([\w$.]+)/.exec(reason)?.[1];
    if (!called) continue;
    const call = new RegExp(`(?<![\\w$])${called.replace(/[.$]/g, "\\$&")}\\s*\\(`);
    for (let l = candidate.startLine; l <= candidate.endLine; l++) {
      if (call.test(lines[l - 1] ?? "")) callSites.push({ path: candidate.path, startLine: l, endLine: l });
    }
  }

  const truncated = primary.truncated || relatedTruncated || candidate.windowed === true;
  return {
    packet: {
      requirement: { id: requirement.id, text: clean(requirement.text) },
      candidate: {
        path: candidate.path,
        lines: span(candidate.startLine, candidate.endLine),
        ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
        changed_by_pull_request: candidate.changed,
      },
      evidence: { code: primary.text, related, truncated },
    },
    truncated,
    sent,
    redactions,
    callSites,
  };
}
