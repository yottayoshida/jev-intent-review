import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeChange } from "../src/change/seeds.ts";
import { ProviderError } from "../src/judgments/cloudflare.ts";
import { Git } from "../src/repository/git.ts";
import { isSensitivePath } from "../src/evidence/redact.ts";
import { changesBehaviour, reviewChanges } from "../src/review/unexpected-change.ts";
import { validateIntentSpec } from "../src/intent/schema.ts";
import type { Requirement } from "../src/types.ts";
import { answer, ScriptedProvider } from "./helpers/fakes.ts";
import { FIXTURES, fixtureRepo, tempRepo } from "./helpers/repo.ts";

function requirementsOf(name: string): Requirement[] {
  const spec = JSON.parse(readFileSync(join(FIXTURES, name, "fixture.json"), "utf8")).spec as unknown;
  return validateIntentSpec(spec, name).requirements;
}

async function changeOf(name: string) {
  const repo = fixtureRepo(name);
  const git = await Git.open(repo.dir);
  const change = await analyzeChange(git, repo.base, repo.head, () => true);
  return { repo, change };
}

/** Answers by what the change's own lines say, as the real model does from the excerpt. */
function scripted(unrelated: RegExp, confidence = 0.9): ScriptedProvider {
  return new ScriptedProvider((state) => {
    const lines = `${(state as { change?: { before?: string; after?: string } }).change?.before ?? ""}\n${(state as { change?: { after?: string } }).change?.after ?? ""}`;
    return { justification: answer(unrelated.test(lines) ? "unrelated" : "clearly_required", confidence) };
  });
}

test("a comment, a blank line or an import is not a change in behaviour, and is never asked about", async () => {
  const { repo, change } = await changeOf("scope-creep");
  try {
    const judged = change.regions.filter(changesBehaviour).map((r) => r.path);
    assert.ok(judged.includes("src/auth/exchange.ts"));
    assert.ok(judged.includes("src/session/store.ts"));
    assert.ok(!judged.includes("src/auth/oauth.ts"), "the only change there is a comment");

    const provider = scripted(/SESSION_TTL/);
    const review = await reviewChanges({ change, requirements: requirementsOf("scope-creep"), provider, maxChars: 4000, threshold: 0.7, trace: () => {} });
    assert.equal(review.sent.length, judged.length, "one question per region that carries behaviour");
    assert.ok(review.notes.some((n) => /hold no change in behaviour/.test(n)), review.notes.join(" | "));
  } finally {
    repo.remove();
  }
});

// The plan's check for this direction: the session lifetime is not asked for, the retry is.
test("scope-creep: the change no requirement asked for is reported, and the one it asked for is not", async () => {
  const { repo, change } = await changeOf("scope-creep");
  try {
    const review = await reviewChanges({ change, requirements: requirementsOf("scope-creep"), provider: scripted(/SESSION_TTL/), maxChars: 4000, threshold: 0.7, trace: () => {} });
    assert.deepEqual(review.unexpected.map((u) => u.location.path), ["src/session/store.ts"]);
    const reported = review.unexpected[0]!;
    assert.equal(reported.judgment, "unrequested");
    assert.deepEqual(reported.mappedRequirements, [], "which requirement would have asked for it is not guessed");
    // The lines themselves, not a sentence about them.
    assert.match(reported.excerpt, /^- .*24 \* 60 \* 60/m);
    assert.match(reported.excerpt, /^\+ .*60 \* 60/m);
    assert.ok(review.notes.some((n) => /judged and are not shown/.test(n)), review.notes.join(" | "));
  } finally {
    repo.remove();
  }
});

test("an unasked-for change Jev is not sure about is counted, not accused", async () => {
  const { repo, change } = await changeOf("scope-creep");
  try {
    const unsure = await reviewChanges({ change, requirements: requirementsOf("scope-creep"), provider: scripted(/SESSION_TTL/, 0.69), maxChars: 4000, threshold: 0.7, trace: () => {} });
    assert.deepEqual(unsure.unexpected, []);
    assert.ok(unsure.notes.some((n) => /judged and are not shown/.test(n)));

    const sure = await reviewChanges({ change, requirements: requirementsOf("scope-creep"), provider: scripted(/SESSION_TTL/, 0.7), maxChars: 4000, threshold: 0.7, trace: () => {} });
    assert.equal(sure.unexpected.length, 1, "at the bar itself it is reported");
  } finally {
    repo.remove();
  }
});

test("the lines a changed file held before are never sent from a path that is never read", async () => {
  const repo = tempRepo();
  try {
    repo.write({ "src/secrets.ts": "export const dbPassword = 'hunter2';\n", "src/app.ts": "export function start() {\n  return 1;\n}\n" });
    const base = repo.commit("base");
    // A pull request that takes the key out: its old lines are what the reverse pass would send.
    repo.write({ "src/secrets.ts": "export const dbPassword = process.env.DB_PASSWORD;\n", "src/app.ts": "export function start() {\n  return 2;\n}\n" });
    const head = repo.commit("head");
    const git = await Git.open(repo.dir);

    // What `runReview` builds: a sensitive path is not part of the change at all.
    const filtered = await analyzeChange(git, base, head, (path) => !isSensitivePath(path));
    assert.deepEqual(filtered.regions.map((r) => r.path), ["src/app.ts"]);

    // And if a caller hands them over anyway, this pass still refuses to send them.
    const unfiltered = await analyzeChange(git, base, head, () => true);
    assert.ok(unfiltered.regions.some((r) => r.path === "src/secrets.ts"), "the region exists without the filter");
    const asked: unknown[] = [];
    const provider = new ScriptedProvider((state) => {
      asked.push(state);
      return { justification: answer("unrelated", 0.9) };
    });
    const review = await reviewChanges({ change: unfiltered, requirements: [], provider, maxChars: 4000, threshold: 0.7, trace: () => {} });
    assert.ok(!JSON.stringify(asked).includes("hunter2"), "nothing about that file was sent");
    assert.ok(!JSON.stringify(review).includes("hunter2"), "and nothing about it is reported");
    assert.deepEqual(review.sent.map((l) => l.path), ["src/app.ts"]);
  } finally {
    repo.remove();
  }
});

test("a marker needs its delimiter: a directive, an attribute, a decrement and a scope are behaviour", async () => {
  const repo = tempRepo();
  try {
    const files = {
      "src/limits.c": "#define MAX_RETRIES 3\nint retries(void) { return MAX_RETRIES; }\n",
      "src/wire.rs": "pub struct Row {\n    #[serde(skip)]\n    pub id: u32,\n}\n",
      "src/count.c": "void tick(int *out) {\n  int count = 2;\n  --count;\n  *out = count;\n}\n",
      "src/scope.cs": "class A {\n  void Read() {\n    using (var file = Open()) { file.Read(); }\n  }\n}\n",
      "src/notes.ts": "// one\nexport function keep() {\n  return 1;\n}\n",
    };
    repo.write(files);
    const base = repo.commit("base");
    repo.write({
      "src/limits.c": files["src/limits.c"].replace("3", "300"),
      "src/wire.rs": files["src/wire.rs"].replace("#[serde(skip)]", "#[serde(skip_serializing)]"),
      "src/count.c": files["src/count.c"].replace("--count;", "--count;\n  --count;"),
      "src/scope.cs": files["src/scope.cs"].replace("Open()", "Open(true)"),
      "src/notes.ts": files["src/notes.ts"].replace("// one", "// one, now with more words"),
    });
    const head = repo.commit("head");
    const git = await Git.open(repo.dir);
    const change = await analyzeChange(git, base, head, () => true);
    const judged = new Set(change.regions.filter(changesBehaviour).map((r) => r.path));
    for (const path of ["src/limits.c", "src/wire.rs", "src/count.c", "src/scope.cs"]) assert.ok(judged.has(path), `${path} changes behaviour`);
    assert.ok(!judged.has("src/notes.ts"), "a comment with its space is still a comment");
  } finally {
    repo.remove();
  }
});

test("a failure that makes every later request pointless ends the run instead of becoming a note", async () => {
  const { repo, change } = await changeOf("scope-creep");
  try {
    for (const kind of ["auth", "payment", "endpoint"] as const) {
      const refusing = new ScriptedProvider(() => {
        throw new ProviderError(kind, `${kind} from the endpoint`);
      });
      await assert.rejects(
        reviewChanges({ change, requirements: requirementsOf("scope-creep"), provider: refusing, maxChars: 4000, threshold: 0.7, trace: () => {} }),
        (e: unknown) => e instanceof ProviderError && e.kind === kind,
        kind,
      );
    }

    // A fault in this tool is not an answer either: it is not swallowed as a note.
    const broken = new ScriptedProvider(() => {
      throw new TypeError("a bug in the tool");
    });
    await assert.rejects(reviewChanges({ change, requirements: requirementsOf("scope-creep"), provider: broken, maxChars: 4000, threshold: 0.7, trace: () => {} }), TypeError);
  } finally {
    repo.remove();
  }
});

test("a secret-shaped value in a change is redacted, and counted once for the one packet it was in", async () => {
  const repo = tempRepo();
  try {
    const key = `AKIA${"Q".repeat(16)}`;
    repo.write({ "src/keys.ts": "export function client() {\n  return connect('old');\n}\n" });
    const base = repo.commit("base");
    repo.write({ "src/keys.ts": `export function client() {\n  return connect('${key}');\n}\n` });
    const head = repo.commit("head");
    const git = await Git.open(repo.dir);
    const change = await analyzeChange(git, base, head, () => true);
    const asked: unknown[] = [];
    const provider = new ScriptedProvider((state) => {
      asked.push(state);
      return { justification: answer("unrelated", 0.9) };
    });
    const review = await reviewChanges({ change, requirements: [], provider, maxChars: 4000, threshold: 0.7, trace: () => {} });
    assert.ok(!JSON.stringify(asked).includes(key), "the key never goes to the endpoint");
    assert.ok(!JSON.stringify(review.unexpected).includes(key), "nor into the report");
    const counted = review.notes.filter((n) => /secret-shaped/.test(n));
    assert.deepEqual(counted, ["1 secret-shaped value(s) were redacted from the changes before sending."]);
  } finally {
    repo.remove();
  }
});

test("a change the endpoint could not judge is counted once per kind, not once per region", async () => {
  const { repo, change } = await changeOf("scope-creep");
  try {
    const failing = new ScriptedProvider(() => {
      throw new ProviderError("bad_request", "too large");
    });
    const review = await reviewChanges({ change, requirements: requirementsOf("scope-creep"), provider: failing, maxChars: 4000, threshold: 0.7, trace: () => {} });
    assert.deepEqual(review.unexpected, []);
    assert.equal(review.answered, 0);
    assert.ok(review.sent.length >= 2);
    const lines = review.notes.filter((n) => /could not be judged/.test(n));
    assert.equal(lines.length, 1, review.notes.join(" | "));
    assert.match(lines[0]!, /2 change\(s\) could not be judged \(bad_request\)/);
    // The endpoint answered its own way, so the run knows it was reached and read nothing.
    assert.equal(review.reached, review.sent.length);

    // A request the run's own budget refused never left, so it reached nothing.
    const broke = new ScriptedProvider(() => {
      throw new ProviderError("budget", "request limit reached (0)");
    });
    const stopped = await reviewChanges({ change, requirements: requirementsOf("scope-creep"), provider: broke, maxChars: 4000, threshold: 0.7, trace: () => {} });
    assert.equal(stopped.reached, 0);
  } finally {
    repo.remove();
  }
});
