import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import { turn, tick } from "./helpers/emptyReplies.ts";
import { MemoryService } from "../src/memory/service.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";

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

test("twice empty (Spark outage 11/3): the call goes on with one line in character, no error card", async () => {
  let calls = 0;
  const { events, logs } = await turn({ async *spark() { calls++; yield done(); } });
  assert.equal(calls, 4);
  assert.equal(answer(events), "Sorry, I lost you for a sec. Say that again?");
  assert.ok(!events.some((e) => e.type === "error"), "no spark_unavailable card");
  assert.ok(logs.some((l) => l.event === "spark.lost_line" && l.data.cause === "completed_without_text"));
  assert.ok(events.some((e) => e.type === "turn.metrics"), "a normal turn: spoken, measured, the call goes on");
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

for (const speculative of [false, true]) {
  for (const lanes of [1, 3]) {
    for (const failure of ["empty", "tags", "error"]) {
      test(`memory: ${speculative ? "speculative" : "ordinary"}, ${lanes} lanes, ${failure} follow-up retries with saved tool outputs, one write`, async () => {
        const repo = new InMemoryMemoryRepository();
        const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
        let writes = 0, originals = 0;
        const remember = memory.remember.bind(memory);
        memory.remember = async (...args) => { writes++; return remember(...args); };
        const followups: SparkRequest[] = [];
        try {
          const { events, logs } = await turn({ memory, userId: "fake", priorTurns: () => [{ role: "assistant", text: "Earlier." }],
            config: { ...config, sparkHedge: lanes, speculate: speculative },
            async *spark(req): AsyncGenerator<SparkStreamEvent> {
              const followup = Array.isArray(req.input) && req.input.some((e) => "type" in e && e.type === "function_call_output");
              if (!followup) {
                originals++;
                yield { type: "function_call", name: "remember", call_id: `save-${originals}`, arguments: JSON.stringify({ fact: originals === 1 ? "I like spicy food." : "I enjoy spicy food.", kind: "fact" }) };
              } else {
                followups.push(req);
                if (followups.length <= lanes) {
                  if (failure === "error") throw new Error("empty follow-up failed");
                  if (failure === "tags") yield { type: "text", delta: "<warm>" };
                } else yield { type: "text", delta: "Saved that." };
              }
              yield done();
            } }, { speculative });
          assert.equal(answer(events), "Saved that.");
          assert.equal(writes, 1, "paraphrased remember is never executed by the retry");
          assert.equal(originals, lanes, "retry starts from the follow-up, not the user request");
          assert.equal(followups.length, lanes + 1, "retry uses a single lane");
          assert.deepEqual(followups[lanes], followups[0], "retry retains the completed call and saved result");
          const output = Array.isArray(followups[lanes].input) && followups[lanes].input.find((e) => "type" in e && e.type === "function_call_output");
          assert.ok(output && "output" in output && JSON.parse(output.output).saved);
          assert.equal((await memory.list("fake")).length, 1);
          assert.equal(events.filter((e) => e.type === "tool" && e.name === "remember" && e.status === "completed").length, 1);
          assert.equal(logs.filter((l) => l.event === "spark.empty_retry").length, 1);
        } finally { await memory.drain(); }
      });
    }
  }
}

test("memory: a completed remember call wins over a later text-only promise to remember", async () => {
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  let originals = 0, writes = 0, textLaneAborted = false;
  const remember = memory.remember.bind(memory);
  memory.remember = async (...args) => { writes++; return remember(...args); };
  try {
    const { events } = await turn({ memory, userId: "fake", priorTurns: () => [{ role: "assistant", text: "Earlier." }],
      config: { ...config, sparkHedge: 2 },
      async *spark(req, { signal }): AsyncGenerator<SparkStreamEvent> {
        const followup = Array.isArray(req.input) && req.input.some((e) => "type" in e && e.type === "function_call_output");
        if (followup) yield { type: "text", delta: "Saved that." };
        else if (originals++ === 0) yield { type: "function_call", name: "remember", call_id: "save", arguments: '{"fact":"I like spicy food.","kind":"fact"}' };
        else {
          try { await tick(); yield { type: "text", delta: "I'll remember that." }; }
          finally { textLaneAborted = !!signal?.aborted; }
        }
        yield done();
      } });
    assert.equal(answer(events), "Saved that.", "the write lane supplies the follow-up answer");
    assert.equal(writes, 1);
    assert.equal((await memory.list("fake")).length, 1);
    assert.equal(textLaneAborted, true);
  } finally { await memory.drain(); }
});

test("Spark 504 on both tries: a short pause before the retry, then the in-character line (no error card)", async () => {
  let calls = 0;
  const at: number[] = [];
  const { events, logs } = await turn({ async *spark() { calls++; at.push(performance.now()); throw new Error("meta 504: request timed out"); } });
  assert.ok(calls >= 2);
  assert.ok(at.at(-1)! - at[0] >= 350, `paused ${Math.round(at.at(-1)! - at[0])} ms before the retry (hedged lanes start together)`);
  assert.equal(answer(events), "Sorry, I lost you for a sec. Say that again?");
  assert.ok(!events.some((e) => e.type === "error"));
  assert.ok(logs.some((l) => l.event === "spark.lost_line"));
});
