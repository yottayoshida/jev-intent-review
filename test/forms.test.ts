// Questions as forms, and the one rule that reads every form (docs/adr/0006-question-forms-as-data.md).
//
// The rule's table, the rule's shape (it names no form, and a form carries no rule), which calls
// `check_before_action` can ask about, both forms end to end on one repository built for this file,
// and the recorded answers of #36 read again through the rule.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseIntentSpec } from "../src/intent/schema.ts";
import type { JudgmentProvider, Questions } from "../src/judgments/provider.ts";
import type { CallCandidate } from "../src/plan/candidates.ts";
import { callTerms, chooseForm, FORM_QUESTION, formOf, FORMS, identifierWords, NEITHER_SAYS, readOption, requirementTerms, termsMeet } from "../src/plan/forms.ts";
import { BAR as OBSERVATION_BAR, describe } from "../src/plan/local-check.ts";
import { acceptMapping, MAPPING_BAR } from "../src/plan/mapping.ts";
import { LOCAL_CHECK_INTRO, requirementSection } from "../src/report/markdown.ts";
import { DEFAULT_LOCAL_CHECK, runLocalCheck, type LocalCheckResult as LocalCheckResultType } from "../src/review/local-check-run.ts";

const renderLocalCheck = (results: readonly LocalCheckResultType[]) => [...LOCAL_CHECK_INTRO, ...results.flatMap((r) => requirementSection(r))].join("\n");
import { outcomeOf, type Outcome, type Reading } from "../src/review/outcome.ts";
import { probabilityOf } from "../src/review/requirement.ts";
import type { Git } from "../src/repository/git.ts";
import { REQUIREMENT_FORMS, type ChoiceAnswer, type Requirement, type RequirementForm } from "../src/types.ts";

const BAR = OBSERVATION_BAR;
const FORM_NAMES = Object.keys(FORMS) as RequirementForm[];

// --- The rule ------------------------------------------------------------------------------------

test("the rule's table: the same for both forms, over every mapping and every observation", () => {
  const mappings: Record<string, Reading | undefined> = {
    "applies, over": { choice: "applies", probability: 0.9 },
    "applies, at the bar": { choice: "applies", probability: BAR },
    "applies, under": { choice: "applies", probability: 0.59 },
    "does_not_apply, over": { choice: "does_not_apply", probability: 0.9 },
    "does_not_apply, under": { choice: "does_not_apply", probability: 0.5 },
    "unknown, over": { choice: "unknown", probability: 0.95 },
    "unknown, under": { choice: "unknown", probability: 0.4 },
    "no answer": undefined,
  };
  // The expected column, written out rather than computed: only a governing mapping lets the
  // observation decide, and only a confident `does_not_apply` sets a call aside.
  const expected = (mapping: string, observation: string): Outcome => {
    if (mapping.startsWith("does_not_apply, over")) return "aside";
    if (mapping !== "applies, over" && mapping !== "applies, at the bar") return "unknown";
    if (observation === "against, over" || observation === "against, at the bar") return "violates";
    if (observation === "keeps, over" || observation === "keeps, at the bar") return "satisfies";
    return "unknown";
  };
  for (const name of FORM_NAMES) {
    const form = FORMS[name];
    const observations: Record<string, Reading | undefined> = {
      "against, over": { choice: form.violates[0]!, probability: 0.9 },
      "against, at the bar": { choice: form.violates[0]!, probability: BAR },
      "against, under": { choice: form.violates[0]!, probability: 0.55 },
      "keeps, over": { choice: form.keeps[0]!, probability: 0.9 },
      "keeps, at the bar": { choice: form.keeps[0]!, probability: BAR },
      "keeps, under": { choice: form.keeps[0]!, probability: 0.3 },
      "cannot_determine, over": { choice: "cannot_determine", probability: 0.99 },
      "an answer the form has no side for": { choice: "stops_there", probability: 0.99 },
      "no answer": undefined,
    };
    for (const [m, mapping] of Object.entries(mappings)) {
      for (const [o, observation] of Object.entries(observations)) {
        assert.equal(outcomeOf(mapping, observation, form, { mapping: BAR, observation: BAR }), expected(m, o), `${name}: mapping ${m}, observation ${o}`);
      }
    }
  }
});

test("the mapping's bar and the observation's are the same number, so the record's `governs` and the outcomes agree", () => {
  assert.equal(MAPPING_BAR, BAR);
});

test("the rule names no form and no observation answer, and the run builds its findings from the rule alone", () => {
  const answerNames = FORM_NAMES.flatMap((n) => [...FORMS[n].violates, ...FORMS[n].keeps]);
  for (const file of ["../src/review/outcome.ts", "../src/review/local-check-run.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const word of [...FORM_NAMES, ...answerNames]) assert.ok(!source.includes(word), `${file} mentions ${word}`);
  }
});

test("a form's sides are lists of its own answer names, not code", () => {
  for (const name of FORM_NAMES) {
    const form = FORMS[name];
    const fn = { id: "f", path: "src/a.rs", name: "f", startLine: 1, endLine: 3, signature: "fn f() -> Result<(), E>" } as never;
    const call = { id: "src/a.rs:call-1", functionId: "f", line: 2, text: "g(x)?;", callee: "g", expression: "g(x)", expressionComplete: true } as CallCandidate;
    const criteria = (form.observationQuestions(fn, call)[form.observationKey] as { criteria: Record<string, string> }).criteria;
    for (const side of [form.violates, form.keeps]) {
      assert.ok(Array.isArray(side) && side.length > 0, name);
      for (const answer of side) {
        assert.equal(typeof answer, "string");
        assert.ok(Object.hasOwn(criteria, answer), `${name}: ${answer} is one of the observation's options`);
      }
    }
    assert.deepEqual(form.violates.filter((a) => form.keeps.includes(a)), [], `${name}: no answer is on both sides`);
    assert.ok(Object.hasOwn(form.mappingQuestion(fn, call), "requirement_governs"), `${name}: the mapping is the one the rule reads`);
    for (const word of Object.values(form.words).filter((w): w is string => typeof w === "string")) assert.ok(!/violat/i.test(word), `${name}: the report's words carry no verdict`);
  }
});

// --- Which calls `check_before_action` asks about -------------------------------------------------

const call = (text: string, callee: string): CallCandidate => ({ id: "x:call-1", functionId: "x:function-1", line: 1, text, callee, column: 0, expression: `${callee}()`, expressionComplete: true });
const meets = (requirement: string, c: CallCandidate, hints: string[] = []) => {
  const wanted = requirementTerms({ text: requirement, searchHints: hints });
  return [...callTerms(c)].some((w) => [...wanted].some((r) => termsMeet(w, r)));
};

test("words are split the same way on both sides, and a whole identifier is a word too", () => {
  assert.deepEqual(identifierWords("create_session"), ["create_session", "create", "session"]);
  assert.deepEqual(identifierWords("createSession"), ["createsession", "create", "session"]);
  assert.deepEqual(identifierWords("HTTPClient"), ["httpclient", "http", "client"]);
  assert.ok(meets("`create_session` must not run for a disabled key.", call("let s = create_session(&k)?;", "create_session")));
  assert.ok(meets("createSession is refused for a disabled key.", call("self.create_session(&k)?;", "create_session")));
});

test("the call's words come from its whole path and the receivers before it", () => {
  assert.ok(callTerms(call("let s = Session::new(k);", "Session::new")).has("session"));
  const insert = call("self.sessions.insert(id, s);", "insert");
  assert.ok(callTerms(insert).has("sessions"));
  assert.ok(!callTerms(insert).has("self"), "every method call has a self; it is not a word of this one");
  assert.ok(meets("A disabled key never gets a session.", insert));
});

test("short action names are words: no five-letter floor here", () => {
  for (const [requirement, c] of [
    ["It must not send the report before the check.", call("send(report)?;", "send")],
    ["Nothing is saved for a guest.", call("store.save(item)?;", "save")],
    ["Do not pay an unverified invoice.", call("pay(invoice)?;", "pay")],
  ] as const) {
    assert.ok(meets(requirement, c), `${requirement} / ${c.text}`);
  }
});

test("common words and unrelated names do not make a call askable", () => {
  assert.ok(!meets("It must never be done before that.", call("done_before(x);", "x_y")), "stop words carry nothing");
  assert.ok(!meets("A disabled key never gets a session.", call("audit(store)?;", "audit")));
  assert.ok(termsMeet("create", "creation") && termsMeet("key", "keys") && termsMeet("send", "sends") && termsMeet("rewrite", "rewritten"));
  assert.ok(!termsMeet("read", "write") && !termsMeet("session", "secret") && !termsMeet("create", "crest"));
  // A short receiver that begins a longer word of the sentence is not that word.
  assert.ok(!termsMeet("res", "restore") && !termsMeet("gen", "generate") && !termsMeet("ctx", "context"));
  assert.ok(!meets("While a restore is being finalized, heights must not be rewritten.", call("hash.copy_from_slice(res.as_bytes());", "as_bytes")));
});

test("search hints count as the requirement's words", () => {
  assert.ok(!meets("Nothing leaves before the check.", call("dispatch(msg)?;", "dispatch")));
  assert.ok(meets("Nothing leaves before the check.", call("dispatch(msg)?;", "dispatch"), ["dispatch"]));
});

// --- Both forms, end to end ----------------------------------------------------------------------

/**
 * The changed file: a guarded action, a lookup before the guard, the guard, an unrelated call, and a
 * caller one hop out that only delegates.
 */
const AUTH = `pub fn login(store: &mut Store, key: &ApiKey) -> Result<Session, AuthError> {
    let session = open_session(store, key)?;
    Ok(session)
}

pub fn open_session(store: &mut Store, key: &ApiKey) -> Result<Session, AuthError> {
    let record = load_key(store, key)?;
    if is_disabled(&record) {
        return Err(AuthError::Disabled);
    }
    audit(store)?;
    let session = create_session(store, &record)?;
    Ok(session)
}
`;

/** The guard taken out: the defect a check-before-action requirement is about. */
const AUTH_UNGUARDED = AUTH.replace("    if is_disabled(&record) {\n        return Err(AuthError::Disabled);\n    }\n", "");

const STORE = `pub fn load_key(store: &Store, key: &ApiKey) -> Result<KeyRecord, StoreError> {
    Ok(KeyRecord::default())
}

pub fn is_disabled(record: &KeyRecord) -> bool {
    record.disabled
}

pub fn audit(store: &mut Store) -> Result<(), StoreError> {
    Ok(())
}

pub fn create_session(store: &mut Store, record: &KeyRecord) -> Result<Session, StoreError> {
    Ok(Session::default())
}
`;

/**
 * A repository of strings: `files` after the change, `before` for the files the change touched, the
 * diff as git would print it, and which searches come back cut at the cap.
 */
function fakeRepo(files: Record<string, string>, before: Record<string, string>, diff: string, cut: (pattern: string) => boolean = () => false): Git {
  return {
    async readText(rev: string, path: string) {
      return (rev === "BEFORE" ? (before[path] ?? files[path]) : files[path]) ?? null;
    },
    async changedFiles() {
      return Object.keys(before).map((p) => ({ status: "modified" as const, oldPath: p, newPath: p }));
    },
    async diffText() {
      return diff;
    },
    async grep(_rev: string, pattern: string) {
      const hits = Object.entries(files).flatMap(([path, text]) =>
        text.split("\n").flatMap((l, i) => (new RegExp(`(?<![\\w$])${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`, "i").test(l) ? [{ path, line: i + 1, text: l }] : [])),
      );
      return { hits, more: cut(pattern) };
    },
  } as unknown as Git;
}

/** One hunk: the line of `after` holding `needle`, which read `was` before. */
const hunk = (path: string, after: string, needle: string, was: string) => {
  const line = after.split("\n").findIndex((l) => l.includes(needle)) + 1;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line} +${line} @@\n-    ${was}\n+    ${needle}\n`;
};

function authRepo(auth: string): Git {
  return fakeRepo({ "src/auth.rs": auth, "src/store.rs": STORE }, { "src/auth.rs": auth.replace("audit(store)?;", "record_use(store)?;") }, hunk("src/auth.rs", auth, "audit(store)?;", "record_use(store)?;"));
}

const requirementOf = (id: string, text: string, form?: RequirementForm): Requirement => ({ id, text, kind: "behavior", priority: "required", sourceRefs: [], searchHints: [], ...(form ? { form } : {}) });
const GUARD = requirementOf("GUARD", "A disabled API key must never create a session.", "check_before_action");
const AUDIT_FIRST = requirementOf("AUDIT", "The audit must run first.", "check_before_action");
const FAILURES = requirementOf("FAIL", "A failure to load the key or to store the session is never reported as success.");

const choice = (c: string, p = 0.9): ChoiceAnswer => ({ choice: c, probability: p, confidence: p, probabilities: { [c]: p } });

/**
 * One Jev for both forms. The mapping governs only the guarded action for the guard requirement and
 * every call for the others; the reading comes from the body, so it never agrees by construction.
 */
function jev(): JudgmentProvider {
  return {
    model: "typesafe/jev",
    async judge(state: unknown, questions: Questions): Promise<Record<string, ChoiceAnswer>> {
      const packet = state as { requirement: { id: string }; evidence: { code: string } };
      const [key] = Object.keys(questions);
      const instructions = (questions as unknown as Record<string, { instructions: string }>)[key!]!.instructions;
      const named = /the call `([^`]+)`/.exec(instructions)?.[1] ?? /reaches the call `([^`]+)`/.exec(instructions)?.[1] ?? "";
      if (key === "requirement_governs") {
        if (packet.requirement.id === "GUARD") return { requirement_governs: named.startsWith("create_session") || named.startsWith("open_session") ? choice("applies") : choice("does_not_apply") };
        return { requirement_governs: choice("applies") };
      }
      const body = packet.evidence.code;
      if (key === "in_forbidden_case") {
        // Read as the measured Jev read it: a guard in this body before the call keeps it; a call
        // into a function that guards inside is still made from here.
        const guarded = body.indexOf("is_disabled(") >= 0 && body.indexOf("is_disabled(") < body.indexOf(named);
        return { in_forbidden_case: choice(guarded ? "does_not_reach" : "reaches_it") };
      }
      const flat = body.replace(/\s+/g, " ");
      return { on_error_result: choice(flat.includes(`${named}?`) ? "returns_error" : "returns_success"), on_error_control: choice("stops_there") };
    },
  };
}

/** A run as the command has it: the changed functions, then their callers (ADR 0015). */
const complete = async <T extends { askCallers(): Promise<unknown> }>(p: Promise<T>): Promise<T> => {
  const x = await p;
  await x.askCallers();
  return x;
};
const run = (auth: string, requirements: Requirement[]) => complete(runLocalCheck(authRepo(auth), { before: "BEFORE", after: "AFTER" }, requirements, jev(), () => true, DEFAULT_LOCAL_CHECK)).then((x) => x.requirements);
const asked = (r: { wouldAsk: { call: string }[] }) => r.wouldAsk.map((w) => w.call.replace(/\(.*$/s, "")).sort();

test("check_before_action end to end: the unguarded action is worth checking, the guarded one holds", async () => {
  const [shipped] = await run(AUTH, [GUARD]);
  assert.equal(shipped!.form, "check_before_action");
  assert.deepEqual(asked(shipped!), ["create_session", "is_disabled", "load_key"], "the calls named in the requirement's words, the guard and the lookup among them");
  assert.deepEqual(shipped!.findings, []);
  assert.equal(shipped!.observed.find((o) => o.call.startsWith("create_session"))?.outcome, "satisfies");
  for (const before of ["load_key", "is_disabled"]) assert.equal(shipped!.observed.find((o) => o.call.startsWith(before))?.outcome, "aside", `${before} is reached in the forbidden case, and only the mapping keeps it out`);
  const audit = shipped!.unchecked.find((u) => u.call.startsWith("audit"));
  assert.match(audit?.why ?? "", /no word of `audit\(store\)`'s name is in the requirement/);
  // The caller's call into the function that checks inside is left to be asked about in there: from
  // the caller, the measured Jev read it as made in the forbidden case, and listed the shipped code.
  const delegating = shipped!.unchecked.find((u) => u.function === "login");
  assert.match(delegating?.why ?? "", /`open_session` \(src\/auth\.rs:\d+\) is read on its own in this run/);
  assert.equal(shipped!.counts.functions.calls_changed, 1, "login is in the set");

  const [unguarded] = await run(AUTH_UNGUARDED, [GUARD]);
  assert.deepEqual(unguarded!.findings.map((f) => f.call), ["create_session(store, &record)"]);
  const f = unguarded!.findings[0]!;
  assert.equal(f.property, "check_passes_before_call");
  assert.equal(f.observation, "reaches_it");
  assert.match(f.condition, /must not be made, because the check it asks for does not pass/);
  assert.match(f.why, /still makes the call in a case the requirement forbids it/);
  const text = renderLocalCheck([unguarded!]);
  assert.match(text, /Form: `check_before_action`/);
  assert.match(text, /### Worth checking/);
  assert.match(text, /\*\*Jev, on whether the function still makes the call\*\*: reaches_it/);
  assert.match(text, /in a case the requirement forbids it: \*\*reaches_it\*\*/);
  assert.ok(!/when that call fails/.test(text), "no failure-form words in a check-form section");
  assert.ok(!/violat/i.test(text));
});

test("a callee is left to be asked about inside only when its one definition is a function read here — a same-named function elsewhere in the change does not hold it", async () => {
  // `create_session` twice: the store's, which `open_session` calls, and an unrelated one in a cache
  // module the change also touched. Judged by the name alone, the store's call was held with the
  // cache function's reason — and neither body was asked about it.
  const CACHE = `pub fn create_session(cache: &mut Cache, id: &str) -> Result<(), CacheError> {
    cache.touch(id)?;
    Ok(())
}
`;
  const git = fakeRepo(
    { "src/auth.rs": AUTH_UNGUARDED, "src/store.rs": STORE, "src/cache.rs": CACHE },
    { "src/auth.rs": AUTH_UNGUARDED.replace("audit(store)?;", "record_use(store)?;"), "src/cache.rs": CACHE.replace("cache.touch(id)?;", "cache.mark(id)?;") },
    hunk("src/auth.rs", AUTH_UNGUARDED, "audit(store)?;", "record_use(store)?;") + hunk("src/cache.rs", CACHE, "cache.touch(id)?;", "cache.mark(id)?;"),
  );
  const [r] = (await complete(runLocalCheck(git, { before: "BEFORE", after: "AFTER" }, [GUARD], jev(), () => true, DEFAULT_LOCAL_CHECK))).requirements;
  assert.equal(r!.counts.functions.changed, 2, "both create_session's function and open_session are in the set");
  assert.ok(r!.wouldAsk.some((w) => w.function === "open_session" && w.call.startsWith("create_session")), `the store's call is asked about: ${JSON.stringify(r!.wouldAsk)}`);
  assert.ok(!r!.unchecked.some((u) => u.function === "open_session" && u.call.startsWith("create_session")), JSON.stringify(r!.unchecked));
  assert.deepEqual(r!.findings.map((f) => `${f.function} · ${f.call}`), ["open_session · create_session(store, &record)"]);
  // The control: one definition, at a function read here — still held, and named with its place.
  assert.match(r!.unchecked.find((u) => u.function === "login")?.why ?? "", /`open_session` \(src\/auth\.rs:\d+\) is read on its own/);
});

test("a name whose search was cut at the cap is not taken to be read here: its one seen definition may not be the only one", async () => {
  // A search is made once per name for the whole run, so a cut search for `open_session` also stops
  // its callers from being followed. `login` is in the set here because the change touched it too.
  const before = AUTH.replace("    let session = open_session(store, key)?;\n    Ok(session)\n", "    open_session(store, key)\n").replace("audit(store)?;", "record_use(store)?;");
  const auditLine = AUTH.split("\n").findIndex((l) => l.includes("audit(store)?;")) + 1;
  const diff = `diff --git a/src/auth.rs b/src/auth.rs\n--- a/src/auth.rs\n+++ b/src/auth.rs\n@@ -2 +2,2 @@ pub fn login\n-    open_session(store, key)\n+    let session = open_session(store, key)?;\n+    Ok(session)\n@@ -${auditLine - 1} +${auditLine} @@ pub fn open_session\n-    record_use(store)?;\n+    audit(store)?;\n`;
  const cut = fakeRepo({ "src/auth.rs": AUTH, "src/store.rs": STORE }, { "src/auth.rs": before }, diff, (pattern) => pattern === "open_session");
  const [r] = (await complete(runLocalCheck(cut, { before: "BEFORE", after: "AFTER" }, [GUARD], jev(), () => true, DEFAULT_LOCAL_CHECK))).requirements;
  assert.equal(r!.counts.functions.changed, 2, "login and open_session are both changed");
  assert.ok(r!.wouldAsk.some((w) => w.function === "login" && w.call.startsWith("open_session")), `asked about from login: ${JSON.stringify(r!.wouldAsk)}`);
  assert.ok(!r!.unchecked.some((u) => u.function === "login"), JSON.stringify(r!.unchecked));
});

test("each requirement asks with its own form and its own words, in either order", async () => {
  const expected: Record<string, string[]> = {
    GUARD: ["create_session", "is_disabled", "load_key"],
    AUDIT: ["audit"],
    // Failures: the callees returning a Result — `audit` and the delegating call among them, the
    // guard not. What the check form leaves to the callee, the failure form asks at the caller.
    FAIL: ["audit", "create_session", "load_key", "open_session"],
  };
  for (const order of [[GUARD, FAILURES], [FAILURES, GUARD], [GUARD, AUDIT_FIRST], [AUDIT_FIRST, GUARD]]) {
    const results = await run(AUTH, order);
    for (const r of results) assert.deepEqual(asked(r), expected[r.requirementId], `${order.map((q) => q.id).join(" then ")}: ${r.requirementId}`);
  }
  const [fail] = await run(AUTH, [GUARD, FAILURES]).then((rs) => rs.filter((r) => r.requirementId === "FAIL"));
  assert.equal(fail!.form, "failure_propagation");
  assert.match(fail!.unchecked.find((u) => u.call.startsWith("is_disabled"))?.why ?? "", /does not return a Result/);
  assert.ok(fail!.observed.every((o) => o.outcome === "satisfies"));
  assert.match(renderLocalCheck([fail!]), /when that call fails: \*\*returns_error\*\*/);
});

// --- The spec -----------------------------------------------------------------------------------

test("a spec may name a requirement's form; absent is failure propagation, and an unknown one is refused", () => {
  const spec = (form?: unknown) => JSON.stringify({ version: 1, requirements: [{ id: "R1", text: "x must hold", ...(form === undefined ? {} : { form }) }] });
  const plain = parseIntentSpec(spec(), "t").requirements[0]!;
  assert.ok(!("form" in plain), "a spec without it reads back as it did");
  assert.equal(formOf(plain).name, "failure_propagation");
  assert.equal(parseIntentSpec(spec("check_before_action"), "t").requirements[0]!.form, "check_before_action");
  assert.throws(() => parseIntentSpec(spec("check_before"), "t"), /requirements\[0\]\.form must be one of: failure_propagation, check_before_action/);
  assert.throws(() => parseIntentSpec(spec(3), "t"), /form must be one of/);
});

// --- The recorded answers of #36, through the rule ----------------------------------------------

test("every recorded answer pair of #36 comes out of the rule listed exactly where it was listed", () => {
  interface Sent {
    packet: string;
    questions: string[];
    answers?: Record<string, ChoiceAnswer>;
  }
  interface Recorded {
    observed: { file: string; function: string; call: string; result: { observation: string; why: string } }[];
    findings: { file: string; function: string; call: string }[];
  }
  const log = JSON.parse(readFileSync(new URL("../bench/logs/acceptance-v1.json", import.meta.url), "utf8")) as {
    cases: Record<string, { versions: Record<string, { runs: { requirements: Recorded[]; sent: Sent[] }[] }> }>;
  };
  const form = FORMS.failure_propagation;
  let pairs = 0;
  let listed = 0;
  for (const [caseId, c] of Object.entries(log.cases)) {
    for (const [versionId, v] of Object.entries(c.versions)) {
      v.runs.forEach((run, n) => {
        const where = `${caseId} ${versionId} run ${n + 1}`;
        const observed = run.requirements.flatMap((r) => r.observed.map((o) => ({ o, findings: r.findings })));
        assert.equal(run.sent.length, observed.length * 2, `${where}: a mapping and a reading per call`);
        observed.forEach(({ o, findings }, i) => {
          const [m, r] = [run.sent[2 * i]!, run.sent[2 * i + 1]!];
          assert.deepEqual([m.questions, r.questions, m.packet === r.packet], [["requirement_governs"], ["on_error_result", "on_error_control"], true], `${where}: pair ${i + 1}`);
          const mapping = acceptMapping(m.answers?.requirement_governs);
          const answer = r.answers?.on_error_result;
          const result = describe(answer, answer ? probabilityOf(answer, answer.choice) : 0, form.words.reading);
          // The raw answer read again gives the reading that was recorded: the pairing is right.
          assert.deepEqual([result.observation, result.why], [o.result.observation, o.result.why], `${where}: ${o.function} · ${o.call}`);
          const outcome = outcomeOf(mapping.verdict === "no_answer" ? undefined : { choice: mapping.verdict, probability: mapping.probability }, result.observation === "withheld" ? undefined : { choice: result.observation, probability: result.probability }, form, { mapping: MAPPING_BAR, observation: BAR });
          const wasListed = findings.some((f) => f.file === o.file && f.function === o.function && f.call === o.call);
          assert.equal(outcome === "violates", wasListed, `${where}: ${o.function} · ${o.call} (${outcome})`);
          pairs += 1;
          if (wasListed) listed += 1;
        });
      });
    }
  }
  // The recorded set, so a log that lost its runs cannot pass by having nothing in it.
  assert.deepEqual({ pairs, listed }, { pairs: 102, listed: 6 });
});

// --- Which form a sentence says (ADR 0008) ----------------------------------------------------------

test("the form question is the measured one: its serialisation hashes to what the log recorded", () => {
  const log = JSON.parse(readFileSync(new URL("../bench/logs/form-choice-v1.json", import.meta.url), "utf8")) as { conditions: { question: string } };
  const hash = createHash("sha256").update(JSON.stringify(FORM_QUESTION)).digest("hex");
  assert.equal(hash, log.conditions.question, "the question's wording or its key order differs from the one measured in bench/logs/form-choice-v1.json");
});

test("the form question is assembled from the forms' own criteria, in their order, then neither", () => {
  const q = FORM_QUESTION.requirement_form!;
  assert.deepEqual(Object.keys(q), ["type", "instructions", "criteria"]);
  assert.deepEqual(Object.keys(q.criteria), [...FORM_NAMES, "neither"]);
  for (const name of FORM_NAMES) assert.equal(q.criteria[name], FORMS[name].says);
  assert.equal(q.criteria.neither, NEITHER_SAYS);
  assert.ok(!(REQUIREMENT_FORMS as readonly string[]).includes("neither"), "neither is an option, not a form");
});

test("readOption: an offered option at the bar, under it, or none; chooseForm reads the forms through it", () => {
  const a = (choice: string, p: number): ChoiceAnswer => ({ choice, probability: p, confidence: p, probabilities: { [choice]: p } });
  assert.deepEqual(readOption(a("check_before_action", 0.6), REQUIREMENT_FORMS, BAR), { kind: "option", option: "check_before_action", probability: 0.6 });
  assert.deepEqual(readOption(a("check_before_action", 0.59), REQUIREMENT_FORMS, BAR), { kind: "under", option: "check_before_action", probability: 0.59 });
  assert.deepEqual(readOption(a("neither", 0.99), REQUIREMENT_FORMS, BAR), { kind: "none" });
  assert.deepEqual(readOption(a("neither", 0.99), [...REQUIREMENT_FORMS, "neither"], BAR), { kind: "option", option: "neither", probability: 0.99 });
  assert.deepEqual(readOption(undefined, REQUIREMENT_FORMS, BAR), { kind: "none" });
  assert.deepEqual(chooseForm(a("check_before_action", 0.6)), { form: "check_before_action", by: "jev", verdict: "check_before_action", probability: 0.6 });
  assert.deepEqual(chooseForm(a("neither", 0.99)), { form: "failure_propagation", by: "default", verdict: "neither", probability: 0.99 });
  assert.deepEqual(chooseForm(a("failure_propagation", 0.59)), { form: "failure_propagation", by: "default", verdict: "failure_propagation", probability: 0.59 });
  assert.deepEqual(chooseForm(undefined), { form: "failure_propagation", by: "default", verdict: "no_answer", probability: 0 });
});
