// The names of the standard library's public, stable methods (#83, ADR 0027), read from rust-src with
// the parser the product uses. Writes src/plan/std-methods.ts.
//
//   node bench/std-methods.ts <rust-src library dir>
//   e.g. ~/.rustup/toolchains/1.98.1-aarch64-apple-darwin/lib/rustlib/src/rust/library
//
// A method is a function whose first parameter is `self`, written
//   - `pub fn` in an inherent `impl` (`impl<T> Vec<T> { pub fn len(&self) … }`), or
//   - in a `pub trait` (`pub trait Iterator { fn map(self, …) … }`), with or without a body —
// and neither it nor the `impl` or trait it is in carries `#[unstable(…)]` or `#[doc(hidden)]`.
//
// Not read: methods a macro writes (the integer types' `pow`, `count_ones`, … are in `int_impl!`),
// since the grammar does not read inside a macro's definition. A call of one of those is read by its
// name as before.
//
// ponytail: a `pub` item in a module that is not itself public, and a stable item in a crate whose
// whole surface is unstable, are counted: module privacy is not followed. Its cost is names a caller
// cannot reach through std, held for their receiver's type as std's own are.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";

const HERE = resolve(import.meta.dirname, "..");
const lib = process.argv[2];
if (!lib) throw new Error("usage: node bench/std-methods.ts <rust-src library dir>");

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(readFileSync(join(HERE, "vendor/tree-sitter-rust.wasm"))));

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "tests" || n === "benches" ? [] : files(p);
    return n.endsWith(".rs") ? [p] : [];
  });

/** The attributes written before a node (tree-sitter keeps them as preceding siblings). */
function attributes(node: Node): string[] {
  const out: string[] = [];
  for (let s = node.previousSibling; s; s = s.previousSibling) {
    if (s.type === "attribute_item") out.push(s.text);
    else if (s.type !== "line_comment" && s.type !== "block_comment") break;
  }
  return out;
}
const hidden = (node: Node) => attributes(node).some((a) => /#\[\s*unstable\s*\(|#\[\s*doc\s*\(\s*hidden\s*\)/.test(a));
const isPub = (node: Node) => node.namedChildren.some((c) => c?.type === "visibility_modifier" && c.text === "pub");
/** The first parameter is `self`, bare or typed (`self: Pin<&mut Self>`, `self: Box<Self>`). */
const takesSelf = (fn: Node) => {
  const first = fn.childForFieldName("parameters")?.namedChildren[0];
  return first?.type === "self_parameter" || (first?.type === "parameter" && first.childForFieldName("pattern")?.text === "self");
};

/**
 * std's own syntax the grammar (tree-sitter-rust 0.24) does not know, blanked to the same length so a
 * whole file does not read as one error: const traits and impls (`const impl`, `[const] Clone`,
 * `~const`), a const closure (`const || …`), `final fn`.
 */
const blank = (m: string) => " ".repeat(m.length);
const readable = (s: string) =>
  s
    .replace(/\[const\]|~const\b/g, blank)
    .replace(/\bconst(\s+unsafe)?\s+(?=(?:impl|trait)\b)/g, blank)
    .replace(/\bconst(?=\s*(?:move\s*)?\|)/g, blank)
    .replace(/\bfinal(?=\s+fn\b)/g, blank);

const names = new Set<string>();
let read = 0;
for (const crate of ["core", "alloc", "std"]) {
  for (const path of files(join(lib, crate, "src"))) {
    const tree = parser.parse(readable(readFileSync(path, "utf8")));
    if (!tree) continue;
    read += 1;
    const stack: Node[] = [tree.rootNode];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === "impl_item" || node.type === "trait_item") {
        const trait = node.type === "trait_item";
        const inherent = node.type === "impl_item" && !node.childForFieldName("trait");
        if ((trait ? isPub(node) : inherent) && !hidden(node)) {
          for (const item of node.childForFieldName("body")?.namedChildren ?? []) {
            if (!item || (item.type !== "function_item" && item.type !== "function_signature_item")) continue;
            if (!takesSelf(item) || hidden(item)) continue;
            if (!trait && !isPub(item)) continue;
            const name = item.childForFieldName("name")?.text;
            if (name) names.add(name.replace(/^r#/, ""));
          }
        }
      }
      for (const c of node.namedChildren) if (c) stack.push(c);
    }
    tree.delete();
  }
}

const sorted = [...names].sort();
const toolchain = execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
const sha = createHash("sha256").update(sorted.join("\n")).digest("hex");
writeFileSync(
  join(HERE, "src/plan/std-methods.ts"),
  `// The standard library's public, stable method names (#83, ADR 0027). Written by \`node bench/std-methods.ts\`
// from rust-src (${toolchain}), ${read} files of core, alloc and std: ${sorted.length} names, sha256 ${sha}.
// A method call by one of these names is settled by its receiver's type, never by the name alone.

export const STD_METHOD_NAMES: ReadonlySet<string> = new Set(${JSON.stringify(sorted)});
`,
);
console.log(`${sorted.length} names from ${read} files`);
