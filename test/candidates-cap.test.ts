// How many calls of one function the listing reads (#38): all of a large hand-written function, and
// a counted cut past the guard. No repository, no model — one generated string per test.

import assert from "node:assert/strict";
import { test } from "node:test";
import { enumerate } from "../src/plan/candidates.ts";

/** A function with `n` calls, `step_1()` … `step_n()`, one a line. */
const withCalls = (n: number) => `pub fn busy() -> Result<(), E> {\n${Array.from({ length: n }, (_, i) => `    step_${i + 1}()?;`).join("\n")}\n    Ok(())\n}\n`;

test("a function with more than forty calls has every one listed, the forty-first and the last included", () => {
  const listing = enumerate("src/busy.rs", withCalls(45));
  const callees = listing.calls.map((c) => c.callee);
  assert.equal(callees.length, 45);
  assert.ok(callees.includes("step_41") && callees.includes("step_45"), callees.slice(38).join(", "));
  assert.equal(listing.omitted.calls, 0);
  assert.equal(listing.functions[0]!.callsCut, undefined, "nothing was cut");
});

test("past a thousand calls the rest are left out, counted, and the function is marked as cut", () => {
  const listing = enumerate("src/busy.rs", withCalls(1005));
  assert.equal(listing.calls.length, 1000);
  assert.equal(listing.calls.at(-1)!.callee, "step_1000", "in line order");
  assert.equal(listing.omitted.calls, 5);
  assert.equal(listing.functions[0]!.callsCut, true);
});

// A signature ending in a `where` clause, as rustfmt writes one: `) -> T` at the function's indent,
// `where` below it, and the body's `{` on its own line. `blockEnd` read the `)` line as the end, so
// the body was never listed — whatsapp-rust#759's fixed function (#38).
const WHERE = `impl Processor {
    pub async fn process<F>(
        &self,
        download: F,
    ) -> Result<u8>
    where
        F: Fn(&Ref) -> Result<Vec<u8>> + Send,
    {
        fetch_blobs(&download)?;
        self.finish().await
    }

    pub fn plain(&self) -> Result<u8> {
        helper()?;
        Ok(1)
    }
}
`;

test("a function whose signature ends in a where clause has its body listed, to its closing brace", () => {
  const listing = enumerate("src/p.rs", WHERE);
  const process = listing.functions.find((f) => f.name === "process")!;
  assert.equal(process.endLine, 11, "the `}` that closes the body");
  const callees = listing.calls.filter((c) => c.functionId === process.id).map((c) => c.callee);
  assert.ok(callees.some((c) => c.endsWith("fetch_blobs")), `the body's calls: ${callees.join(", ")}`);
  assert.ok(!callees.includes("Fn"), "the where clause's `Fn(…)` is not a call");
});

test("a function whose first line opens its body is read as before", () => {
  const listing = enumerate("src/p.rs", WHERE);
  const plain = listing.functions.find((f) => f.name === "plain")!;
  assert.deepEqual([plain.startLine, plain.endLine], [13, 16]);
  assert.deepEqual(listing.calls.filter((c) => c.functionId === plain.id).map((c) => c.callee), ["helper"]);
});

// What the body search must not do (the second review of #38's second part): a one-line function,
// a doc example, and a pattern in the parameters each used to send it past the function.
const SHAPES = `pub struct A;

impl A {
    fn name(&self) -> &str { &self.name }

    fn load(&self) -> Result<u8> {
        read_blob()?;
        Ok(1)
    }
}

fn tiny(_: &Path) {}

#[cfg(test)]
mod tests {
    fn go() { helper_in_test(); }
}

/// # fn example() {
/// #     something();
/// # }
pub fn documented() -> Result<u8> {
    real_call()?;
    Ok(0)
}

pub async fn handler(
    State(state): State<AppState>,
    Json(Session {
        id,
    }): Json<Session>,
) -> Result<u8> {
    open_session(id)?;
    Ok(0)
}
`;

test("a one-line function stays one line, and keeps none of the next function's calls", () => {
  const listing = enumerate("src/s.rs", SHAPES);
  const name = listing.functions.find((f) => f.name === "name")!;
  assert.deepEqual([name.startLine, name.endLine], [4, 4]);
  assert.deepEqual(listing.calls.filter((c) => c.functionId === name.id).map((c) => c.callee), []);
  const tiny = listing.functions.find((f) => f.name === "tiny")!;
  assert.equal(tiny.endLine, 12, "`{}` closes it; it does not take the test module below");
  assert.ok(!listing.calls.some((c) => c.functionId === tiny.id), "no call from the test module is its");
});

test("a doc example and a pattern in the parameters do not move where a body opens", () => {
  const listing = enumerate("src/s.rs", SHAPES);
  const documented = listing.functions.find((f) => f.name === "documented")!;
  assert.deepEqual([documented.startLine, documented.endLine], [22, 25], "from its own `fn` line, not the example's");
  assert.deepEqual(listing.calls.filter((c) => c.functionId === documented.id).map((c) => c.callee), ["real_call"]);
  const handler = listing.functions.find((f) => f.name === "handler")!;
  assert.equal(handler.endLine, 35, "the body's closing brace, not the pattern's");
  assert.ok(listing.calls.some((c) => c.functionId === handler.id && c.callee === "open_session"), "the body is read");
});

test("a function line with no body of its own does not take the next block's", () => {
  // An `extern` declaration, and a line that opens nothing and is followed at the same indent by
  // something that is not a signature's continuation: the search stops, and the next `impl`'s `{`
  // is not taken for this function's body.
  const text = `extern "C" {
    fn ext(x: u8) -> u8;
}

mod m {
    fn bare(x: u8) -> u8
    impl Z {
        fn z(&self) { inner(); }
    }
}
`;
  const listing = enumerate("src/e.rs", text);
  const ext = listing.functions.find((f) => f.name === "ext")!;
  assert.ok(ext.endLine <= 3, `a declaration does not run into the next block (it ends at ${ext.endLine}, the extern block closes at 3)`);
  const bare = listing.functions.find((f) => f.name === "bare")!;
  assert.ok(bare.endLine < 7, `it ends before \`impl Z {\` (line 7), at ${bare.endLine}`);
  assert.ok(!listing.calls.some((c) => c.functionId === bare.id && c.callee === "inner"), "and holds none of its calls");
});
