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
import { IMPORT_LINE, isTestPath, type Discoverer } from "../discovery/discover.ts";
import type { Candidate, Cut, Location, Requirement } from "../types.ts";
import { functionDefinitionsOf } from "../plan/applicability.ts";
import type { GrepHit } from "../repository/git.ts";
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
  /**
   * Which part of the evidence was cut. They do not mean the same thing: the place's own code
   * missing voids every answer about it, missing surroundings can only hide a check, and
   * surroundings that may belong to another definition of the same name can put a check on a path
   * that is not this one.
   */
  cut: Cut;
  truncated: boolean; // any of `cut`, which is what the packet tells Jev
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

/**
 * The definitions of a name that a path outside the tests can reach: not a fixture or a stub in a
 * test file, and not one inside a test region of a source file, which is where Rust and Zig keep
 * theirs. Measured on ten real pull requests: before this, the same-name flag fired on 22% of the
 * places judged, and `deinit` in a Zig test was enough to void the answer about a production path.
 */
async function realDefinitions(discoverer: Discoverer, hits: readonly GrepHit[], name: string): Promise<GrepHit[]> {
  const found = hits.filter((h) => defines(h.text, name) && !isTestPath(h.path));
  const outside: GrepHit[] = [];
  for (const hit of found) {
    const index = await discoverer.index(hit.path);
    const inTest = (index?.testRegions ?? []).some((r) => hit.line >= r.start && hit.line <= r.end);
    if (!inTest) outside.push(hit);
  }
  return outside;
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
  // No room for the surroundings is not the same as having none: with the related section
  // skipped entirely, the packet would otherwise tell Jev nothing was cut.
  let contextCut = limits.maxRelatedChars <= 0;
  let ambiguous = false;
  let room = limits.maxRelatedChars;

  const push = (path: string, start: number, end: number, text: string): boolean => {
    const code = clean(text);
    if (code.length > room) {
      contextCut = true;
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
    // The candidate is itself one of these definitions, so being in its own file settles nothing:
    // what is unattributable is the callers, which were found by name and may belong to another
    // definition of it. Only definitions a path outside the tests can reach are counted.
    const definitions = await realDefinitions(discoverer, hits, symbol);
    if (definitions.length > 1) ambiguous = true;
    const outside = hits.filter(
      (h) =>
        !(h.path === candidate.path && h.line >= candidate.startLine && h.line <= candidate.endLine) &&
        !defines(h.text, symbol) &&
        !IMPORT_LINE.test(h.text),
    );
    if (more || outside.length > MAX_CALLERS) contextCut = true;
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
    if (definitions >= MAX_DEFINITIONS && contextCut) break;
    const { hits } = await discoverer.search(name);
    // ponytail: the first definition found stands for the name; two functions of the same name in
    // different modules are not told apart without name resolution (spec Phase 4).
    const defined = await realDefinitions(discoverer, hits, name);
    const definition = defined[0];
    if (!definition) continue;
    // The body taken for this name is where a guard usually is, so with the name defined more than
    // once the body shown may not be the one this path reaches. Being in the same file settles
    // nothing: `remote.check(user)` beside a local `check(user)` would take the local one, and its
    // guard, for a call that never reaches it. Without resolving the receiver and the imports, the
    // honest answer is that it is ambiguous.
    if (defined.length > 1) ambiguous = true;
    const defIndex = await discoverer.index(definition.path);
    if (!defIndex) continue;
    const block = defIndex.enclosing(definition.line);
    // Too long to take as a block: not sent, and the guard could be in it, as with one too large.
    if (block.windowed) {
      contextCut = true;
      continue;
    }
    if (definition.path === candidate.path && block.startLine >= candidate.startLine && block.endLine <= candidate.endLine) continue;
    if (definitions >= MAX_DEFINITIONS || !push(definition.path, block.startLine, block.endLine, slice(defIndex.lines, block.startLine, block.endLine))) {
      contextCut = true;
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

  const cuts: Cut = { own: primary.truncated || candidate.windowed === true, context: contextCut, ambiguous };
  const truncated = cuts.own || cuts.context || cuts.ambiguous;
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
    cut: cuts,
    truncated,
    sent,
    redactions,
    callSites,
  };
}

// --- The code a reading turns on (docs/adr/0019) ---------------------------------------------------
//
// The only place a check's name is looked up. It is by name — exactly one definition outside the
// tests — because nothing here resolves a call to its definition; #83 decides what resolution is
// trusted, and its contract replaces this lookup and nothing else.

export const DECISIVE_LIMITS = { each: 4000, total: 8000 } as const;

export interface SentBody {
  name: string;
  path: string;
  lines: string;
  /** 1: a check the form named. 2: a function a sent check calls, sent while there was room. */
  depth: 1 | 2;
}

export type DecisiveBodies =
  | { hold: string }
  | { related: Related[]; sent: SentBody[]; notSent: string[] };

/**
 * The bodies of the checks a form named, and of the functions they call, one level down.
 *
 * A check with more than one definition, whose search was cut, or whose body does not fit is not
 * sent, and neither is the call: its reading would rest on a body that was not sent. A name the
 * repository does not define (the standard library's, a dependency's) has nothing to send and is
 * left as it was. The second level is sent while it fits and is not required: what did not fit is
 * named in `notSent`.
 */
export async function decisiveBodies(discoverer: Discoverer, names: readonly string[], asked: { path: string; startLine: number; endLine: number }, limits: { each: number; total: number } = DECISIVE_LIMITS): Promise<DecisiveBodies> {
  const related: Related[] = [];
  const sent: SentBody[] = [];
  const notSent: string[] = [];
  let used = 0;
  const taken = new Set<string>();

  /** One definition's body, or why it cannot be sent. `null`: the repository does not define it. */
  const bodyOf = async (name: string): Promise<{ code: string; path: string; start: number; end: number } | { why: string } | null> => {
    const { found, more } = await functionDefinitionsOf(discoverer, name);
    if (found.length === 0 && !more) return null;
    if (found.length !== 1 || more) return { why: `\`${name}\` has ${found.length}${more ? " or more" : ""} definitions in this repository, so which one is called here is not known` };
    const def = found[0]!;
    const index = await discoverer.index(def.path);
    if (!index) return { why: `\`${name}\` (${def.path}) could not be read` };
    const block = index.enclosing(def.line);
    if (block.windowed) return { why: `the body of \`${name}\` (${def.path}:${def.line}) is too long to take` };
    // Defined inside the function asked about: its body is already the packet's, and there is
    // nothing more to send.
    if (def.path === asked.path && block.startLine >= asked.startLine && block.endLine <= asked.endLine) return null;
    const r = redact(slice(index.lines, block.startLine, block.endLine));
    return { code: r.text, path: def.path, start: block.startLine, end: block.endLine };
  };
  const take = (name: string, b: { code: string; path: string; start: number; end: number }, depth: 1 | 2) => {
    used += b.code.length;
    taken.add(name);
    related.push({ path: b.path, lines: span(b.start, b.end), code: b.code });
    sent.push({ name, path: b.path, lines: span(b.start, b.end), depth });
  };

  const checks: { name: string; code: string }[] = [];
  for (const name of names) {
    if (taken.has(name)) continue;
    const b = await bodyOf(name);
    if (b === null) continue;
    if ("why" in b) return { hold: `the check ${b.why}; the reading would rest on a body that was not sent` };
    if (b.code.length > limits.each || used + b.code.length > limits.total) {
      return { hold: `the body of the check \`${name}\` (${b.path}:${span(b.start, b.end)}) does not fit the ${b.code.length > limits.each ? limits.each : limits.total} characters it may take; the reading would rest on a body that was not sent` };
    }
    take(name, b, 1);
    checks.push({ name, code: b.code });
  }
  for (const check of checks) {
    for (const name of calledNames(withoutStrings(check.code))) {
      if (taken.has(name) || name === check.name || /^[A-Z]/.test(name)) continue;
      const b = await bodyOf(name);
      if (b === null) continue;
      if ("why" in b || b.code.length > limits.each || used + b.code.length > limits.total) {
        notSent.push(name);
        continue;
      }
      take(name, b, 2);
    }
  }
  return { related, sent, notSent: [...new Set(notSent)] };
}
