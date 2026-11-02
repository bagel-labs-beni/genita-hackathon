import { test } from "node:test";
import assert from "node:assert/strict";
import { PerceptionController, type PerceptionDeps } from "../src/perception/controller.ts";
import type { Convo } from "../src/perception/rules.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import type { PerceptionTrigger } from "../src/perception/types.ts";

const JPEG = Buffer.from("fake-jpeg-bytes").toString("base64");
const read = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ expression: "neutral", intensity: 0.5, gaze: "at_screen", engagement: 0.7, notable: null, confidence: 0.9, ...o });
const QUIET: Convo = { companionSpeaking: false, lastReplyEndAt: null, userSpeaking: false, lastUserSpeechAt: null };

/** Spark stub: each call waits for `release()`; replies come from `next` */
function harness(opts: Partial<PerceptionDeps> = {}) {
  let clock = 0;
  let convo: Convo = QUIET;
  const calls: SparkRequest[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const waiting: (() => void)[] = [];
  let next: (() => string) = () => read();
  const deps: PerceptionDeps = {
    now: () => clock,
    convo: () => convo,
    log: (event, data) => logs.push({ event, data }),
    async *spark(req: SparkRequest): AsyncGenerator<SparkStreamEvent> {
      calls.push(req);
      await new Promise<void>((r) => waiting.push(r));
      const text = next();
      yield { type: "text", delta: text };
      yield { type: "done", responseId: null, text, status: "completed" };
    },
    ...opts,
  };
  const c = new PerceptionController(deps);
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    c,
    calls,
    logs,
    set: (o: { now?: number; convo?: Convo; next?: () => string }) => {
      if (o.now !== undefined) clock = o.now;
      if (o.convo) convo = o.convo;
      if (o.next) next = o.next;
    },
    /** let the oldest waiting Spark call answer */
    release: async () => {
      await settle();
      waiting.shift()?.();
      await settle();
      await settle();
    },
    settle,
  };
}

test("a frame goes to Spark as a JPEG data URL; the read becomes state and a context line", async () => {
  const h = harness();
  h.c.frame(JPEG);
  await h.settle();
  assert.equal(h.calls.length, 1);
  const parts = (h.calls[0].input as { content: { type: string; image_url?: string }[] }[])[0].content;
  assert.equal(parts.find((p) => p.type === "input_image")!.image_url, `data:image/jpeg;base64,${JPEG}`);
  h.set({ next: () => read({ expression: "smile" }) });
  await h.release();
  assert.equal(h.c.state()!.expression, "smile");
  assert.match(h.c.contextLine()!, /smiling/);
});

test("one Spark call in flight: newer frames replace the waiting one, the latest goes next", async () => {
  const h = harness();
  h.c.frame(JPEG);
  await h.settle();
  for (let i = 1; i <= 3; i++) {
    h.set({ now: i * 1000 });
    h.c.frame(Buffer.from(`frame-${i}`).toString("base64"));
  }
  await h.settle();
  assert.equal(h.calls.length, 1, "no second call while one is in flight");
  await h.release();
  assert.equal(h.calls.length, 2);
  const img = (h.calls[1].input as { content: { type: string; image_url?: string }[] }[])[0].content.find((p) => p.type === "input_image")!.image_url!;
  assert.ok(img.endsWith(Buffer.from("frame-3").toString("base64")));
});

test("frames closer than minGapMs to the last call are dropped when idle", async () => {
  const h = harness({ minGapMs: 1000 });
  h.c.frame(JPEG);
  await h.release();
  h.set({ now: 500 });
  h.c.frame(JPEG);
  await h.settle();
  assert.equal(h.calls.length, 1);
  h.set({ now: 1200 });
  h.c.frame(JPEG);
  await h.settle();
  assert.equal(h.calls.length, 2);
});

test("bad or oversized images never reach Spark", async () => {
  const h = harness();
  h.c.frame("not base64 !!");
  h.c.frame("A".repeat(400_000));
  h.c.frame(42 as unknown as string);
  h.c.frame("data:image/png;base64,AAAA");
  await h.settle();
  assert.equal(h.calls.length, 0);
});

test("a Spark failure or junk reply is logged and changes nothing; the next frame still works", async () => {
  let n = 0;
  const h = harness({
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      n++;
      if (n === 1) throw new Error("upstream 500");
      yield { type: "done", responseId: null, text: n === 2 ? "sorry, no" : read({ expression: "surprised" }), status: "completed" };
    },
  });
  h.c.frame(JPEG);
  await h.settle();
  h.set({ now: 2000 });
  h.c.frame(JPEG);
  await h.settle();
  h.set({ now: 4000 });
  h.c.frame(JPEG);
  await h.settle();
  await h.settle();
  assert.equal(n, 3);
  assert.equal(h.c.state()!.expression, "surprised");
  const samples = h.logs.filter((l) => l.event === "perception.sample").map((l) => l.data.ok);
  assert.deepEqual(samples, [false, false, true]);
});

test("triggers use the conversation as it was when the frame was captured", async () => {
  const h = harness();
  const got: PerceptionTrigger[] = [];
  h.c.onTrigger((t) => got.push(t));
  h.set({ convo: { ...QUIET, companionSpeaking: true }, next: () => read({ expression: "smile", confidence: 0.85 }) });
  h.c.frame(JPEG);
  await h.settle();
  h.set({ convo: QUIET, now: 9000 }); // reply long over by the time Spark answers
  await h.release();
  assert.deepEqual(got.map((t) => [t.kind, t.at]), [["smiled_at_reply", 0]]);
});

test("trigger log has kind and confidence only (no pixels, no notable); unsubscribe stops callbacks", async () => {
  const h = harness();
  const got: string[] = [];
  const off = h.c.onTrigger((t) => got.push(t.kind));
  h.set({ next: () => read({ expression: "laugh", intensity: 0.9, notable: "covering mouth" }) });
  h.c.frame(JPEG);
  await h.release();
  assert.deepEqual(got, ["laughed"]);
  const trig = h.logs.find((l) => l.event === "perception.trigger")!;
  assert.deepEqual(Object.keys(trig.data).sort(), ["confidence", "kind"]);
  assert.doesNotMatch(JSON.stringify(h.logs), /base64|covering|data:image/);
  off();
  h.set({ now: 70_000 });
  h.c.frame(JPEG);
  await h.release();
  assert.deepEqual(got, ["laughed"]);
});

test("pendingHint: the latest trigger's line, consumed once, gone after 15 s", async () => {
  const h = harness();
  h.set({ next: () => read({ expression: "laugh", intensity: 0.9 }) });
  h.c.frame(JPEG);
  await h.release();
  assert.equal(h.c.pendingHint(), "The user just laughed.");
  assert.equal(h.c.pendingHint(), null, "consumed");
  h.set({ now: 70_000 });
  h.c.frame(JPEG);
  await h.release();
  h.set({ now: 86_000 });
  assert.equal(h.c.pendingHint(), null, "expired");
});

test("per-call budget: after maxCalls frames are ignored (logged once)", async () => {
  const h = harness({ maxCalls: 2, minGapMs: 0 });
  for (let i = 0; i < 4; i++) {
    h.set({ now: i * 3000 });
    h.c.frame(JPEG);
    await h.release();
  }
  assert.equal(h.calls.length, 2);
  assert.equal(h.logs.filter((l) => l.event === "perception.budget").length, 1);
});

test("close aborts the call in flight; nothing after close", async () => {
  let aborted = false;
  const h = harness({
    async *spark(_req, opts): AsyncGenerator<SparkStreamEvent> {
      await new Promise<void>((r) => opts.signal?.addEventListener("abort", () => { aborted = true; r(); }, { once: true }));
      yield { type: "done", responseId: null, text: read({ expression: "smile" }), status: "completed" };
    },
  });
  h.c.frame(JPEG);
  await h.settle();
  h.c.close();
  await h.settle();
  assert.ok(aborted);
  assert.equal(h.c.state(), null);
  assert.equal(h.c.contextLine(), null);
});

test("a waiting frame still respects minGapMs after the call in flight ends (Codex P2)", async () => {
  const starts: number[] = [];
  let clock = 0;
  let release: () => void = () => {};
  const c = new PerceptionController({
    now: () => clock,
    convo: () => QUIET,
    minGapMs: 1000,
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      starts.push(clock);
      await new Promise<void>((r) => (release = r));
      yield { type: "done", responseId: null, text: read(), status: "completed" };
    },
  });
  c.frame(JPEG);
  await new Promise((r) => setImmediate(r));
  clock = 100;
  c.frame(JPEG);
  clock = 200;
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(starts, [0], "not right after a 200 ms call");
  clock = 1000;
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(starts, [0, 1000]);
  c.close();
});

test("inactive (interpreting / watching): no new call for a waiting frame, no triggers from a late read (Codex P2)", async () => {
  let active = true;
  const h = harness({ active: () => active });
  const got: string[] = [];
  h.c.onTrigger((t) => got.push(t.kind));
  h.set({ next: () => read({ expression: "laugh", intensity: 0.9 }) });
  h.c.frame(JPEG);
  await h.settle();
  h.set({ now: 2000 });
  h.c.frame(JPEG); // waits
  active = false; // switched to interpretation
  await h.release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.calls.length, 1, "the waiting frame is dropped");
  assert.deepEqual(got, [], "a read that lands while inactive fires nothing");
  h.set({ now: 5000 });
  h.c.frame(JPEG);
  await h.settle();
  assert.equal(h.calls.length, 1, "frames while inactive are ignored");
});
