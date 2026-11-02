import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMemory } from "../evals/memory/runner.ts";
test("five offline grocery extraction → new call → Forget fixtures", async () => {
  const results = await evaluateMemory();
  assert.equal(results.length, 5);
  for (const result of results) { assert.equal(result.pass, true, JSON.stringify(result)); assert.equal(result.deletedResurfaced, 0); }
});
