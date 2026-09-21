import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeChange } from "../src/change/seeds.ts";
import { Discoverer, isTestPath, refuseWord, requirementWords } from "../src/discovery/discover.ts";
import { buildEvidence, withoutStrings } from "../src/evidence/builder.ts";
import { cut, isSensitivePath, redact } from "../src/evidence/redact.ts";
import { Git } from "../src/repository/git.ts";
import type { Requirement } from "../src/types.ts";
import { FIXTURES, fixtureRepo, tempRepo } from "./helpers/repo.ts";

function spec(name: string): Requirement {
  const r = JSON.parse(readFileSync(join(FIXTURES, name, "fixture.json"), "utf8")).spec.requirements[0];
  return { kind: "behavior", priority: "required", sourceRefs: [], searchHints: [], ...r };
}

async function discover(name: string, requirement: Requirement, after: "head" | "fixed" = "head") {
  const repo = fixtureRepo(name);
  const git = await Git.open(repo.dir);
  const to = (after === "fixed" ? repo.fixed : repo.head) as string;
  const change = await analyzeChange(git, repo.base, to, () => true);
  const discoverer = new Discoverer(git, to, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
  return { repo, git, change, discoverer, found: await discoverer.discover(requirement, change) };
}

// The plan's check 2a: discovery alone, no model.
/** Everything the search left, whatever weight it carries: leads, unjudged places, gaps. */
function left(d: { notFollowed: string[]; unjudged: string[]; blocking: string[] }): string[] {
  return [...d.notFollowed, ...d.unjudged, ...d.blocking];
}

test("missed-path: discovery reaches the unchanged OAuth and WebSocket logins and not the unrelated invoice code", async () => {
  const { repo, found } = await discover("missed-path", spec("missed-path"));
  try {
    const paths = found.candidates.map((c) => c.path);
    for (const path of ["src/auth/oauth.ts", "src/auth/websocket.ts", "src/auth/api-key.ts", "src/auth/password.ts"]) assert.ok(paths.includes(path), path);
    assert.ok(!paths.includes("src/billing/invoice.ts"));
    const oauth = found.candidates.find((c) => c.path === "src/auth/oauth.ts");
    assert.deepEqual([oauth?.symbol, oauth?.changed], ["completeOAuthLogin", false]);
    assert.ok(oauth?.reasons.includes("calls createSession"));
    assert.equal(found.candidates.find((c) => c.path === "src/auth/password.ts")?.changed, true);
    assert.deepEqual(left(found), []);
  } finally {
    repo.remove();
  }
});

test("a pull request that rewrites the governed call's own line, or adds a test calling it, still has its other callers searched", async () => {
  const variants: Record<string, string>[] = [
    { "src/auth/password.ts": readFileSync(join(FIXTURES, "missed-path", "head", "src", "auth", "password.ts"), "utf8").replace("return createSession(user.id);", "return createSession(String(user.id));") },
    { "src/session/extra.test.ts": 'import { createSession } from "./store.ts";\ncreateSession("u");\n' },
  ];
  for (const extra of variants) {
    const repo = fixtureRepo("missed-path");
    try {
      repo.git("checkout", "-q", repo.head);
      repo.write(extra);
      const head = repo.commit("more");
      const git = await Git.open(repo.dir);
      const change = await analyzeChange(git, repo.base, head, () => true);
      const found = await new Discoverer(git, head, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true }).discover(spec("missed-path"), change);
      const paths = found.candidates.map((c) => c.path);
      assert.ok(paths.includes("src/auth/websocket.ts") && paths.includes("src/auth/oauth.ts"), Object.keys(extra)[0]);
    } finally {
      repo.remove();
    }
  }
});

test("an error type the guard throws is not followed, and the search record says why", async () => {
  const { repo, found } = await discover("missed-path", spec("missed-path"));
  try {
    const authError = found.searches.find((s) => s.query === "AuthError" && s.layer === "C");
    assert.match(authError?.rejected ?? "", /an error type/);
    assert.ok(!found.candidates.some((c) => c.symbol === "exchangeCode"), "a helper that only throws the same error is not a candidate");
    assert.deepEqual(left(found), [], "a deliberate category, not a cut-short search");
  } finally {
    repo.remove();
  }
});

test("a short calling function is given whole as context, so a guard next to the call is seen", async () => {
  const repo = tempRepo();
  try {
    repo.write({
      "src/fetch.ts": "export async function fetchProfile(code) {\n  return lookup(code);\n}\n",
      "src/login.ts": "export async function login(code) {\n  const profile = await fetchProfile(code);\n  const user = find(profile);\n  if (user.disabledAt) throw new Error('disabled');\n  return createSession(user.id);\n}\n",
    });
    const sha = repo.commit("files");
    const git = await Git.open(repo.dir);
    const d = new Discoverer(git, sha, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
    const requirement = { id: "R1", text: "Disabled users cannot sign in.", kind: "behavior" as const, priority: "required" as const, sourceRefs: [], searchHints: [] };
    const evidence = await buildEvidence(d, requirement, { path: "src/fetch.ts", startLine: 1, endLine: 3, symbol: "fetchProfile", changed: false, reasons: [] }, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
    const caller = evidence.packet.evidence.related.find((r) => r.path === "src/login.ts");
    assert.equal(caller?.lines, "1-6");
    assert.match(caller?.code ?? "", /user\.disabledAt/);
  } finally {
    repo.remove();
  }
});

test("a call too common to follow makes the search incomplete; test files do not count towards common", async () => {
  const build = async (callers: Record<string, string>) => {
    const repo = tempRepo();
    repo.write({ "src/store.ts": "export function saveRecord(r) {\n  return r;\n}\n", "src/api.ts": "export function create(r) {\n  return saveRecord(r);\n}\n", ...callers });
    const base = repo.commit("base");
    repo.write({ "src/api.ts": "export function create(r) {\n  audit(r);\n  return saveRecord(r);\n}\n" });
    const head = repo.commit("head");
    const git = await Git.open(repo.dir);
    const change = await analyzeChange(git, base, head, () => true);
    const found = await new Discoverer(git, head, { include: () => true, maxCandidates: 30, lexicalSearch: false, referenceSearch: true }).discover({ ...spec("missed-path"), searchHints: [] }, change);
    repo.remove();
    return found;
  };
  const many = Object.fromEntries(Array.from({ length: 42 }, (_, i) => [`src/job${i}.ts`, `export function job${i}(r) {\n  return saveRecord(r);\n}\n`]));
  const common = await build(many);
  assert.ok(left(common).some((r) => /callers of saveRecord were not followed/.test(r)), JSON.stringify(left(common)));
  assert.ok(common.searches.some((s) => s.query === "saveRecord" && s.rejected));

  const tests = Object.fromEntries(Array.from({ length: 42 }, (_, i) => [`test/job${i}.test.ts`, `saveRecord({ id: ${i} });\n`]));
  const fine = await build(tests);
  assert.ok(!left(fine).some((r) => /saveRecord/.test(r)), JSON.stringify(left(fine)));
});

test("unknown-plugin: discovery reaches the plugin loader and the purge job", async () => {
  const { repo, found } = await discover("unknown-plugin", spec("unknown-plugin"));
  try {
    const paths = found.candidates.map((c) => c.path);
    assert.ok(paths.includes("src/plugins/loader.ts"));
    assert.ok(paths.includes("src/jobs/purge.ts"));
    assert.ok(!found.candidates.some((c) => c.symbol === "PluginHost"), "an interface runs nothing");
  } finally {
    repo.remove();
  }
});

test("declarations and non-code files are candidates only for data, interface or documentation requirements", async () => {
  const behavior = await discover("missed-path", { ...spec("missed-path"), searchHints: ["disabledAt"] });
  const data = await discover("missed-path", { ...spec("missed-path"), kind: "data", searchHints: ["disabledAt"] });
  try {
    assert.ok(!behavior.found.candidates.some((c) => c.symbol === "User"));
    assert.ok(data.found.candidates.some((c) => c.symbol === "User"));
  } finally {
    behavior.repo.remove();
    data.repo.remove();
  }

  const repo = tempRepo();
  try {
    repo.write({ "src/a.ts": "export function login() {\n  return start();\n}\n", "CHANGELOG.md": "- login now calls start()\n" });
    const base = repo.commit("base");
    repo.write({ "src/a.ts": "export function login() {\n  check();\n  return start();\n}\n" });
    const head = repo.commit("head");
    const git = await Git.open(repo.dir);
    const change = await analyzeChange(git, base, head, () => true);
    const make = (kind: Requirement["kind"]) => ({ id: "R1", text: "Every login is checked first.", kind, priority: "required" as const, sourceRefs: [], searchHints: ["login"] });
    const d = new Discoverer(git, head, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
    assert.ok(!(await d.discover(make("behavior"), change)).candidates.some((c) => c.path === "CHANGELOG.md"));
    assert.ok((await d.discover(make("documentation"), change)).candidates.some((c) => c.path === "CHANGELOG.md"));
  } finally {
    repo.remove();
  }
});

test("search words that look like options, are too short or are not one word are refused and recorded", async () => {
  assert.equal(refuseWord("--no-index"), "starts with '-'");
  assert.equal(refuseWord("abc"), "shorter than 4 characters");
  assert.equal(refuseWord("two words"), "not a single word");
  assert.equal(refuseWord("createSession"), null);
  assert.deepEqual(requirementWords("Disabled users cannot authenticate, ever."), ["disabled", "users", "authenticate"]);
  assert.ok(isTestPath("src/session/store.test.ts") && isTestPath("tests/a.rs") && isTestPath("pkg/a_test.go") && !isTestPath("src/testing.ts"));

  const { repo, found } = await discover("missed-path", { ...spec("missed-path"), searchHints: ["--no-index", "abc"] });
  try {
    assert.ok(found.searches.some((s) => s.query === "--no-index" && s.rejected === "starts with '-'"));
    assert.ok(found.searches.some((s) => s.query === "abc" && s.rejected));
  } finally {
    repo.remove();
  }
});

test("discovery caps the candidate list and says so", async () => {
  const repo = fixtureRepo("missed-path");
  try {
    const git = await Git.open(repo.dir);
    const change = await analyzeChange(git, repo.base, repo.head, () => true);
    const found = await new Discoverer(git, repo.head, { include: () => true, maxCandidates: 2, lexicalSearch: true, referenceSearch: true }).discover(spec("missed-path"), change);
    assert.equal(found.candidates.length, 2);
    assert.match(left(found)[0] ?? "", /only the first 2 were judged/);
  } finally {
    repo.remove();
  }
});

test("evidence for a route-protected path carries the route line and, one hop on, the middleware's body", async () => {
  const { repo, discoverer, found } = await discover("missed-path", spec("missed-path"));
  try {
    const apiKey = found.candidates.find((c) => c.path === "src/auth/api-key.ts");
    assert.ok(apiKey);
    const evidence = await buildEvidence(discoverer, spec("missed-path"), apiKey, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
    const related = evidence.packet.evidence.related;
    assert.ok(related.some((r) => r.path === "src/routes.ts" && r.code.includes("rejectDisabledUsers")));
    assert.ok(related.some((r) => r.path === "src/middleware/reject-disabled.ts" && r.code.includes("user?.disabledAt")));
    assert.equal(evidence.truncated, false);
    assert.ok(evidence.callSites.some((l) => `${l.path}:${l.startLine}` === "src/auth/api-key.ts:8"), "points at the createSession call");
    // One hop down as well: the bodies of what the candidate calls.
    assert.ok(related.some((r) => r.path === "src/session/store.ts" && r.code.includes("function createSession")));
    assert.ok(evidence.sent.some((l) => l.path === "src/middleware/reject-disabled.ts"));
  } finally {
    repo.remove();
  }
});

test("evidence takes every middleware on a route, the guard helpers a path calls, and no names from strings", async () => {
  const repo = tempRepo();
  try {
    repo.write({
      "src/mw.ts": ["export function parseBody(q) {\n  return q;\n}", "export function rateLimit(q) {\n  return q;\n}", "export function rejectDisabledUsers(q) {\n  if (q.user.disabledAt) throw new Error('disabled');\n}", "export function assertActive(u) {\n  if (u.disabledAt) throw new Error('disabled');\n}"].join("\n"),
      "src/login.ts": "export function loginWithKey(q) {\n  assertActive(q.user);\n  return createSession(q.user);\n}\n",
      "src/routes.ts": 'router.post("/login/parseBody", parseBody, rateLimit, rejectDisabledUsers, loginWithKey);\n',
      "src/login-too.ts": "export function loginTwice(q) {\n  return createSession(q.user);\n}\n",
    });
    const sha = repo.commit("files");
    const git = await Git.open(repo.dir);
    const d = new Discoverer(git, sha, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
    const requirement = { id: "R1", text: "Disabled users cannot sign in.", kind: "behavior" as const, priority: "required" as const, sourceRefs: [], searchHints: [] };
    const evidence = await buildEvidence(d, requirement, { path: "src/login.ts", startLine: 1, endLine: 4, symbol: "loginWithKey", changed: false, reasons: ["calls createSession"] }, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
    const bodies = evidence.packet.evidence.related.map((r) => r.code);
    assert.ok(bodies.some((c) => c.includes("function rejectDisabledUsers")), "the third middleware on the route");
    assert.ok(bodies.some((c) => c.includes("function assertActive")), "the guard helper the path calls");
    assert.equal(evidence.truncated, false);
    assert.equal(withoutStrings('router.post("/login/parseBody", x)'), 'router.post("", x)');
  } finally {
    repo.remove();
  }
});

test("a name defined twice makes its callers' context unreliable, and the evidence counts as cut", async () => {
  const repo = tempRepo();
  try {
    repo.write({
      "src/a/login.ts": "export function login(q) {\n  return createSession(q);\n}\n",
      "src/b/login.ts": "export function login(q) {\n  return createSession(q);\n}\n",
      "src/routes.ts": "router.post('/a', rejectDisabledUsers, login);\n",
    });
    const sha = repo.commit("files");
    const git = await Git.open(repo.dir);
    const d = new Discoverer(git, sha, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
    const requirement = { id: "R1", text: "Disabled users cannot sign in.", kind: "behavior" as const, priority: "required" as const, sourceRefs: [], searchHints: [] };
    const evidence = await buildEvidence(d, requirement, { path: "src/b/login.ts", startLine: 1, endLine: 3, symbol: "login", changed: false, reasons: [] }, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
    assert.equal(evidence.truncated, true);
  } finally {
    repo.remove();
  }
});

test("a file excluded by name is not read, whichever way its path arrived", async () => {
  // `redact.ts` states it: files are excluded by name before they are read. That held because
  // every path reaching `index` had come through `search`, which filters. A path can now arrive
  // from the diff instead, filtered by the configuration's include list alone.
  const repo = tempRepo();
  try {
    repo.write({ "src/a.rs": "pub fn run() {\n    go();\n}\n", "secrets.rs": "pub fn key() -> &'static str {\n    \"x\"\n}\n" });
    const sha = repo.commit("one ordinary file and one named like a secret");
    const git = await Git.open(repo.dir);
    const d = new Discoverer(git, sha, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
    assert.notEqual(await d.index("src/a.rs"), null, "an ordinary file is read");
    assert.equal(await d.index("secrets.rs"), null, "a file excluded by name is not, even asked for directly");
    assert.equal((await git.readText(sha, "secrets.rs")) !== null, true, "and it is there to be read — the refusal is the name rule, not a missing file");
  } finally {
    repo.remove();
  }
});

test("a second definition inside a test region does not make the evidence ambiguous", async () => {
  // Rust and Zig keep their tests in the files they test. Counting a `deinit` written in one as
  // another definition of the production name voided the answers about the production path; on
  // ten real pull requests the same-name flag was firing on a fifth of the places judged.
  const repo = tempRepo();
  try {
    repo.write({
      "src/a.rs": "pub fn deinit(x: u8) {\n    free(x);\n}\n",
      "src/caller.rs": "fn run() {\n    deinit(1);\n}\n",
      "src/b.rs": "#[cfg(test)]\nmod tests {\n    fn deinit() {}\n\n    #[test]\n    fn works() { deinit(); }\n}\n",
    });
    const sha = repo.commit("files");
    const git = await Git.open(repo.dir);
    const d = new Discoverer(git, sha, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
    const requirement = { id: "R1", text: "Everything freed is freed once.", kind: "behavior" as const, priority: "required" as const, sourceRefs: [], searchHints: [] };
    const candidate = { path: "src/a.rs", startLine: 1, endLine: 3, symbol: "deinit", changed: false, reasons: [] };
    const evidence = await buildEvidence(d, requirement, candidate, { maxPrimaryChars: 8000, maxRelatedChars: 4000 });
    assert.equal(evidence.cut.ambiguous, false, JSON.stringify(evidence.packet.evidence.related));

    // Two definitions outside a test region are ambiguous wherever they sit — including in the
    // candidate's own file, where `remote.check(user)` beside a local `check(user)` would
    // otherwise hand over the local one's guard for a call that never reaches it.
    repo.write({ "src/same.rs": "pub fn check(u: u8) {\n    deny(u);\n}\n\npub fn call_it(u: u8) {\n    remote.check(u);\n}\n", "src/remote.rs": "pub fn check(u: u8) {\n    allow(u);\n}\n" });
    const both = repo.commit("two definitions, one of them local");
    const d3 = new Discoverer(git, both, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
    const local = { path: "src/same.rs", startLine: 5, endLine: 7, symbol: "call_it", changed: false, reasons: ["calls check"] };
    assert.equal((await buildEvidence(d3, requirement, local, { maxPrimaryChars: 8000, maxRelatedChars: 4000 })).cut.ambiguous, true);

    // A second definition outside a test region still does, as before.
    repo.write({ "src/c.rs": "pub fn deinit(y: u8) {\n    drop(y);\n}\n" });
    const two = repo.commit("a second real definition");
    const d2 = new Discoverer(git, two, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
    assert.equal((await buildEvidence(d2, requirement, candidate, { maxPrimaryChars: 8000, maxRelatedChars: 4000 })).cut.ambiguous, true);
  } finally {
    repo.remove();
  }
});

test("evidence is redacted before it is cut, and a cut is reported", async () => {
  const repo = tempRepo();
  try {
    const key = `AKIA${"Q".repeat(16)}`;
    repo.write({ "src/a.ts": `export function charge() {\n  const k = "${key}";\n  pay(k);\n${"  step();\n".repeat(400)}}\n` });
    const base = repo.commit("base");
    repo.write({ "src/b.ts": "export function other() {\n  pay(1);\n}\n" });
    const head = repo.commit("head");
    const git = await Git.open(repo.dir);
    const d = new Discoverer(git, head, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
    const candidate = { path: "src/a.ts", startLine: 1, endLine: 404, symbol: "charge", changed: false, reasons: [] };
    const requirement = { id: "R1", text: "Every payment is logged first.", kind: "behavior" as const, priority: "required" as const, sourceRefs: [], searchHints: [] };
    const evidence = await buildEvidence(d, requirement, candidate, { maxPrimaryChars: 600, maxRelatedChars: 0 });
    assert.ok(!JSON.stringify(evidence.packet).includes(key));
    assert.ok(evidence.packet.evidence.code.includes("[REDACTED AWS KEY]"));
    assert.equal(evidence.redactions, 1);
    assert.equal(evidence.truncated, true);
    assert.ok(evidence.packet.evidence.code.length <= 600);
    void base;
  } finally {
    repo.remove();
  }
});

test("redact replaces secret shapes and keeps the names around them", () => {
  const samples = [
    `const k = "AKIA${"A".repeat(16)}";`,
    `token: "${"ghp_"}${"x".repeat(36)}"`,
    `password = "hunter2hunter2"`,
    `-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----`,
    `blob = "${"Zm9v".repeat(20)}"`,
  ];
  for (const sample of samples) {
    const { text, count } = redact(sample);
    assert.ok(count >= 1, sample);
    assert.match(text, /REDACTED/);
  }
  assert.equal(redact(`password = "hunter2hunter2"`).text, `password = "[REDACTED]"`);
  assert.deepEqual(redact("const createSession = () => 1;"), { text: "const createSession = () => 1;", count: 0 });
});

test("sensitive paths are recognised case-insensitively anywhere in the tree", () => {
  for (const path of [".env", "config/.env.production", "deploy/key.PEM", "infra/prod.tfvars", "home/.npmrc", "id_ed25519", "gcp/my-serviceAccount.json"]) assert.ok(isSensitivePath(path), path);
  for (const path of ["src/env.ts", "docs/keys.md", "src/tfvars.ts"]) assert.ok(!isSensitivePath(path), path);
});

test("cut keeps the head and the tail within the limit", () => {
  const { text, truncated } = cut("a".repeat(1000) + "TAIL", 200);
  assert.equal(truncated, true);
  assert.ok(text.length <= 200 && text.endsWith("TAIL") && text.startsWith("aaa"));
  assert.deepEqual(cut("short", 200), { text: "short", truncated: false });
});

// Every way discovery or evidence can stop short has to say so: a silent cut is a false VERIFIED.

async function changed(base: Record<string, string>, head: Record<string, string>, options: { lexicalSearch?: boolean; referenceSearch?: boolean } = {}) {
  const repo = tempRepo();
  repo.write(base);
  const from = repo.commit("base");
  repo.write(head);
  const to = repo.commit("head");
  const git = await Git.open(repo.dir);
  const change = await analyzeChange(git, from, to, () => true);
  const discoverer = new Discoverer(git, to, { include: () => true, maxCandidates: 30, lexicalSearch: options.lexicalSearch ?? false, referenceSearch: options.referenceSearch ?? true });
  return { repo, change, discoverer };
}

const requirement = (extra: Partial<Requirement> = {}): Requirement => ({ id: "R1", text: "Disabled users cannot sign in.", kind: "behavior", priority: "required", sourceRefs: [], searchHints: [], ...extra });
const fn = (name: string, body = "return x;") => `export function ${name}(x) {\n  ${body}\n}\n`;
const calling = (names: string[]) => `export function handler(x) {\n${names.map((n) => `  ${n}(x);`).join("\n")}\n  return x;\n}\n`;

test("more calls in the changed code than are followed makes discovery incomplete; calls only tests make do not take a place", async () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `helper${i}`);
  const lib = (n: number) => names(n).map((name) => fn(name)).join("");
  const run = async (n: number, extra: Record<string, string> = {}) => {
    const { repo, change, discoverer } = await changed({ "src/lib.ts": lib(n), "src/api.ts": calling([]) }, { "src/api.ts": calling(names(n)), ...extra });
    try {
      return await discoverer.discover(requirement(), change);
    } finally {
      repo.remove();
    }
  };
  const ten = await run(10);
  assert.ok(left(ten).some((r) => /only the 8 least common of 10 calls/.test(r)), JSON.stringify(left(ten)));
  assert.equal(ten.searches.filter((s) => /not followed: only the 8/.test(s.rejected ?? "")).length, 2);
  assert.deepEqual(left(await run(8)), [], "eight calls are all followed");

  // A test the pull request adds calls a helper only tests use: it has no caller that could be a
  // path, and must not push one of the eight real calls out.
  const withTest = await run(8, { "test/helpers.ts": fn("expectLogin"), "test/login.test.ts": "test(\"login\", () => {\n  expectLogin(1);\n});\n" });
  assert.deepEqual(left(withTest), [], JSON.stringify(left(withTest)));
  assert.equal(withTest.searches.find((s) => s.query === "expectLogin")?.rejected, "used only in tests");
});

const LONG = `a${"b".repeat(80)}`;

test("a call is followed by its name however it is written: three letters, a method named like a keyword, a function named like an error", async () => {
  const { repo, change, discoverer } = await changed(
    { "src/pay.ts": fn("pay") + fn("WriteError"), "src/other.ts": fn("other", "pay(x);\n  sessions.delete(x);\n  return WriteError(null, x);"), "src/api.ts": fn("checkout") },
    { "src/api.ts": fn("checkout", `pay(x);\n  sessions.delete(x.id);\n  ${LONG}(x);\n  if (!x.ok) throw new AuthError('no');\n  return WriteError(null, x);`) },
  );
  try {
    const found = await discoverer.discover(requirement(), change);
    const record = (q: string) => found.searches.find((s) => s.query === q && s.layer === "C");
    for (const name of ["pay", "delete", "WriteError"]) assert.ok(record(name) && !record(name)?.rejected, `${name}: ${JSON.stringify(record(name))}`);
    assert.match(record("AuthError")?.rejected ?? "", /an error type/, "made with throw new: how the guard stops a path");
    assert.ok(found.candidates.some((c) => c.symbol === "other"));
    // A name the search refuses leaves its callers unsearched, and that is said.
    assert.ok(left(found).includes(`the callers of ${LONG} could not be searched (longer than 80 characters)`), JSON.stringify(left(found)));
  } finally {
    repo.remove();
  }
});

test("a secret-shaped word on a changed line is not searched and not written into the search records", async () => {
  const key = `AKIA${"Q".repeat(16)}`;
  const { repo, change, discoverer } = await changed({ "src/api.ts": fn("handler") }, { "src/api.ts": fn("handler", `const k = "${key}";\n  return disabledAt(k);`) }, { lexicalSearch: true, referenceSearch: false });
  try {
    const found = await discoverer.discover(requirement(), change);
    assert.ok(!JSON.stringify(found).includes(key));
    assert.ok(found.searches.some((s) => s.query === "[REDACTED]" && s.rejected === "shaped like a secret"));
    assert.ok(found.searches.some((s) => s.query === "handler" || s.query === "disabled"), "other words are still searched");
  } finally {
    repo.remove();
  }
});

test("more search words than are searched, or a word too common to narrow anything, makes discovery incomplete", async () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `keyword${i}`);
  const run = async (hints: string[], files: Record<string, string> = {}) => {
    const { repo, change, discoverer } = await changed({ "src/api.ts": fn("handler"), ...files }, { "src/api.ts": fn("handler", "check(x);\n  return x;") }, { lexicalSearch: true, referenceSearch: false });
    try {
      return await discoverer.discover(requirement({ searchHints: hints }), change);
    } finally {
      repo.remove();
    }
  };
  const nine = await run(words(9));
  assert.ok(left(nine).includes("only the first 8 search words were searched"), JSON.stringify(left(nine)));
  assert.match(nine.searches.find((s) => s.query === "keyword8")?.rejected ?? "", /only the first 8/);
  assert.ok(!left(await run(words(8))).some((r) => /search words/.test(r)), "eight words are all searched");

  const everywhere = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`src/m${i}.ts`, fn(`m${i}`, "return sharedword;")]));
  const common = await run(["sharedword"], everywhere);
  assert.ok(left(common).includes("the word sharedword is too common to search by"), JSON.stringify(left(common)));
  assert.ok(!left(await run(["sharedword"], Object.fromEntries(Object.entries(everywhere).slice(0, 40)))).some((r) => /sharedword/.test(r)), "forty files are not too common");
});

test("the callers of a wrapper: a three-letter name is searched, too many or too common makes discovery incomplete", async () => {
  const run = async (wrapper: string, callers: number, limit: number) => {
    const files = Object.fromEntries(Array.from({ length: callers }, (_, i) => [`src/c${i}.ts`, fn(`c${i}`, `return ${wrapper}(x);`)]));
    const { repo, change, discoverer } = await changed({ "src/w.ts": fn(wrapper, "return createSession(x);"), ...files }, { "src/api.ts": fn("login", "return createSession(x);") });
    try {
      const candidate = { path: "src/w.ts", startLine: 1, endLine: 3, symbol: wrapper, changed: false, reasons: ["calls createSession"] };
      return await discoverer.callersOf(candidate, requirement(), change, new Set(), limit);
    } finally {
      repo.remove();
    }
  };
  const short = await run("pay", 1, 30);
  assert.deepEqual([short.candidates.map((c) => c.symbol), left(short)], [["c0"], []]);
  const over = await run("openSession", 3, 1);
  assert.equal(over.candidates.length, 1);
  assert.ok(left(over).includes("3 callers of openSession were found and only 1 were judged"), JSON.stringify(left(over)));
  const common = await run("openSession", 41, 100);
  assert.deepEqual(common.candidates, []);
  assert.ok(left(common).some((r) => /callers of openSession, judged supporting code, were not followed \(too common\)/.test(r)), JSON.stringify(left(common)));
});

test("evidence counts as cut when callers, definitions or a definition's size go past what a packet holds", async () => {
  const build = async (files: Record<string, string>, candidate: { path: string; symbol: string; endLine: number }, maxRelatedChars = 4000) => {
    const repo = tempRepo();
    try {
      repo.write(files);
      const sha = repo.commit("files");
      const d = new Discoverer(await Git.open(repo.dir), sha, { include: () => true, maxCandidates: 30, lexicalSearch: true, referenceSearch: true });
      return await buildEvidence(d, requirement(), { ...candidate, startLine: 1, changed: false, reasons: [] }, { maxPrimaryChars: 8000, maxRelatedChars });
    } finally {
      repo.remove();
    }
  };
  const target = { path: "src/target.ts", symbol: "target", endLine: 3 };
  const callers = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/c${i}.ts`, fn(`caller${i}`, "return target(x);")]));
  assert.equal((await build({ "src/target.ts": fn("target"), ...callers(6) }, target)).truncated, false, "six callers fit");
  assert.equal((await build({ "src/target.ts": fn("target"), ...callers(7) }, target)).truncated, true, "the seventh is not in the packet");

  const helpers = (n: number) => Array.from({ length: n }, (_, i) => `guard${i}`);
  const calls = (n: number) => ({ "src/target.ts": calling(helpers(n)).replace("handler", "target"), "src/guards.ts": helpers(n).map((h) => fn(h)).join("") });
  const withCalls = (n: number) => ({ ...target, endLine: n + 3 });
  assert.equal((await build(calls(8), withCalls(8))).truncated, false, "eight definitions fit");
  assert.equal((await build(calls(9), withCalls(9))).truncated, true, "the ninth is not in the packet");

  const big = { "src/target.ts": fn("target", "return bigHelper(x);"), "src/big.ts": fn("bigHelper", `return "${"word ".repeat(1000)}";`) };
  assert.equal((await build(big, target, 8000)).truncated, false, "the helper fits in 8000 characters");
  assert.equal((await build(big, target, 4000)).truncated, true, "and does not in 4000: the guard could be in it");

  // Longer than a block can be (300 lines): no body to send, so the evidence is cut all the same.
  const long = (n: number) => ({ "src/target.ts": fn("target", "return longHelper(x);"), "src/long.ts": fn("longHelper", "x += 1;\n  ".repeat(n) + "return x;") });
  assert.equal((await build(long(20), target, 40000)).truncated, false, "a 20-line helper is sent whole");
  assert.equal((await build(long(320), target, 40000)).truncated, true, "a 320-line helper is not sent");
});
