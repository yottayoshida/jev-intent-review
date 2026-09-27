/**
 * The JSON in a model's answer: the first fenced block, or else the whole answer, or else the text from
 * the first `[` or `{` to the last `]` or `}`. An annotator that may read the source often explains its
 * label after the block (the rehearsal on dev row 53 did, every time), which a parse of the whole answer
 * rejects; the baseline and the adjudication read their answers the same way.
 */
export function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const from = Math.min(...["[", "{"].map((c) => (text.indexOf(c) === -1 ? Infinity : text.indexOf(c))));
  const to = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}")) + 1;
  for (const c of [fenced?.[1], text.trim(), Number.isFinite(from) ? text.slice(from, to) : undefined]) {
    if (c === undefined || c.trim() === "") continue;
    try {
      return JSON.parse(c.trim());
    } catch {
      // the next reading
    }
  }
  return undefined;
}
