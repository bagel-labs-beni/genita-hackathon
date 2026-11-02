import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { OpsLimits } from "../src/ops/limits.ts";
import { turn, tick } from "./helpers/emptyReplies.ts";
import type { SessionDeps } from "../src/session/session.ts";

function toolTurn(memory: MemoryService, ops?: OpsLimits): Partial<SessionDeps> {
  return {
    memory, userId: "fake", ...(ops ? { ops } : {}),
    priorTurns: () => [{ role: "assistant", text: "Earlier." }],
    async *spark(req) {
      const followup = Array.isArray(req.input) && req.input.some((e) => "type" in e && e.type === "function_call_output");
      if (followup) yield { type: "text", delta: "I remember." };
      else {
        await tick();
        yield { type: "function_call", name: "recall", call_id: "recall", arguments: '{"query":"earlier"}' };
      }
      yield { type: "done", responseId: "fake", text: "", status: "completed" };
    },
  };
}

test("tool follow-ups: independent synthetic turns do not share the fake user's daily quota", async () => {
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  try {
    // More than the default 300-turn quota: the stress harness reuses this
    // identity across independent sessions, but each fixture needs fresh limits.
    for (let i = 0; i < 301; i++) {
      const { events } = await turn(toolTurn(memory));
      assert.deepEqual(events.filter((e) => e.type === "error"), [], `turn ${i + 1}`);
      assert.equal(events.find((e) => e.type === "reply")?.text, "I remember.", `turn ${i + 1}`);
      assert.equal(events.filter((e) => e.type === "tool" && e.status === "completed").length, 1);
      await memory.drain();
    }
  } finally { await memory.drain(); }
});

test("tool follow-ups: explicitly shared admission limits still reject an exhausted user before Spark", async () => {
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const ops = new OpsLimits({ userDailyTurns: 1 });
  try {
    const first = await turn(toolTurn(memory, ops));
    assert.equal(first.events.find((e) => e.type === "reply")?.text, "I remember.");
    let calls = 0;
    const second = await turn({ ...toolTurn(memory, ops), async *spark() { calls++; } });
    assert.deepEqual(second.events.filter((e) => e.type === "error"), [
      { type: "error", code: "spark_unavailable", message: "daily_cap:user_turns", retryable: false },
    ]);
    assert.equal(calls, 0);
    assert.ok(!second.events.some((e) => e.type === "reply" || e.type === "say" || e.type === "tool"));
  } finally { await memory.drain(); }
});
