import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, type Deps, type Io } from "../src/cli/main.ts";
import { ProviderError } from "../src/judgments/client.ts";
import type { JudgmentProvider, Questions } from "../src/judgments/provider.ts";
import { RememberedProvider } from "../src/judgments/remembered.ts";
import { resultKind } from "../src/report/markdown.ts";
import { EXIT, type ReviewReport } from "../src/types.ts";
import { answer, formsProvider } from "./helpers/fakes.ts";
import { FIXTURES, fixtureRepo } from "./helpers/repo.ts";

const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CLOUDFLARE_API_TOKEN: "test-token" };
const RUST_SPEC = join(FIXTURES, "integrity-rust", "spec.json");
const WHERE = { host: "cloudflare", origin: "https://api.cloudflare.com" };
const QUESTION: Questions = { verdict: { type: "choice", instructions: "Does the call return its error?", criteria: { yes: "it does", no: "it does not" } } };

function io(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const value: Io = { stdout: (t) => void out.push(t), stderr: () => {}, cwd, env };
  return { value, report: () => JSON.parse(out.join("")) as ReviewReport };
}

function fakeDeps(provider: JudgmentProvider & { calls?: unknown[] } = formsProvider()): Deps & { provider: typeof provider } {
  let sent = 0;
  const counted: JudgmentProvider = { model: provider.model, judge: (state, questions) => ((sent += 1), provider.judge(state, questions)) };
  return { provider, judges: () => ({ provider: counted, sent: () => ({ requests: sent, bytes: 0 }), origin: WHERE.origin }) };
}

/** A private directory for the kept answers, as `mkdtemp` makes it (0700). */
function answersDir(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "jir-answers-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** An inner provider that counts its calls and answers `yes` to everything. */
function counting(model = "typesafe/jev") {
  const calls: unknown[] = [];
  const provider: JudgmentProvider = {
    model,
    async judge(state, questions) {
      calls.push(state);
      return Object.fromEntries(Object.keys(questions).map((k) => [k, answer(Object.keys(questions[k]!.criteria)[0]!)]));
    },
  };
  return { provider, calls };
}

// ---- the ledger itself ----------------------------------------------------------------------------

test("an answer is kept and a byte-identical request is not sent again; a question one character apart is", async () => {
  const d = answersDir();
  try {
    const first = counting();
    const one = await RememberedProvider.open(d.dir, first.provider, WHERE);
    await one.judge({ code: "f()" }, QUESTION);
    await one.settled();

    const second = counting();
    const two = await RememberedProvider.open(d.dir, second.provider, WHERE);
    const again = await two.judge({ code: "f()" }, QUESTION);
    assert.equal(second.calls.length, 0, "the kept answer was used");
    assert.deepEqual(again.verdict?.choice, "yes");
    assert.equal(two.counts.reused, 1);

    const reworded: Questions = { verdict: { ...QUESTION.verdict!, instructions: "Does the call return its error!" } };
    await two.judge({ code: "f()" }, reworded);
    assert.equal(second.calls.length, 1, "a question whose words differ is asked");
    await two.judge({ code: "g()" }, QUESTION);
    assert.equal(second.calls.length, 2, "a different state is asked");
    assert.deepEqual(two.counts, { reused: 1, reusedFromEarlierRuns: 1, judgmentsPassedDown: 2, judgmentsAnsweredDown: 2 });
  } finally {
    d.remove();
  }
});

test("an answer kept for one host, origin or model is not used for another", async () => {
  const d = answersDir();
  try {
    const one = await RememberedProvider.open(d.dir, counting().provider, WHERE);
    await one.judge({ code: "f()" }, QUESTION);
    await one.settled();
    for (const [where, model] of [[{ ...WHERE, host: "custom" }, "typesafe/jev"], [{ ...WHERE, origin: "https://jev.example" }, "typesafe/jev"], [WHERE, "jev-latest"]] as const) {
      const inner = counting(model);
      const other = await RememberedProvider.open(d.dir, inner.provider, where);
      await other.judge({ code: "f()" }, QUESTION);
      assert.equal(inner.calls.length, 1, `${where.host} ${where.origin} ${model}`);
    }
    // The control: the same host, origin and model do reuse it.
    const same = counting();
    await (await RememberedProvider.open(d.dir, same.provider, WHERE)).judge({ code: "f()" }, QUESTION);
    assert.equal(same.calls.length, 0);
  } finally {
    d.remove();
  }
});

test("the file holds keys and answers only, never the state it was asked about", async () => {
  const d = answersDir();
  try {
    const one = await RememberedProvider.open(d.dir, counting().provider, WHERE);
    await one.judge({ code: "let secret_looking_excerpt = 1;" }, QUESTION);
    await one.settled();
    const text = readFileSync(join(d.dir, "answers.jsonl"), "utf8");
    assert.ok(!text.includes("secret_looking_excerpt"), text);
    assert.deepEqual(Object.keys(JSON.parse(text.trim()) as object), ["key", "answers"]);
  } finally {
    d.remove();
  }
});

test("a line that cannot be read, an answer missing a question and a choice not offered are asked again and counted", async () => {
  const d = answersDir();
  try {
    const probe = await RememberedProvider.open(d.dir, counting().provider, WHERE);
    const keyOf = (state: unknown) => probe.keyOf(state, QUESTION);
    const lines = [
      "not json",
      JSON.stringify({ key: keyOf({ n: 1 }), answers: {} }),
      JSON.stringify({ key: keyOf({ n: 2 }), answers: { verdict: { choice: "maybe", probability: 0.9, probabilities: {} } } }),
      JSON.stringify({ key: keyOf({ n: 3 }), answers: { verdict: { choice: "no", probability: 0.8, probabilities: { no: 0.8 } } } }),
    ];
    writeFileSync(join(d.dir, "answers.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
    const inner = counting();
    const ledger = await RememberedProvider.open(d.dir, inner.provider, WHERE);
    await ledger.judge({ n: 1 }, QUESTION);
    await ledger.judge({ n: 2 }, QUESTION);
    const kept = await ledger.judge({ n: 3 }, QUESTION);
    assert.equal(inner.calls.length, 2, "the two unusable answers were asked again");
    assert.equal(kept.verdict?.choice, "no", "the good one was used as kept");
    assert.equal(ledger.counts.reused, 1);
    const notes = ledger.notes().join("\n");
    assert.match(notes, /1 line\(s\) of the kept answers could not be read/);
    assert.match(notes, /2 kept answer\(s\) did not fit the question asked now/);
  } finally {
    d.remove();
  }
});

test("a directory or file others can read is not used, and the run says so", async () => {
  const d = answersDir();
  try {
    chmodSync(d.dir, 0o755);
    const inner = counting();
    const ledger = await RememberedProvider.open(d.dir, inner.provider, WHERE);
    await ledger.judge({ code: "f()" }, QUESTION);
    await ledger.settled();
    assert.match(ledger.notes().join("\n"), /were not used, and none was kept from this run: its directory is readable by others/);
    assert.throws(() => readFileSync(join(d.dir, "answers.jsonl")), "nothing was written there");
    chmodSync(d.dir, 0o700);
    writeFileSync(join(d.dir, "answers.jsonl"), "", { mode: 0o644 });
    chmodSync(join(d.dir, "answers.jsonl"), 0o644);
    assert.match((await RememberedProvider.open(d.dir, inner.provider, WHERE)).notes().join("\n"), /its file is readable by others/);
  } finally {
    d.remove();
  }
});

test("two identical requests in flight send one; a shared failure is not counted as reused", async () => {
  const d = answersDir();
  try {
    let release: (() => void) | undefined;
    const calls: unknown[] = [];
    const slow: JudgmentProvider = {
      model: "typesafe/jev",
      judge: (state) => {
        calls.push(state);
        return new Promise((resolve) => (release = () => resolve({ verdict: answer("yes") })));
      },
    };
    const ledger = await RememberedProvider.open(d.dir, slow, WHERE);
    const both = Promise.all([ledger.judge({ code: "f()" }, QUESTION), ledger.judge({ code: "f()" }, QUESTION)]);
    await new Promise((r) => setImmediate(r));
    release!();
    await both;
    assert.equal(calls.length, 1);
    assert.equal(ledger.counts.reused, 1);

    const failing: JudgmentProvider = { model: "typesafe/jev", judge: async () => Promise.reject(new ProviderError("bad_response", "no")) };
    const e = answersDir();
    const other = await RememberedProvider.open(e.dir, failing, WHERE);
    const results = await Promise.allSettled([other.judge({ code: "g()" }, QUESTION), other.judge({ code: "g()" }, QUESTION)]);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
    assert.equal(other.counts.reused, 0, "nothing was reused");
    assert.deepEqual([other.counts.judgmentsPassedDown, other.counts.judgmentsAnsweredDown], [1, 0]);
    e.remove();
  } finally {
    d.remove();
  }
});

test("an answer that cannot be written is still returned, and the run says it was not kept; answers before a failure stay", async () => {
  const d = answersDir();
  try {
    const inner = counting();
    const ledger = await RememberedProvider.open(d.dir, inner.provider, WHERE);
    await ledger.judge({ n: 1 }, QUESTION);
    await ledger.judge({ n: 2 }, QUESTION);
    await ledger.settled();
    chmodSync(d.dir, 0o755);
    const answers = await ledger.judge({ n: 3 }, QUESTION);
    await ledger.settled();
    chmodSync(d.dir, 0o700);
    assert.equal(answers.verdict?.choice, "yes", "the paid-for answer was returned");
    assert.match(ledger.notes().join("\n"), /1 answer\(s\) from this run could not be kept/);
    assert.equal(readFileSync(join(d.dir, "answers.jsonl"), "utf8").trim().split("\n").length, 2, "the two written before stayed");
  } finally {
    d.remove();
  }
});

// ---- through the command -------------------------------------------------------------------------

test("a second run over the same change sends nothing, reuses every answer, and reads as the first did", async () => {
  const repo = fixtureRepo("integrity-rust");
  const d = answersDir();
  try {
    const args = ["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--json", "--answers", d.dir];
    const first = io(repo.dir, CREDENTIALS);
    const one = fakeDeps();
    assert.equal(await main(args, first.value, one), EXIT.ok);
    const a = first.report();
    assert.ok(a.sent.requests > 0);
    assert.equal(a.sent.reused, 0);

    const second = io(repo.dir, CREDENTIALS);
    const scripted = formsProvider();
    assert.equal(await main(args, second.value, fakeDeps(scripted)), EXIT.ok);
    const b = second.report();
    assert.equal(scripted.calls.length, 0, "nothing reached the provider");
    assert.deepEqual([b.sent.requests, b.sent.answered, b.sent.reused, b.sent.reusedFromEarlierRuns], [0, 0, a.sent.answered, a.sent.answered]);
    assert.notEqual(resultKind(b).kind, "nothing_asked");
    assert.deepEqual(resultKind(b), resultKind(a));
    assert.deepEqual(b.requirements, a.requirements);
    assert.deepEqual(b.unexpectedChanges, a.unexpectedChanges);
  } finally {
    d.remove();
    repo.remove();
  }
});

test("a run without credentials is skipped and never opens the kept answers, whatever they hold", async () => {
  const repo = fixtureRepo("integrity-rust");
  const d = answersDir();
  try {
    const args = (answers: string) => ["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--json", "--answers", answers];
    assert.equal(await main(args(d.dir), io(repo.dir, CREDENTIALS).value, fakeDeps()), EXIT.ok);

    // A fork's pull request: no secrets, a full ledger in its cache.
    const event = join(d.dir, "..", `${d.dir.split("/").pop()}-event.json`);
    writeFileSync(event, JSON.stringify({ pull_request: { number: 7, user: { login: "someone" }, head: { repo: { full_name: "someone/cli" } }, base: { repo: { full_name: "owner/cli" } } } }));
    const fork = io(repo.dir, { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event });
    const deps = fakeDeps();
    assert.equal(await main(args(d.dir), fork.value, deps), EXIT.ok);
    const report = fork.report();
    assert.equal(report.skipKind, "fork");
    assert.deepEqual(report.requirements, []);
    assert.equal(report.sent.reused, 0);
    rmSync(event, { force: true });

    // Opening a path that is not a directory always leaves a note; without credentials it leaves none.
    const notADirectory = join(d.dir, "answers.jsonl");
    const noKeys = io(repo.dir, {});
    assert.equal(await main(args(notADirectory), noKeys.value, fakeDeps()), EXIT.ok);
    assert.ok(!noKeys.report().metadata.notes.some((n) => n.includes("--answers")), "the ledger was not opened");
    const withKeys = io(repo.dir, CREDENTIALS);
    assert.equal(await main(args(notADirectory), withKeys.value, fakeDeps()), EXIT.ok);
    assert.ok(withKeys.report().metadata.notes.some((n) => n.includes("--answers were not used")), "the control: with credentials it is opened and refused");
  } finally {
    d.remove();
    repo.remove();
  }
});

test("a run whose new requests all fail stops with exit 12, even when others came from the kept answers", async () => {
  const repo = fixtureRepo("integrity-rust");
  const d = answersDir();
  try {
    const base = ["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--json", "--answers", d.dir];
    // The calls' answers are kept; the changes' questions are new next time.
    assert.equal(await main([...base, "--skip-change-check"], io(repo.dir, CREDENTIALS).value, fakeDeps()), EXIT.ok);
    const scripted = formsProvider();
    const failingNew: JudgmentProvider = {
      model: scripted.model,
      judge: async () => Promise.reject(new ProviderError("bad_response", "unreadable")),
    };
    assert.equal(await main(base, io(repo.dir, CREDENTIALS).value, fakeDeps(failingNew)), EXIT.provider);
    // The control: the same run with a provider that answers finishes.
    assert.equal(await main(base, io(repo.dir, CREDENTIALS).value, fakeDeps()), EXIT.ok);
  } finally {
    d.remove();
    repo.remove();
  }
});

test("--answers with nothing in it is a configuration error", async () => {
  const repo = fixtureRepo("integrity-rust");
  try {
    assert.equal(await main(["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--answers", " "], io(repo.dir, CREDENTIALS).value, fakeDeps()), EXIT.config);
  } finally {
    repo.remove();
  }
});


test("only answers kept by an earlier run are counted as from earlier runs; a repeat within the run is reused but not that", async () => {
  const d = answersDir();
  try {
    const one = await RememberedProvider.open(d.dir, counting().provider, WHERE);
    await one.judge({ n: 1 }, QUESTION);
    await one.judge({ n: 1 }, QUESTION);
    assert.deepEqual([one.counts.reused, one.counts.reusedFromEarlierRuns], [1, 0], "the repeat came from this run");
    await one.settled();
    const two = await RememberedProvider.open(d.dir, counting().provider, WHERE);
    await two.judge({ n: 1 }, QUESTION);
    await two.judge({ n: 2 }, QUESTION);
    await two.judge({ n: 2 }, QUESTION);
    assert.deepEqual([two.counts.reused, two.counts.reusedFromEarlierRuns], [2, 1]);
  } finally {
    d.remove();
  }
});

test("a judgment refused for the run's budget was never sent: it does not count toward exit 12, with or without kept answers", async () => {
  const repo = fixtureRepo("integrity-rust");
  const d = answersDir();
  try {
    const args = ["--base", repo.base, "--head", repo.head, "--intent-spec", RUST_SPEC, "--json"];
    const budget: JudgmentProvider = { model: "scripted", judge: async () => Promise.reject(new ProviderError("budget", "time limit reached")) };
    const without = await main(args, io(repo.dir, CREDENTIALS).value, fakeDeps(budget));
    const withKept = await main([...args, "--answers", d.dir], io(repo.dir, CREDENTIALS).value, fakeDeps(budget));
    assert.equal(withKept, without, "keeping answers does not change how a budget-bound run ends");
    assert.notEqual(withKept, EXIT.provider);
  } finally {
    d.remove();
    repo.remove();
  }
});
