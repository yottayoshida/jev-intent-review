// Which code decides a reading, found from the code and not asked of Jev (docs/adr/0019).
//
// The local check sends the body of the function a call is in. What the body calls is not sent, and
// Jev answers as if it had read it: a decision moved into a helper was read as holding at 0.91–0.96
// in every run (#36, #82). Asking Jev whether what it was sent is enough was measured and failed
// (bench/evidence-settles/). So each form names, from the body's text, the code its answer turns on;
// the run sends it, or does not ask.
//
// Everything here reads the body as the packet has it, with its whitespace collapsed — the way
// `locateCall` finds the call — so a call rustfmt split over lines is one expression. Nothing here
// looks a name up: which names the repository defines is the caller's question (`builder.ts`,
// `decisiveBodies`), and #83's resolution replaces that lookup, not these rules.

import { redact } from "../evidence/redact.ts";
import type { CallCandidate } from "./candidates.ts";

/**
 * The text with its comments dropped and, inside its string and character literals (raw ones
 * included), the characters that shape code — `{ } ; ( ) [ ]` — made `_`; then its whitespace
 * collapsed. A `;` in a string does not end a statement and an `if` in a comment is no condition,
 * while `load("a")` and `load("b")` stay two calls: emptying the strings made them one, and the
 * wrong one was read (the second review of #82). The body and every call's expression go through it
 * alike, so an expression still meets itself in the body.
 */
const flat = (text: string) =>
  text
    .replace(/(?<!\w)r(#*)"[\s\S]*?"\1|"(?:[^"\\]|\\.)*"|'(?:[^'\\\n]|\\.)'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("/") ? " " : m.replace(/[{};()[\]]/g, "_")))
    .replace(/\s+/g, " ");

/** How often a call's expression occurs in a body, read as the rules read it. */
export function occurrences(body: string, call: CallCandidate): number {
  const text = flat(body);
  const needle = needleOf(call);
  let n = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) n++;
  return n;
}
const needleOf = (call: CallCandidate) => flat(redact(call.expression).text);
const lastOf = (callee: string) => callee.split("::").pop() ?? callee;

/**
 * Names every repository has, which a failure may pass to without the reading turning on this
 * repository's code: the language's constructors, and a few functions of the standard library and of
 * the runtimes that repositories also define for themselves (`timeout` in whatsapp-rust#759 and
 * moltis#1064). Fixed before any measurement; a name added here is a changed rule.
 */
export const EVERYWHERE: ReadonlySet<string> = new Set(["Ok", "Some", "Err", "new", "from", "into", "timeout", "spawn", "spawn_blocking", "block_on", "drop"]);

const KEYWORDS = new Set(["if", "while", "match", "return", "for", "in", "let", "loop", "else"]);

/**
 * The function the failure of `call` is passed to before it reaches `?`: the name before the
 * nearest parenthesis the call sits in, in the same statement. None when the failure is `?`-ed first
 * (`extend(unpack(x)?)`), when the parenthesis is a method's (`.map(|x| parse(x))`: a method's name
 * does not tell this repository's from the standard library's — grovedb#500 defines `map_err`), a
 * macro's, a keyword's, a tuple's, or a constructor's (a capital), or when the name is one every
 * repository has. The name returned is the last part of its path.
 */
export function wrapperOf(body: string, call: CallCandidate): string | null {
  const text = flat(body);
  const needle = needleOf(call);
  const at = text.indexOf(needle);
  if (at < 0) return null;
  if (/^(?: |\.await\b)*\?/.test(text.slice(at + needle.length))) return null;
  let depth = 0;
  let open = -1;
  for (let i = at - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") {
      if (depth > 0) depth--;
      else if (ch === "(") {
        open = i;
        break;
      } else return null;
    } else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) return null;
  }
  if (open < 0) return null;
  const head = text.slice(0, open).replace(/ $/, "").replace(/::<[^<>]*>$/, "");
  const m = /([A-Za-z_]\w*)$/.exec(head);
  if (!m) return null;
  const name = m[1]!;
  const before = head.slice(0, head.length - name.length).replace(/ $/, "");
  if (before.endsWith(".") || head.endsWith("!") || KEYWORDS.has(name) || /^[A-Z]/.test(name) || EVERYWHERE.has(name)) return null;
  return name;
}

/**
 * Whether the occurrence of a call at `at` in `text` is in a condition: in an `if`, `while` or
 * `match` (and its guards) of its statement, in an `ensure!`, `assert!` or `debug_assert!`, in the
 * expression of a `let … else`, or the outermost call of a statement that `?`-s its result — through
 * any methods chained on it, `check(x).map_err(E::from)?;` — and binds nothing, `let _ =` included.
 * A read such as `let v = get_version(n)?;` is not a condition: it binds.
 *
 * ponytail: the statement is read back to the nearest `;`, `{` or `}` outside parentheses, so a guard
 * on an earlier arm of the same `match` puts every later arm "in a condition". A parser (#83) reads
 * the arm; until then the rule errs toward naming a call, and a named call with one definition is
 * only sent.
 */
function inCondition(text: string, at: number, needle: string): boolean {
  let depth = 0;
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) {
      start = i + 1;
      break;
    }
  }
  const prefix = text.slice(start, at);
  if (/\b(if|while|match)\b|\b(?:ensure|assert|debug_assert) ?! ?\(/.test(prefix)) return true;
  const end = text.indexOf(";", at);
  const rest = text.slice(at + needle.length, end < 0 ? undefined : end);
  if (/^ ?let\b/.test(prefix) && /\belse ?\{/.test(rest)) return true;
  return UNBOUND.test(prefix) && QUESTIONED.test(rest);
}

/** Before the call: nothing but its receivers, or `let _ =` and its receivers. */
const UNBOUND = /^ ?(?:let _ ?= ?)?(?:[A-Za-z_]\w* ?\. ?)*$/;
/** After it, to the statement's end: `.await` and methods (arguments two parentheses deep), then `?`. */
const QUESTIONED = /^(?: |\.await\b|\. ?[A-Za-z_]\w*(?: ?:: ?<[^<>;]*>)? ?\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\? ?$/;

/**
 * The checks before `target` in its function (ADR 0019): the other calls of the function, above it,
 * in a condition, whose own name `meets` the requirement, that do not start with a capital (a variant
 * or a tuple struct) and are not calls of the target's own name. Each name once, in the body's order.
 */
export function checksBefore(body: string, target: CallCandidate, calls: readonly CallCandidate[], meets: (call: CallCandidate) => boolean): string[] {
  const text = flat(body);
  const targetAt = text.indexOf(needleOf(target));
  if (targetAt < 0) return [];
  const own = lastOf(target.callee);
  const found: { name: string; at: number }[] = [];
  for (const call of calls) {
    if (call.id === target.id) continue;
    const name = lastOf(call.callee);
    if (name === own || /^[A-Z]/.test(name) || !meets(call)) continue;
    const needle = needleOf(call);
    for (let at = text.indexOf(needle); at >= 0 && at < targetAt; at = text.indexOf(needle, at + 1)) {
      if (inCondition(text, at, needle)) {
        found.push({ name, at });
        break;
      }
    }
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.name))];
}
