import { test } from "node:test";
import assert from "node:assert/strict";
import { isSeeingAsk, observeBoxes, observeBoxesEnabled, replyNouns, shouldObserve } from "../src/observe/boxes.ts";
import { SERVER_EVENT_FIELDS } from "../src/protocol.ts";
import type { SamBox } from "../src/meta/sam.ts";

const box = (x1: number, y1: number, x2: number, y2: number, score = 0.9): SamBox =>
  ({ x1, y1, x2, y2, w: 480, h: 854, nx1: x1 / 480, ny1: y1 / 854, nx2: x2 / 480, ny2: y2 / 854, score });

test("seeing asks trigger, small talk does not", () => {
  for (const t of ["Can you see?", "can you see this", "What do you see?", "look at this", "What's this?", "what's in here", "see that?"]) assert.ok(isSeeingAsk(t), t);
  for (const t of ["How was your day?", "I love you", "tell me a joke"]) assert.ok(!isSeeingAsk(t), t);
  assert.ok(shouldObserve("hmm", "I can see pork down below."));
  assert.ok(!shouldObserve("how are you", "Doing great, thanks!"));
});

test("reply nouns: the fridge answer → pork, kimchi, fruit (2–5, first mentioned first)", () => {
  const n = replyNouns("Yeah! Pork down below, so pork plus kimchi would be great. The fruit is just dessert.");
  assert.deepEqual(n.slice(0, 3), ["pork", "kimchi", "fruit"]);
  assert.ok(n.length <= 5);
  assert.deepEqual(replyNouns("I see a cat and a laptop on the desk."), ["cat", "laptop", "desk"]);
});

test("kill switch GENITA_OBSERVE_BOXES=0, default on", () => {
  assert.equal(observeBoxesEnabled({}), true);
  assert.equal(observeBoxesEnabled({ GENITA_OBSERVE_BOXES: "0" }), false);
});

test("event shape is the observe.boxes the apps decode", async () => {
  const sam = async (_img: string, p: string) => (p === "pork" ? [box(48, 400, 240, 600)] : []);
  const e = await observeBoxes({ utteranceId: 7, frame: "data:image/jpeg;base64,AA", frameIndex: 1, nouns: ["pork", "kimchi"], vendors: { sam } });
  assert.ok(e);
  const f = SERVER_EVENT_FIELDS["observe.boxes"];
  assert.deepEqual(Object.keys(e).sort(), [...f.required, ...f.optional, "type"].sort());
  assert.equal(e.type, "observe.boxes");
  assert.equal(e.findId, "observe-7");
  assert.equal(e.frame, 1);
  assert.equal(e.w, 480);
  assert.equal(e.h, 854);
  assert.deepEqual(e.items.map((i) => i.label), ["Pork"]);
  assert.deepEqual(Object.keys(e.items[0].box).sort(), ["x1", "x2", "y1", "y2"]);
});

test("timeout, failure or no hit sends nothing", async () => {
  const slow = () => new Promise<SamBox[]>((r) => setTimeout(() => r([box(1, 1, 100, 100)]), 200));
  assert.equal(await observeBoxes({ utteranceId: 1, frame: "x", frameIndex: 0, nouns: ["pork"], vendors: { sam: slow }, timeoutMs: 20 }), null);
  assert.equal(await observeBoxes({ utteranceId: 1, frame: "x", frameIndex: 0, nouns: ["pork"], vendors: { sam: async () => { throw new Error("500"); } } }), null);
  assert.equal(await observeBoxes({ utteranceId: 1, frame: "x", frameIndex: 0, nouns: ["pork"], vendors: { sam: async () => [] } }), null);
});
