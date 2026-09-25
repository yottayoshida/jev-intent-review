import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallCandidate } from "../src/plan/candidates.ts";
import { checksBefore, EVERYWHERE, wrapperOf } from "../src/plan/decisive.ts";

// The rules that name the code a reading turns on (ADR 0018), on bodies written as the measured
// cases have them. Every rule that holds has a case beside it where it must not.

let n = 0;
const call = (expression: string, line = 1): CallCandidate => ({
  id: `c${n++}`,
  functionId: "f",
  line,
  text: expression,
  callee: expression.slice(0, expression.indexOf("(")),
  expression,
  expressionComplete: true,
});

test("the failure passed to a function before `?` names it; returned first, it does not", () => {
  const target = call("rewrite_heights(grove_version)");
  assert.equal(wrapperOf("step_outcome(self.rewrite_heights(grove_version))?;", target), "step_outcome", "grovedb#500's hidden version");
  assert.equal(wrapperOf("self.rewrite_heights(grove_version)?;", target), null, "the shipped code: `?` first");
  assert.equal(wrapperOf("extend(self.rewrite_heights(grove_version)?);", target), null, "`?` before the function it is passed to");
  assert.equal(wrapperOf("let r = self.rewrite_heights(grove_version);", target), null, "bound, not passed: a statement is not a function");
});

test("the wrapper is read across lines, `.await`, a path, a turbofish and other arguments", () => {
  const target = call("moltis_agents::title::generate_title(provider, &chat_msgs)");
  const split = "let title = settle_step(\n        moltis_agents::title::generate_title(provider, &chat_msgs)\n            .await,\n    )?;";
  assert.equal(wrapperOf(split, target), "settle_step", "moltis#1064's hidden version, split by rustfmt");
  assert.equal(wrapperOf("crate::util::settle::<T>(a, moltis_agents::title::generate_title(provider, &chat_msgs).await)?", target), "settle");
  assert.equal(wrapperOf("moltis_agents::title::generate_title(provider, &chat_msgs)\n    .await?", target), null, "`.await?`: returned first");
});

test("a method, a macro, a keyword, a constructor or a name every repository has is not a wrapper", () => {
  const target = call("parse(x)");
  assert.equal(wrapperOf("items.iter().map(|x| parse(x)).collect::<Result<Vec<_>, _>>()?", target), null, "a method's parenthesis: `.map(`");
  assert.equal(wrapperOf("format!(\"{:?}\", parse(x))", target), null, "a macro");
  assert.equal(wrapperOf("if (parse(x)).is_ok() { }", target), null, "a keyword's parenthesis");
  assert.equal(wrapperOf("Wrapper(parse(x))", target), null, "a tuple struct");
  for (const name of EVERYWHERE) assert.equal(wrapperOf(`${name}(parse(x))`, target), null, name);
  assert.equal(wrapperOf("(a, parse(x))", target), null, "a tuple");
  assert.equal(wrapperOf("log_err(parse(x))", target), "log_err", "and a function that is none of those is");
});

test("a check is a call above the target in a condition whose own name meets the words", () => {
  const target = call("create_session(store, &record)", 9);
  const calls = [call("load_key(store, key)", 2), call("is_disabled(&record)", 3), call("audit(store)", 6), target];
  const meets = (c: CallCandidate) => /disabled|key/.test(c.callee);
  const shipped = "let record = load_key(store, key)?;\n if is_disabled(&record) {\n return Err(AuthError::Disabled);\n }\n audit(store)?;\n let session = create_session(store, &record)?;";
  assert.deepEqual(checksBefore(shipped, target, calls, meets), ["is_disabled"], "`load_key` meets the words but binds its result: a read, not a check");
  const hidden = "let record = load_key(store, key)?;\n reject_disabled(&record)?;\n let session = create_session(store, &record)?;";
  assert.deepEqual(checksBefore(hidden, target, [calls[0]!, call("reject_disabled(&record)", 3), target], meets), ["reject_disabled"], "a `?` statement that binds nothing");
  const after = "let session = create_session(store, &record)?;\n if is_disabled(&record) { }";
  assert.deepEqual(checksBefore(after, target, calls, meets), [], "below the target is not before it");
  assert.deepEqual(checksBefore(shipped, target, calls, () => false), [], "a condition whose name does not meet the words");
});

test("the condition may be a guard, a `while`, a `let … else`; a variant and the target's own name are not checks", () => {
  const target = call("generate_title(provider, &msgs)", 9);
  const meets = () => true;
  const guard = "let h = match store.read(key).await { Ok(h) if has_enough_messages(&h) => h, _ => return Ok(None) }; generate_title(provider, &msgs)";
  assert.deepEqual(checksBefore(guard, target, [call("read(key)"), call("has_enough_messages(&h)"), target], meets), ["read", "has_enough_messages"], "the match's scrutinee and its guard");
  const letElse = "let Some(x) = lookup_title(key) else { return Ok(None) }; generate_title(provider, &msgs)";
  assert.deepEqual(checksBefore(letElse, target, [call("lookup_title(key)"), target], meets), ["lookup_title"]);
  const loop = "while pending_title(key) { } generate_title(provider, &msgs)";
  assert.deepEqual(checksBefore(loop, target, [call("pending_title(key)"), target], meets), ["pending_title"]);
  const variant = "self.x().map_err(|_| Error::ChunkRestoringError(\"restore\".to_string()))?; generate_title(provider, &msgs)";
  assert.deepEqual(checksBefore(variant, target, [call("Error::ChunkRestoringError(\"restore\".to_string())"), target], meets), [], "grovedb#500's variant");
  const again = "generate_title(provider, &old)?; generate_title(provider, &msgs)";
  assert.deepEqual(checksBefore(again, target, [call("generate_title(provider, &old)"), target], meets), [], "the target's own name above it");
});
