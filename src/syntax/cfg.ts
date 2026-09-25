// Reading a Rust `cfg` predicate: whether it can hold only when the tests are compiled.
//
// A leaf module: `src/change/blocks.ts` (the indentation reader) and `src/syntax/rust.ts` (the parser)
// both use it, and the parser's module waits for its grammar at load, so the two must not import
// each other (ADR 0022).

/** Pieces of a `cfg` predicate, split on the commas that are not inside nested parentheses. */
function splitPredicate(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Whether a `cfg` predicate can hold **only** when the tests are being compiled.
 *
 * `all(test, unix)` can, because every part has to hold. `any(test, feature = "production")`
 * cannot: with that feature on, the code is in an ordinary build. Excluding it would delete real
 * code from the candidates and from the definitions names resolve against, and say nothing.
 *
 * Anything this does not recognise — a `not`, an unknown form — is **not** test-only. Being unsure
 * leaves the code in, where it is visible, rather than dropping it where nothing reports it.
 */
export function testOnlyCfg(predicate: string): boolean {
  const text = predicate.trim();
  if (text === "test") return true;
  const call = /^(all|any|not)\s*\(([\s\S]*)\)$/.exec(text);
  if (!call) return false;
  const parts = splitPredicate(call[2] as string);
  if (parts.length === 0) return false;
  if (call[1] === "all") return parts.some(testOnlyCfg);
  if (call[1] === "any") return parts.every(testOnlyCfg);
  return false;
}

/**
 * What is inside `#[cfg(…)]` on this line, by matching the parenthesis rather than the last `)]`
 * on the line — `#[cfg(test)] // uses &[(u8)]` ends its attribute long before the line does.
 */
export function cfgPredicate(line: string): string | null {
  const open = /^\s*#\[cfg\(/.exec(line);
  if (!open) return null;
  let depth = 1;
  let quote = false;
  for (let i = open[0].length; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return line.slice(open[0].length, i);
    }
  }
  return null;
}
