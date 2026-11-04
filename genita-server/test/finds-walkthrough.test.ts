import { test } from "node:test";
import assert from "node:assert/strict";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore, ownerKey } from "../src/finds/store.ts";
import { isNextStep, isWalkAsk, walkPlan } from "../src/finds/walkthrough.ts";
import type { FindCard } from "../src/protocol.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";

const ID = "11111111-aaaa-4bbb-8ccc-000000000001";
function recipe(): FindCard {
  return {
    id: ID, kind: "recipe", createdAt: "2026-11-04T10:00:00Z", eyebrow: "From your camera", title: "Kimchi fried rice", subtitle: "About 15 min",
    items: [
      { id: "i1", name: "Kimchi", tier: "have" },
      { id: "i2", name: "Eggs", tier: "buy" },
      { id: "i3", name: "Rice", tier: "maybe" },
    ] as FindCard["items"],
    steps: [{ text: "Fry the kimchi in oil — maangchi.com" }, { text: "Add the rice and stir." }, { text: "Top with a fried egg." }],
    options: [], why: [], ask: [], sources: [], how: [],
  };
}

test("walkthrough words: the recipe CTA and spoken asks start it; short 'next' lines move on, questions don't", () => {
  for (const t of ["Walk me through it", "walk me through it.", "Can you walk me through the recipe?", "Let's cook it together", "step by step"]) assert.ok(isWalkAsk(t), t);
  for (const t of ["what's a good walk near me", "walk me to the store and buy eggs please now"]) assert.ok(!isWalkAsk(t), t);
  for (const t of ["next", "Next step", "done", "Okay.", "ok", "got it!", "what's next?"]) assert.ok(isNextStep(t), t);
  for (const t of ["okay but how hot should the pan be?", "I don't have eggs"]) assert.ok(!isNextStep(t), t);
});

test("P0 walkthrough plan: step 1 + one ingredient check, next → step 2, a question stays on the step, last step ends it", () => {
  const c = recipe();
  const start = walkPlan("Walk me through it", null, c, ID)!;
  assert.deepEqual(start.state, { findId: ID, step: 0 });
  assert.ok(start.quiet);
  assert.match(start.line, /step 1 of 3: Fry the kimchi in oil\./);
  assert.doesNotMatch(start.line, /maangchi/, "the source name is not spoken");
  assert.match(start.line, /exactly one ingredient-check question/);
  assert.match(start.line, /Eggs, Rice/, "asks about what the camera did not see");
  const two = walkPlan("next", start.state, c, ID)!;
  assert.deepEqual(two.state, { findId: ID, step: 1 });
  assert.match(two.line, /step 2 of 3: Add the rice and stir\./);
  const q = walkPlan("how long do I stir?", two.state, c, ID)!;
  assert.deepEqual(q.state, two.state, "a question stays on the step");
  assert.equal(q.quiet, false);
  const three = walkPlan("done", two.state, c, ID)!;
  assert.match(three.line, /step 3 of 3/);
  assert.match(three.line, /last step: no ingredient question/);
  const end = walkPlan("okay", three.state, c, ID)!;
  assert.equal(end.state, null);
  assert.match(end.line, /that was the last step/);
  // not a recipe on screen / another card / no walkthrough: nothing
  assert.equal(walkPlan("Walk me through it", null, { ...c, kind: "link" }, ID), null);
  assert.equal(walkPlan("next", null, c, ID), null);
  assert.equal(walkPlan("next", { findId: "other", step: 0 }, c, ID), null);
});

test("P0 walkthrough in the runner: the CTA turn on a recipe card starts no search and no judge; 'next' advances", async () => {
  const store = new MemoryFindsStore();
  await store.put(ownerKey("acct-a"), recipe());
  let sparkCalls = 0;
  const vendors = {
    async spark() { sparkCalls++; return { text: '{"kind":"general"}', output: [] }; },
    async *sparkStream() {},
  } as unknown as FindsVendors;
  const events: string[] = [];
  const runner = new FindsRunner({ vendors, store, images: false, imageBase: "/v1/finds" }, { emit: (e) => events.push(e.type), announce() {}, log() {}, now: () => 0 });
  runner.configure({ owner: "acct-a", memories: [] });
  await runner.focus(ID);
  const turn = (text: string) => runner.onTurn({ text, frames: [], utteranceId: 1, replyText: Promise.resolve(null), recent: ["You: Here's kimchi fried rice."] });
  assert.match(runner.walkTurn("Walk me through it")?.line ?? "", /step 1 of 3/);
  assert.equal(turn("Walk me through it"), null);
  assert.match(runner.walkTurn("next")?.line ?? "", /step 2 of 3/, "the step is kept after the turn");
  assert.equal(turn("next"), null);
  assert.match(runner.walkTurn("next")?.line ?? "", /step 3 of 3/);
  await runner.settle();
  assert.equal(sparkCalls, 0, "no judge / search model asked");
  assert.deepEqual(events, [], "no find events");
});

test("P0 walkthrough in a call: the CTA text turn (build 13 sends text + findId) gets step 1 in the prompt, no web search; 'next' gets step 2", async () => {
  const { EventEmitter } = await import("node:events");
  const { loadConfig } = await import("../src/config.ts");
  const { Session } = await import("../src/session/session.ts");
  const store = new MemoryFindsStore();
  await store.put(ownerKey("acct"), recipe());
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const events: { type: string }[] = [];
  const client = { sendJson(e: unknown) { events.push(e as { type: string }); }, sendBinary() {}, close() {} };
  const reqs: import("../src/meta/spark.ts").SparkRequest[] = [];
  const s = new Session("w1", client, {
    config: { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, speculate: false, sparkHedge: 1, webSearch: true },
    openAsr: () => asr,
    userId: "acct",
    async *spark(req) { reqs.push(req); yield { type: "text", delta: "First, fry the kimchi. Do you have eggs?" }; },
    async *tts() {},
    finds: { vendors: { async spark() { throw new Error("no search"); }, async *sparkStream() {} } as unknown as FindsVendors, store, images: false, imageBase: "/v1/finds" },
  } as import("../src/session/session.ts").SessionDeps);
  const waitFor = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 2)); } };
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  const before = reqs.length;
  await s.onClientText(JSON.stringify({ type: "text", text: "Walk me through it", findId: ID }));
  await waitFor(() => reqs.length > before);
  const first = reqs.at(-1)!;
  assert.match(String(first.instructions), /step 1 of 3: Fry the kimchi in oil\./);
  assert.match(String(first.instructions), /exactly one ingredient-check question/);
  assert.equal(first.tools, undefined, "a walkthrough step is never web-searched");
  const n = reqs.length;
  await s.onClientText(JSON.stringify({ type: "text", text: "next" }));
  await waitFor(() => reqs.length > n);
  assert.match(String(reqs.at(-1)!.instructions), /step 2 of 3: Add the rice and stir\./);
  assert.ok(!events.some((e) => e.type === "find.started"), "no new search card");
  s.close();
});
