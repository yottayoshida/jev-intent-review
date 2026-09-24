// `BlockIndex.enclosing` for a function whose body opens below a line of its own signature (#74):
// the evidence, the changes' question and the siblings' spans read functions through it, and it read
// `) -> T` at the function's indent as the function's end — a line in the body came back as the
// enclosing `impl`. The shapes the listing already reads right since #73 are the fixture.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockIndex } from "../src/change/blocks.ts";
import { enumerate } from "../src/plan/candidates.ts";

const RUST = `impl Processor {
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

    fn wrapped(
        &self,
    ) -> impl Future<
        Output = Result<u8>,
    > + Send {
        let x = compute();
        async move { x }
    }

    fn brace_alone(&self, a: u8)
    {
        use_it(a);
    }

    fn name(&self) -> &str { &self.name }

    fn load(&self) -> Result<u8> {
        read_blob()?;
        Ok(1)
    }
}
`;

const at = (text: string, lineNo: number) => {
  const b = new BlockIndex(text.split("\n")).enclosing(lineNo);
  return { name: b.name, startLine: b.startLine, endLine: b.endLine };
};

test("a line in the body of a function with a where clause is that function's, to its closing brace", () => {
  assert.deepEqual(at(RUST, 9), { name: "process", startLine: 2, endLine: 11 });
});

test("a return type over several lines and a brace on its own line are read the same way", () => {
  assert.deepEqual(at(RUST, 18), { name: "wrapped", startLine: 13, endLine: 20 });
  assert.deepEqual(at(RUST, 24), { name: "brace_alone", startLine: 22, endLine: 25 });
});

test("a one-line function and the function after it are read as before", () => {
  assert.deepEqual(at(RUST, 27), { name: "name", startLine: 27, endLine: 27 });
  assert.deepEqual(at(RUST, 30), { name: "load", startLine: 29, endLine: 32 });
});

test("other languages are read as before: a Python def over several lines, a JS parameter list, a JSX tag closed on a line of its own", () => {
  const py = `def handler(
    request,
    session,
) -> Response:
    value = compute(request)
    return value
`;
  assert.deepEqual(at(py, 5), { name: "handler", startLine: 1, endLine: 6 });
  const js = `function send(
  a,
  b,
) {
  post(a, b);
}
`;
  assert.deepEqual(at(js, 5), { name: "send", startLine: 1, endLine: 6 });
  // A `>` alone closes the `<select` tag; climbing from it would take the component for the line.
  const tsx = `export function Modal() {
  const [value, setValue] = useState("");
  return (
    <div>
      <select
        value={value}
      >
        <option>one</option>
      </select>
    </div>
  );
}
`;
  // What the tool read before #74, taken from it. That `>` alone is not climbed from is checked on
  // real files too: no line outside Rust changes on five repositories (the pull request's record).
  assert.deepEqual(at(tsx, 7), { name: "Modal", startLine: 1, endLine: 12 });
});

test("a `where {` written at column 0 opens the method's body, ended at the method's own indent, not the impl's", () => {
  const odd = `impl Db {
    pub fn query_many_raw(
        &self,
        limit: u8,
    ) -> CostResult<u8, Error>
where {
        run(limit)?;
        Ok(0)
    }

    fn after(&self) {
        other();
    }
}
`;
  // The method, lines 2-9: not its signature alone (2-5, before #74) nor the whole `impl` (1-14).
  assert.deepEqual(at(odd, 3), { name: "query_many_raw", startLine: 2, endLine: 9 });
  assert.deepEqual(at(odd, 7), { name: "query_many_raw", startLine: 2, endLine: 9 });
  assert.deepEqual(at(odd, 12), { name: "after", startLine: 11, endLine: 13 });
});

test("a bare block just inside such a body is still in the function (whatsapp-rust's FlushScope::spawn)", () => {
  const text = `impl S {
    fn spawn<F>(&self, fut: F)
    where
        F: Send,
    {
        {
            let c = self.count();
            c.bump();
        }
        run(fut);
    }
}
`;
  // The bare block's own lines: the block itself, which is inside `spawn`, not the `impl`.
  const inBlock = at(text, 7);
  assert.ok(inBlock.startLine >= 2 && inBlock.endLine <= 11, `read inside spawn (2-11), not the impl: ${JSON.stringify(inBlock)}`);
  assert.deepEqual(at(text, 10), { name: "spawn", startLine: 2, endLine: 11 });
});

test("a where clause and the body's brace on one line: the body is the function's", () => {
  const text = `impl Db {
    pub fn q<T>(&self, t: T) -> R
    where T: Clone {
        run()?;
        Ok(t)
    }
}
`;
  assert.deepEqual(at(text, 4), { name: "q", startLine: 2, endLine: 6 });
});

test("a function visible `pub(in path)` is a function too (grovedb's estimated costs)", () => {
  const text = `impl Paths {
    pub(in crate::batch) fn new_with(
        paths: Map,
    ) -> Self {
        Paths {
            paths,
        }
    }
}
`;
  assert.deepEqual(at(text, 6), { name: "new_with", startLine: 2, endLine: 8 });
});

test("a return arrow at the function's own indent continues the signature (rustfmt's `-> T {` line)", () => {
  const text = `impl S {
    pub async fn load(&self, key: &str)
    -> Result<Vec<u8>, Error> {
        fetch(key)?;
        Ok(vec![])
    }
}
`;
  assert.deepEqual(at(text, 4), { name: "load", startLine: 2, endLine: 6 });
});

test("a signature longer than thirty lines still has its body found (grovedb's apply_with_costs_just_in_time_value_update)", () => {
  const params = Array.from({ length: 34 }, (_, i) => `        p${i}: u8,`).join("\n");
  const text = `impl M {\n    fn long<T>(\n${params}\n    ) -> Result<u8>\n    where\n        T: Clone,\n    {\n        work()?;\n        Ok(0)\n    }\n}\n`;
  // Line 2 is the signature's first; 34 parameters; `where` on 38; line 40 opens the body, 38 lines
  // down; 41 is in it.
  assert.deepEqual(at(text, 41), { name: "long", startLine: 2, endLine: 43 });
});

test("a JavaScript call to something named `where` is not a Rust where clause", () => {
  const js = `function a() {
  x();
}
where(
  q,
).then(() => {
  body();
});
`;
  // What the tool read before #74 for \`body();\`, taken from it.
  assert.deepEqual(at(js, 7), { name: "where", startLine: 4, endLine: 8 });
});

test("a Rust constructor named `new` is a function, while JavaScript's `new Foo(` still is not one", () => {
  const rust = `impl Reactor {
    pub fn new(
        executor: E,
    ) -> Self {
        let runtime = build()?;
        Self { executor, runtime }
    }
}
`;
  assert.deepEqual(at(rust, 5), { name: "new", startLine: 2, endLine: 7 });
  const listed = enumerate("src/reactor.rs", rust);
  assert.deepEqual(listed.functions.map((f) => [f.name, f.startLine, f.endLine]), [["new", 2, 7]]);
  assert.deepEqual(listed.calls.map((c) => c.line), [5]);
  const js = `function a() {
  const x = new Foo(
    1,
  );
}
`;
  assert.equal(at(js, 3).name, "a");
});
