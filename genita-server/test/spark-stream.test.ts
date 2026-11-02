import { test } from "node:test";
import assert from "node:assert/strict";
import { sparkStream, type SparkStreamEvent } from "../src/meta/spark.ts";

const collect = async (source: AsyncIterable<SparkStreamEvent>) => { const events: SparkStreamEvent[] = []; for await (const event of source) events.push(event); return events; };
const message = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });
function response(events: unknown[]) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
}

test("Spark recovers completed output text when no delta arrived, without duplicating streamed text", async (t) => {
  for (const partial of ["", "Yes", "Yes!"]) {
    t.mock.method(globalThis, "fetch", async () => response([
      { type: "response.created", response: { id: "r" } },
      ...(partial ? [{ type: "response.output_text.delta", delta: partial }] : []),
      { type: "response.completed", response: { status: "completed", output: [message("Yes!")] } },
    ]));
    const events = await collect(sparkStream("fake", { input: "hi" }));
    assert.equal(events.filter((e) => e.type === "text").map((e) => e.delta).join(""), "Yes!");
    assert.equal(events.find((e) => e.type === "done")?.text, "Yes!");
    t.mock.restoreAll();
  }
});

test("Spark failed/incomplete/zero output stays distinguishable; metadata/reasoning never becomes text", async (t) => {
  for (const status of ["completed", "incomplete", "failed"]) {
    t.mock.method(globalThis, "fetch", async () => response([
      { type: "response.created", response: { id: "r" } },
      { type: "response.reasoning_text.delta", delta: "private reasoning" },
      { type: `response.${status}`, response: { status, output: [] } },
    ]));
    if (status === "failed") await assert.rejects(collect(sparkStream("fake", { input: "hi" })));
    else {
      const events = await collect(sparkStream("fake", { input: "hi" }));
      assert.deepEqual(events, [{ type: "done", responseId: "r", text: "", status }]);
    }
    t.mock.restoreAll();
  }
});

test("first-event timeout is cleared after partial text, and aborts a stream with only whitespace", async (t) => {
  for (const delta of ["Yes!", " \n"]) {
    t.mock.method(globalThis, "fetch", async (_url: unknown, opts: RequestInit) => {
      const signal = opts.signal!;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`));
        const timer = setTimeout(() => controller.close(), 25);
        signal.addEventListener("abort", () => { clearTimeout(timer); controller.error(signal.reason); }, { once: true });
      } }));
    });
    const events = collect(sparkStream("fake", { input: "hi" }, { firstEventTimeoutMs: 5 }));
    if (delta.trim()) assert.equal((await events).at(-1)?.type, "done");
    else await assert.rejects(events, /timeout/);
    t.mock.restoreAll();
  }
});
