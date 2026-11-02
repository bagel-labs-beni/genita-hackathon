import { turn, tick } from "./helpers/emptyReplies.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import { MemoryService } from "../src/memory/service.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";

/** Seeded fake Spark timings: reproducible across before/after runs. */
export async function stress(turns = 2400) {
  let seed = 0x243;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const kinds = ["normal", "empty", "whitespace_lane", "whitespace_all", "short_yes", "short_okay", "audio_tag", "emotion_tag", "incomplete", "tool_only", "failed", "spec_empty", "tool_followup", "tool_followup_empty", "tool_followup_failed", "permanent_empty", "permanent_tags"];
  const counts: Record<string, { turns: number; empty: number; errors: number }> = {};
  let emptyReplies = 0, unavailable = 0, missing = 0, unexpectedErrors = 0;
  for (let i = 0; i < turns; i++) {
    const kind = kinds[(random() >>> 16) % kinds.length];
    const delays = [random() % 4, random() % 4, random() % 4];
    const splits = [random(), random(), random(), random()];
    const usesMemory = kind.startsWith("tool_followup");
    const repo = usesMemory ? new InMemoryMemoryRepository() : null;
    const memory = repo ? new MemoryService({ repository: repo, state: repo, extract: async () => [] }) : undefined;
    let calls = 0, followups = 0;
    const { events } = await turn({ ...(memory ? { memory, userId: "fake", priorTurns: () => [{ role: "assistant" as const, text: "Earlier." }] } : {}),
      async *spark(req, { signal }): AsyncGenerator<SparkStreamEvent> {
        const lane = calls++;
        for (let j = 0; j < delays[lane % 3]; j++) await tick();
        if (signal?.aborted) return;
        const followup = usesMemory && Array.isArray(req.input) && req.input.some((e) => "type" in e && e.type === "function_call_output");
        const retry = usesMemory ? followup && followups >= 3 : lane >= 3;
        let text = "<warm> Here I am.";
        if (usesMemory) {
          if (!followup) {
            text = "";
            // Empty lane closes before two lanes that request a real tool follow-up.
            if (lane % 3 !== 0 || lane >= 6) yield { type: "function_call", name: "recall", call_id: "fake", arguments: '{"query":"earlier"}' };
          } else {
            followups++;
            if (!retry && kind === "tool_followup_empty") text = "";
            if (!retry && kind === "tool_followup_failed") throw new Error("fake failed follow-up");
          }
        } else if (!retry || kind.startsWith("permanent_")) {
          if (["empty", "incomplete", "tool_only", "spec_empty", "permanent_empty"].includes(kind)) text = "";
          if (kind === "whitespace_all" || (kind === "whitespace_lane" && lane === 0)) text = " \n";
          if (kind === "audio_tag" || kind === "permanent_tags") text = "[laughs]";
          if (kind === "emotion_tag") text = "<happy>";
          if (kind === "short_yes") text = "Yes!";
          if (kind === "short_okay") text = "Okay.";
          if (kind === "failed") throw new Error("fake upstream failure");
          if (kind === "tool_only") yield { type: "function_call", name: "recall", call_id: "fake", arguments: '{}' };
        }
        if (text) {
          const split = 1 + splits[lane % 4] % text.length;
          yield { type: "text", delta: text.slice(0, split) };
          await tick();
          if (signal?.aborted) return;
          yield { type: "text", delta: text.slice(split) };
        }
        yield { type: "done", responseId: "fake", text, status: kind === "incomplete" ? "incomplete" : "completed" };
      } }, { history: "Yes! Okay, last time.", speculative: kind === "spec_empty" });
    await memory?.drain();
    const replies = events.filter((e) => e.type === "reply");
    const empty = replies.filter((e) => !e.text.trim()).length;
    const error = events.some((e) => e.type === "error" && e.code === "spark_unavailable");
    emptyReplies += empty; unavailable += Number(error);
    if (error !== kind.startsWith("permanent_")) unexpectedErrors++;
    if (!replies.length && !error) missing++;
    const c = counts[kind] ??= { turns: 0, empty: 0, errors: 0 };
    c.turns++; c.empty += empty; c.errors += Number(error);
  }
  return { turns, seed: "0x243", emptyReplies, unavailable, unexpectedErrors, missing, counts };
}

if (process.argv[1]?.endsWith("empty-reply-stress.ts")) {
  const result = await stress(Number(process.argv[2] ?? 2400));
  console.log(JSON.stringify(result));
  if (result.emptyReplies || result.missing || result.unexpectedErrors) process.exitCode = 1;
}
