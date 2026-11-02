import { test } from "node:test";
import assert from "node:assert/strict";
import { SseParser } from "../src/meta/sse.ts";

test("parses event + data pairs split across arbitrary chunk boundaries", () => {
  const p = new SseParser();
  const raw =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hey"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n' +
    "data: [DONE]\n\n";
  const out = [];
  // feed one byte at a time — the worst case for a stream parser
  for (const ch of raw) out.push(...p.feed(ch));
  assert.equal(out.length, 3);
  assert.equal(out[0].event, "response.output_text.delta");
  assert.deepEqual(JSON.parse(out[0].data), { type: "response.output_text.delta", delta: "Hey" });
  assert.equal(out[1].event, "response.completed");
  assert.equal(out[2].data, "[DONE]");
});

test("joins multi-line data fields with newlines and ignores comments", () => {
  const p = new SseParser();
  const out = p.feed(": keepalive\ndata: line one\ndata: line two\n\n");
  assert.equal(out.length, 1);
  assert.equal(out[0].data, "line one\nline two");
  assert.equal(out[0].event, "message");
});

test("handles CRLF line endings", () => {
  const p = new SseParser();
  const out = p.feed('event: x\r\ndata: {"a":1}\r\n\r\n');
  assert.equal(out.length, 1);
  assert.equal(out[0].event, "x");
  assert.equal(out[0].data, '{"a":1}');
});

test("does not emit an event until its blank line arrives", () => {
  const p = new SseParser();
  assert.equal(p.feed('data: {"a":1}\n').length, 0);
  assert.equal(p.feed("\n").length, 1);
});
