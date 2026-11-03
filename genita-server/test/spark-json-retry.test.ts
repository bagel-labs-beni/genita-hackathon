/** 11/3 outage: json_schema calls 504'd; sparkJson retries once after a short pause (5xx / dropped), never a 4xx. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sparkJson } from "../src/meta/spark.ts";

const REQ = { model: "m", instructions: "x", input: "y", schemaName: "s", schema: { type: "object" } } as unknown as Parameters<typeof sparkJson>[1];
const ok = () => new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: '{"a":1}' }] }] }), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status: number) => new Response('{"error":{"message":"request timed out"}}', { status });

test("sparkJson: a 504 is retried once after a pause, then the answer is used", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const at: number[] = [];
  globalThis.fetch = (async () => { at.push(performance.now()); return at.length === 1 ? fail(504) : ok(); }) as typeof fetch;
  assert.deepEqual(await sparkJson<{ a: number }>("k", REQ), { a: 1 });
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= 500, `paused ${Math.round(at[1] - at[0])} ms`);
});

test("sparkJson: two 504s throw (the caller fails quietly and reprocesses); a 400 is not retried", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  let n = 0;
  globalThis.fetch = (async () => { n++; return fail(504); }) as typeof fetch;
  await assert.rejects(sparkJson("k", REQ), /504/);
  assert.equal(n, 2);
  n = 0;
  globalThis.fetch = (async () => { n++; return fail(400); }) as typeof fetch;
  await assert.rejects(sparkJson("k", REQ), /400/);
  assert.equal(n, 1);
});
