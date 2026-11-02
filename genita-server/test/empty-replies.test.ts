import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import { turn, tick } from "./helpers/emptyReplies.ts";

const done = (status = "completed"): SparkStreamEvent => ({ type: "done", responseId: "r", text: "", status });
const config = { ...loadConfig({ MODEL_API_KEY: "fake" }), serverTts: false, webSearch: false, sparkHedge: 3, speculate: false };
function answer(events: Awaited<ReturnType<typeof turn>>["events"]) {
  return events.find((e) => e.type === "reply")?.text;
}

test("hedge: whitespace cannot beat a slower text lane; loser close cannot end the winner", async () => {
  let calls = 0;
  const { events } = await turn({ async *spark(_req, { signal }) {
    const lane = calls++;
    if (lane === 0) { yield { type: "text", delta: " \n" }; yield done(); return; }
    await tick();
    if (signal?.aborted) return;
    yield { type: "text", delta: "Yes!" };
    await tick();
    yield { type: "text", delta: " Still here." };
    yield done();
  } });
  assert.equal(answer(events), "Yes! Still here.");
  assert.equal(calls, 3, "no safety retry needed");
});

test("hedge: a tool-only lane does not abort lanes producing text", async () => {
  let calls = 0;
  const { events } = await turn({ async *spark() {
    if (calls++ === 0) { yield { type: "function_call", name: "recall", call_id: "c", arguments: '{}' }; yield done(); return; }
    await tick(); yield { type: "text", delta: "Okay." }; yield done();
  } });
  assert.equal(answer(events), "Okay.");
  assert.equal(calls, 3);
});

for (const empty of ["", " \n", "<happy>", "[laughs]"]) {
  test(`empty ${JSON.stringify(empty)}: retry same request once with a single lane`, async () => {
    const requests: SparkRequest[] = [];
    const { events } = await turn({ config: { ...config, webSearch: true }, async *spark(req) {
      requests.push(req);
      const text = requests.length <= 3 ? empty : "Yes!";
      if (text) yield { type: "text", delta: text };
      yield done("incomplete");
    } });
    assert.equal(answer(events), "Yes!");
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[3], requests[0]);
  });
}

for (const text of ["Okay.", "Yes!", "Oh!"]) {
  test(`opener filter preserves the only content: ${text}`, async () => {
    const { events } = await turn({ async *spark() { yield { type: "text", delta: text }; yield done(); } }, { history: `${text} Last time.` });
    assert.equal(answer(events), text);
  });
}

test("twice empty: retryable spark_unavailable with cause, no empty reply or say", async () => {
  let calls = 0;
  const { events, logs } = await turn({ async *spark() { calls++; yield done(); } });
  assert.equal(calls, 4);
  assert.equal(answer(events), undefined);
  assert.ok(events.some((e) => e.type === "error" && e.code === "spark_unavailable" && e.retryable));
  assert.ok(!events.some((e) => e.type === "say"));
  assert.ok(logs.some((l) => l.event === "spark.empty" && l.data.cause === "completed_without_text"));
  assert.equal(events.at(-1)?.type, "state", "turn returns to listening");
});

test("speculation: an already-ended empty hit retries", async () => {
  let calls = 0;
  const { events } = await turn({ config: { ...config, speculate: true, sparkHedge: 1 }, async *spark() {
    if (++calls > 1) yield { type: "text", delta: "Okay." };
    yield done();
  } }, { speculative: true });
  assert.equal(answer(events), "Okay.");
  assert.equal(calls, 2);
});

test("a pre-text upstream failure retries once; partial text is kept without a duplicate retry", async () => {
  let calls = 0;
  const recovered = await turn({ async *spark() {
    if (++calls <= 3) throw new Error("failed");
    yield { type: "text", delta: "Okay." }; yield done();
  } });
  assert.equal(answer(recovered.events), "Okay.");
  assert.equal(calls, 4);
  calls = 0;
  const partial = await turn({ config: { ...config, sparkHedge: 1 }, async *spark() {
    calls++; yield { type: "text", delta: "Yes!" }; throw new Error("failed after text");
  } });
  assert.equal(answer(partial.events), "Yes!");
  assert.equal(calls, 1);
});

test("memory: a completed tool-only fallback beats an empty lane and makes the follow-up request", async () => {
  const { MemoryService } = await import("../src/memory/service.ts");
  const { InMemoryMemoryRepository } = await import("../src/memory/repository.ts");
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  let calls = 0;
  const requests: SparkRequest[] = [];
  try {
    const { events } = await turn({ memory, userId: "fake", priorTurns: () => [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello." }], async *spark(req) {
      requests.push(req);
      const lane = calls++;
      const followup = Array.isArray(req.input) && req.input.some((e) => "type" in e && e.type === "function_call_output");
      if (followup) yield { type: "text", delta: "Yes!" };
      else if (lane > 0) {
        await tick();
        yield { type: "function_call", name: "recall", call_id: "fake", arguments: '{"query":"earlier"}' };
      }
      yield done();
    } });
    assert.equal(answer(events), "Yes!");
    assert.equal(calls, 6, "three original lanes and three follow-up lanes, no retry");
    assert.ok(JSON.stringify(requests[3].input).includes("function_call_output"));
    assert.equal(events.filter((e) => e.type === "tool" && e.name === "recall" && e.status === "completed").length, 1);
  } finally { await memory.drain(); }
});

test("speculation: aborted buffered text is rejected; completed buffered text is reused", async () => {
  for (const abort of [true, false]) {
    let calls = 0;
    const { events } = await turn({ config: { ...config, sparkHedge: 1, speculate: true }, async *spark() {
      yield { type: "text", delta: ++calls === 1 ? "Old answer." : "Fresh answer." }; yield done();
    } }, { speculative: true, beforeFinal(session) {
      if (abort) (session as unknown as { spec: { abort: AbortController } }).spec.abort.abort();
    } });
    assert.equal(answer(events), abort ? "Fresh answer." : "Old answer.");
    assert.equal(calls, abort ? 2 : 1);
  }
});

test("server eager clauses: retain a sole repeated clause, drop it when actual content follows", async () => {
  const voice = loadConfig({ MODEL_API_KEY: "fake", GENITA_VOICE_URL: "https://fake.invalid", GENITA_VOICE_TOKEN: "fake" });
  for (const rest of ["", " that is great!"]) {
    const spoken: string[] = [];
    const { events } = await turn({ config: { ...voice, sparkHedge: 1 }, async *spark() {
      yield { type: "text", delta: "<warm> Oh, " };
      await tick();
      if (rest) yield { type: "text", delta: rest };
      yield done();
    }, async *tts(req) { spoken.push(req.text); yield { audio: Buffer.alloc(96), alignment: null, model: "fake" }; }
    }, { history: "Oh, hi!" });
    assert.equal(answer(events), rest ? "That is great!" : "Oh,");
    assert.deepEqual(spoken, [rest ? "That is great!" : "Oh,"]);
  }
});

test("hedge: tag-only prefixes across deltas cannot beat actual words", async () => {
  for (const tag of ["<happy>", "[laughs]"]) {
    let calls = 0;
    const { events } = await turn({ async *spark() {
      const lane = calls++;
      if (!lane) {
        yield { type: "text", delta: tag.slice(0, 3) };
        yield { type: "text", delta: tag.slice(3) };
      } else {
        await tick();
        yield { type: "text", delta: "Yes!" };
      }
      yield done();
    } });
    assert.equal(answer(events), "Yes!");
    assert.equal(calls, 3, "the real-text lane wins without a retry");
  }
});
