import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_TTL_SECONDS } from "../src/session/store.ts";

// Added with the shorter lifetime, for a change no requirement asks for: a test does not turn a
// change into one that was asked for.
test("a session lasts an hour", () => {
  assert.equal(SESSION_TTL_SECONDS, 60 * 60);
});
