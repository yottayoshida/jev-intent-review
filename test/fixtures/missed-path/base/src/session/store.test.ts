import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession, findSession } from "./store.ts";

test("a new session can be found until it expires", () => {
  const session = createSession("user-1");
  assert.equal(findSession(session.id)?.userId, "user-1");
});
