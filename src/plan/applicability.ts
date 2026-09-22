// Whether a question about a failed call can be put to a place at all, decided from definitions.
//
// The first version of this read the call's own line and looked for `?`, `.map_err`, `.is_ok()`
// and the like. It let through `exists()` in
//
//     if p.exists() || p.symlink_metadata().is_ok() {
//
// because the `.is_ok()` belongs to the call beside it, and it let through `Option::unwrap_or`,
// which is not a `Result` at all. Syntax on one line does not say what a call returns.
//
// So this resolves the name instead: the callee's definition is looked up in the repository at the
// pinned commit, and its signature is what decides. A name that resolves to nothing — every method
// from the standard library, `exists()` among them — or to more than one definition is **held**,
// not judged. That is narrow on purpose: the first version of this check is for calls whose
// definitions are in the repository being read.

import { defines, definedName } from "../change/blocks.ts";
import { isTestPath, type Discoverer } from "../discovery/discover.ts";
import type { CallCandidate, FunctionCandidate } from "./candidates.ts";

/** A signature that returns something the property's two options can sort. */
export const RETURNS_RESULT = /->\s*[^{;]*\b(?:io::)?Result\s*</;

export type Applicability =
  | { ok: true; calleeDefinedAt: string }
  | { ok: false; kind: "target_not_result" | "callee_unresolved" | "callee_ambiguous" | "callee_not_result"; reason: string };

export interface Definition {
  path: string;
  line: number;
  text: string;
}

/**
 * The definitions of a bare name outside tests, at this commit, and whether the search that found
 * them was cut: past the search's cap a name may have definitions this did not see.
 */
export async function definitionsOfName(discoverer: Discoverer, name: string): Promise<{ found: Definition[]; more: boolean }> {
  const { hits, more } = await discoverer.search(name);
  const found: Definition[] = [];
  for (const hit of hits) {
    if (!defines(hit.text, name) || isTestPath(hit.path)) continue;
    if (definedName(hit.text) !== name) continue;
    const index = await discoverer.index(hit.path);
    const inTest = (index?.testRegions ?? []).some((r) => hit.line >= r.start && hit.line <= r.end);
    if (!inTest) found.push({ path: hit.path, line: hit.line, text: hit.text });
  }
  return { found, more };
}

/** The definitions of a bare name outside tests, at this commit, as far as the search reached. */
export async function definitionsOf(discoverer: Discoverer, name: string): Promise<Definition[]> {
  return (await definitionsOfName(discoverer, name)).found;
}

/**
 * Whether `call_failure_not_returned_as_success` can be asked here.
 *
 * Both halves come from a signature, never from how a line looks:
 *
 *   - the target must return a `Result`, or "a success" and "an error" sort nothing it returns;
 *   - the callee must be defined once in this repository and return a `Result`, or there is no
 *     error to assume.
 */
export async function applicabilityOf(discoverer: Discoverer, fn: FunctionCandidate, call: CallCandidate): Promise<Applicability> {
  if (!RETURNS_RESULT.test(fn.signature)) {
    return { ok: false, kind: "target_not_result", reason: `${fn.name} does not return a Result, so "a success" and "an error" do not sort what it returns` };
  }
  const bare = call.callee.split("::").pop()!;
  const defs = await definitionsOf(discoverer, bare);
  if (defs.length === 0) return { ok: false, kind: "callee_unresolved", reason: `${bare} has no definition in this repository, so what it returns is not established here` };
  if (defs.length > 1) return { ok: false, kind: "callee_ambiguous", reason: `${bare} is defined ${defs.length} times here, so which one this call reaches is not resolved` };
  const def = defs[0]!;
  // The signature may wrap; a few lines past the definition line are enough to see the return.
  const index = await discoverer.index(def.path);
  const signature = (index?.lines ?? []).slice(def.line - 1, def.line + 3).join(" ");
  if (!RETURNS_RESULT.test(signature)) return { ok: false, kind: "callee_not_result", reason: `${bare} does not return a Result (${def.path}:${def.line}), so it has no error to assume` };
  return { ok: true, calleeDefinedAt: `${def.path}:${def.line}` };
}
