/**
 * CEO demo asks (11/4): A "what's this?" outlines the held thing and names it (no sheet); B "find me that jacket"
 * while watching together searches from the shared screen; C scene 5 — after the outfit verdict, "yes" / "find me
 * some" finds what goes with it from the camera + her taste.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn, isGoesWithFollowUp, isIdentifyAsk, refersToScreen } from "../src/finds/intent.ts";
import { runIdentify, IDENTIFY_UNSURE, type PipelineCtx } from "../src/finds/pipeline.ts";
import { productPrompt, SCREEN_LINE, CAMERA_LINE } from "../src/finds/product.ts";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import { checkServerEvent, type ServerEvent } from "../src/protocol.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";
import type { SamBox } from "../src/meta/sam.ts";

// ───────────── A: identify ─────────────

test("A intent: 'what's this?' with the camera on is an identify ask; without the camera it stays a spoken answer", () => {
  for (const l of ["What's this?", "what is this", "What is that?", "Hey Rio, what's this?", "What am I holding?", "Do you know what this is?", "이게 뭐야", "이거 뭐야?", "이건 뭐야"]) {
    assert.deepEqual(classifyTurn(l, true), { kind: "identify" }, l);
    assert.equal(classifyTurn(l, false), null, l);
  }
  // not about a thing in view
  for (const l of ["What's this song?", "What is this about?", "What's that smell?", "What does that mean?", "what's this show called", "What is it like living in Seoul?", "What's it like outside today?", "What's this like?"]) assert.equal(isIdentifyAsk(l), false, l);
  // the existing cards keep winning
  assert.deepEqual(classifyTurn("What can I make with what's in here?", true), { kind: "recipe" });
  assert.deepEqual(classifyTurn("Which one should I wear tonight?", true), { kind: "outfit" });
});

const FRAME = "data:image/jpeg;base64,AAA";
function samBox(x1: number, y1: number, x2: number, y2: number): SamBox {
  return { x1, y1, x2, y2, w: 480, h: 854, nx1: x1 / 480, ny1: y1 / 854, nx2: x2 / 480, ny2: y2 / 854 };
}
function idVendors(o: { name: string; say?: string; yes: boolean; boxes: SamBox[] }): FindsVendors & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async spark(req) {
      const prompt = JSON.stringify(req.input);
      if (prompt.includes("clearly visible in this photo")) { calls.push("yes"); return { text: o.yes ? "YES" : "NO", output: [] }; }
      if (prompt.includes("asks what it is")) { calls.push("name"); return { text: JSON.stringify({ name: o.name, say: o.say ?? "" }), output: [] }; }
      throw new Error("unexpected spark");
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam(_img, prompt) { calls.push(`sam:${prompt}`); return o.boxes; },
    async image() { return Buffer.from([]); },
  };
}
function idCtx(vendors: FindsVendors): { ctx: PipelineCtx; events: ServerEvent[]; said: string[] } {
  const events: ServerEvent[] = [];
  const said: string[] = [];
  const ctx: PipelineCtx = {
    findId: "id-1", utteranceId: 4, kind: "recipe", question: "What's this?", frames: [FRAME, FRAME], memories: [], replyText: Promise.resolve(null), vendors,
    emit: (e) => { assert.deepEqual(checkServerEvent(e as unknown as Record<string, unknown>), [], JSON.stringify(e)); events.push(e); },
    signal: new AbortController().signal, now: () => performance.now(), log: () => {}, images: false, putImage: async () => "", speak: (t) => said.push(t),
  };
  return { ctx, events, said };
}

test("A pipeline: Spark names it, YES + SAM box confirm → one outline on the last frame and the line names it; no sheet", async () => {
  // two matches: the more central one is outlined
  const v = idVendors({ name: "coffee mug", say: "That's a coffee mug, looks handmade!", yes: true, boxes: [samBox(0, 0, 60, 100), samBox(180, 330, 300, 520)] });
  const { ctx, events, said } = idCtx(v);
  await runIdentify(ctx);
  assert.deepEqual(events.map((e) => e.type), ["observe.boxes"], "no find.started / card: the sheet never opens");
  const b = events[0] as Extract<ServerEvent, { type: "observe.boxes" }>;
  assert.equal(b.frame, 1);
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].label, "Coffee mug");
  assert.ok(b.items[0].box.x1 > 0.3, "the central match, not the corner one");
  assert.deepEqual(said, ["That's a coffee mug, looks handmade!"]);
});

test("A pipeline: Spark NO or no SAM box → no outline and never named (honest line)", async () => {
  for (const o of [{ yes: false, boxes: [samBox(180, 330, 300, 520)] }, { yes: true, boxes: [] }]) {
    const { ctx, events, said } = idCtx(idVendors({ name: "stapler", say: "That's a stapler.", ...o }));
    await runIdentify(ctx);
    assert.equal(events.length, 0);
    assert.deepEqual(said, [IDENTIFY_UNSURE]);
  }
});

test("A pipeline: a person or a face is never outlined", async () => {
  for (const name of ["face", "person", "woman", "your face", "selfie", "nose", "mouth", "eyes"]) {
    const v = idVendors({ name, say: "That's you!", yes: true, boxes: [samBox(180, 330, 300, 520)] });
    const { ctx, events, said } = idCtx(v);
    await runIdentify(ctx);
    assert.equal(events.length, 0, name);
    assert.ok(!v.calls.some((c) => c.startsWith("sam:")), "SAM is never asked for a person");
    assert.deepEqual(said, [IDENTIFY_UNSURE]);
  }
});

// ───────────── runner helpers ─────────────

type Captured = { events: ServerEvent[]; said: string[]; prompts: { text: string; images: number }[] };
function runnerVendors(cap: Captured): FindsVendors {
  return {
    async spark(req) {
      const input = req.input as { content: { type: string; text?: string }[] }[];
      const parts = Array.isArray(input) ? input.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) : [];
      const text = parts.filter((p) => p.type === "input_text").map((p) => p.text).join("\n");
      cap.prompts.push({ text, images: parts.filter((p) => p.type === "input_image").length });
      if (text.includes("asks what it is")) return { text: JSON.stringify({ name: "mug", say: "A mug!" }), output: [] };
      if (text.includes("clearly visible")) return { text: "YES", output: [] };
      return { text: "", output: [] };
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return [samBox(180, 330, 300, 520)]; },
    async image() { return Buffer.from([]); },
    async pageFacts() { return null; },
    async productImage() { return null; },
  };
}
function newRunner(cap: Captured): FindsRunner {
  const store = new MemoryFindsStore();
  const r = new FindsRunner(
    { vendors: runnerVendors(cap), store, images: false, imageBase: "/v1/finds", productHedge: 1, productPrefetch: false, stillSearchingMs: 60_000 },
    { emit: (e) => cap.events.push(e), announce: (t) => cap.said.push(t), log() {}, now: () => performance.now() },
  );
  r.configure({ owner: "u1", memories: [], profile: "Taste\n- Likes: earthy tones, dark brown leather, clean minimal cuts" });
  return r;
}
const cap0 = (): Captured => ({ events: [], said: [], prompts: [] });
const settle = () => new Promise((r) => setTimeout(r, 30));

test("A runner: identify starts no find (no sheet), acks, and outlines", async () => {
  const cap = cap0();
  const r = newRunner(cap);
  const s = r.onTurn({ text: "What's this?", frames: [FRAME], utteranceId: 1, replyText: Promise.resolve(null) });
  assert.equal(s?.kind, "identify");
  assert.ok(s?.ack);
  await settle();
  assert.ok(!cap.events.some((e) => e.type === "find.started"));
  assert.ok(cap.events.some((e) => e.type === "observe.boxes"));
  assert.deepEqual(cap.said, ["A mug!"]);
  r.close();
});

// ───────────── B: product from the shared screen ─────────────

test("B intent: a product ask that points at the screen", () => {
  for (const l of ["Find me that jacket", "Where can I get that outfit?", "Can you find me the jacket he's wearing?", "find me those shoes", "find me the same coat"]) {
    assert.deepEqual(classifyTurn(l, false), { kind: "product" }, l);
    assert.equal(refersToScreen(l), true, l);
  }
  for (const l of ["Can we look for a jacket for this weekend?", "Find me a black jacket"]) assert.equal(refersToScreen(l), false, l);
});

test("B prompt: the screen frame is the visual reference (not 'what they are wearing')", () => {
  const p = productPrompt({ question: "find me that jacket", recent: [], taste: [], city: null, region: "US", today: "Wednesday", seeing: true, screen: true });
  assert.ok(p.includes(SCREEN_LINE));
  assert.ok(!p.includes(CAMERA_LINE));
});

test("B runner: while watching, 'find me that jacket' sends the latest shared-screen frame with the search", async () => {
  const cap = cap0();
  const r = newRunner(cap);
  const s = r.onTurn({ text: "Find me that jacket", frames: [], screen: "data:image/jpeg;base64,SCREEN", utteranceId: 1, replyText: Promise.resolve(null) });
  assert.equal(s?.kind, "product");
  await settle();
  const search = cap.prompts.find((p) => p.text.includes("Shop for them"));
  assert.ok(search, "a product search ran");
  assert.equal(search!.images, 1, "the screen frame rides along");
  assert.ok(search!.text.includes(SCREEN_LINE));
  r.close();
});

// ───────────── D: screen share takes the shared frame (Chelsea 11/4) ─────────────

test("D runner: while sharing with no camera, any product ask takes the shared frame", async () => {
  const cap = cap0();
  const r = newRunner(cap);
  r.onTurn({ text: "Find me a black jacket", frames: [], screen: "data:image/jpeg;base64,SCREEN", utteranceId: 1, replyText: Promise.resolve(null) });
  await settle();
  const search = cap.prompts.find((p) => p.text.includes("Shop for them"))!;
  assert.equal(search.images, 1);
  assert.ok(search.text.includes(SCREEN_LINE));
  r.close();
});

test("D runner: 'what's this?' on a shared screen names it in the sheet (the Mac draws no boxes over a share)", async () => {
  const cap = cap0();
  const r = newRunner(cap);
  const s = r.onTurn({ text: "What's this on my screen?", frames: [FRAME], screen: "data:image/jpeg;base64,SCREEN", utteranceId: 1, replyText: Promise.resolve(null) });
  assert.equal(s?.kind, "identify");
  await settle();
  assert.ok(!cap.events.some((e) => e.type === "observe.boxes"));
  const created = cap.events.find((e) => e.type === "find.created") as Extract<ServerEvent, { type: "find.created" }>;
  assert.equal(created.card.kind, "answer");
  assert.equal(created.card.eyebrow, "From your screen");
  assert.equal(created.card.title, "Mug");
  assert.deepEqual(cap.said, ["A mug!"]);
  r.close();
});

test("D runner: sharing, but the outfit question is about her: the camera frames, not the screen", async () => {
  const cap = cap0();
  const r = newRunner(cap);
  const s = r.onTurn({ text: "Which one looks better on me?", frames: [FRAME, FRAME], screen: "data:image/jpeg;base64,SCREEN", utteranceId: 1, replyText: Promise.resolve(null) });
  assert.equal(s?.kind, "outfit");
  await settle();
  const pick = cap.prompts.find((p) => p.text.includes("clothes they are choosing"))!;
  assert.equal(pick.images, 2);
  assert.ok(!JSON.stringify(cap.prompts).includes("SCREEN"));
  r.close();
});

// ───────────── C: scene 5 ─────────────

test("C intent: follow-ups to the outfit verdict's offer", () => {
  for (const l of ["Find me some.", "Find me a pair!", "yes", "Yes please", "sure", "Yeah, go for it", "find me some", "Find me a pair", "what shoes would go with it", "What would go with this?", "Okay, show me some"]) assert.equal(isGoesWithFollowUp(l), true, l);
  for (const l of ["What do you think about my hair?", "yes, I'm going to dinner with my parents and then a movie later tonight"]) assert.equal(isGoesWithFollowUp(l), false, l);
});

test("C1: 'find me shoes that would go with this' with the camera on: the frame AND her taste reach the search", async () => {
  const cap = cap0();
  const r = newRunner(cap);
  r.onTurn({ text: "Can you find me shoes that would go with this?", frames: [FRAME], utteranceId: 1, replyText: Promise.resolve(null) });
  await settle();
  const search = cap.prompts.find((p) => p.text.includes("Shop for them"))!;
  assert.equal(search.images, 1);
  assert.ok(search.text.includes(CAMERA_LINE));
  assert.ok(/dark brown leather/.test(search.text), "her imported taste is in the search");
  r.close();
});

test("C2: after the outfit verdict offers to find a pair, 'yes' searches what was offered, with the camera and her taste", async () => {
  const cap = cap0();
  const r = newRunner(cap);
  const verdict = "Go with the camel trench, it's so you. Want me to find dark brown boots for it?";
  r.onTurn({ text: "Which one should I wear tonight?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(verdict) });
  await settle();
  const before = cap.prompts.length;
  const s = r.onTurn({ text: "Yes please", frames: [FRAME], utteranceId: 2, replyText: Promise.resolve(null), recent: ["User: Which one should I wear tonight?", `You: ${verdict}`] });
  assert.equal(s?.kind, "product");
  await settle();
  const search = cap.prompts.slice(before).find((p) => p.text.includes("Shop for them"))!;
  assert.ok(search, "a product search ran");
  assert.ok(/dark brown boots/.test(search.text), "it searches what the verdict offered");
  assert.ok(search.text.includes(CAMERA_LINE));
  assert.ok(search.images >= 1);
  assert.ok(/dark brown leather/.test(search.text));
  r.close();
});

test("C2: a bare 'yes' with no outfit verdict (or no offer) is just a reply", () => {
  const cap = cap0();
  const r = newRunner(cap);
  assert.equal(r.onTurn({ text: "yes", frames: [FRAME], utteranceId: 1, replyText: Promise.resolve(null), recent: ["You: Did you sleep well?"] }), null);
  r.close();
});

// ───────────── Codex r1 ─────────────

const VERDICT = "Go with the camel trench, it's so you. Want me to find dark brown boots for it?";
async function afterVerdict(cap: Captured): Promise<FindsRunner> {
  const r = newRunner(cap);
  r.onTurn({ text: "Which one should I wear tonight?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(VERDICT) });
  await settle();
  return r;
}

test("Codex r1: a new ask of its own after the verdict keeps its own card", async () => {
  const cap = cap0();
  const r = await afterVerdict(cap);
  assert.equal(r.onTurn({ text: "Find me some chicken recipes", frames: [FRAME], utteranceId: 2, replyText: Promise.resolve(null), recent: [`You: ${VERDICT}`] })?.kind, "recipe");
  r.close();
  const cap2 = cap0();
  const r2 = await afterVerdict(cap2);
  const before = cap2.prompts.length;
  r2.onTurn({ text: "Find me a pair of headphones", frames: [], utteranceId: 2, replyText: Promise.resolve(null), recent: [`You: ${VERDICT}`] });
  await settle();
  const search = cap2.prompts.slice(before).find((p) => p.text.includes("Shop for them"))!;
  assert.ok(search.text.includes('The user asked out loud: "Find me a pair of headphones"'), "not rewritten to the verdict's boots");
  r2.close();
});

test("Codex r1: a 'yes' after another exchange is not the verdict's yes", async () => {
  const cap = cap0();
  const r = await afterVerdict(cap);
  assert.equal(r.onTurn({ text: "Anyway, I'm hungry", frames: [], utteranceId: 2, replyText: Promise.resolve(null), recent: [`You: ${VERDICT}`] }), null);
  assert.equal(r.onTurn({ text: "Yes", frames: [], utteranceId: 3, replyText: Promise.resolve(null), recent: ["You: Want me to find a restaurant nearby?"] }), null);
  r.close();
});

test("Codex r1: after 'Forget all of this', the verdict's line is not searched", async () => {
  const cap = cap0();
  const r = await afterVerdict(cap);
  r.forgetTaste();
  assert.equal(r.onTurn({ text: "find me some", frames: [], utteranceId: 2, replyText: Promise.resolve(null), recent: [`You: ${VERDICT}`] }), null);
  r.close();
});

test("Codex r1: camera and share both on — 'what am I holding?' looks at the camera", async () => {
  const cap = cap0();
  const r = newRunner(cap);
  r.onTurn({ text: "What am I holding?", frames: [FRAME], screen: "data:image/jpeg;base64,SCREEN", utteranceId: 1, replyText: Promise.resolve(null) });
  await settle();
  assert.ok(cap.events.some((e) => e.type === "observe.boxes"));
  assert.ok(!JSON.stringify(cap.prompts).includes("SCREEN"));
  r.close();
});

test("Codex r1: a recipe from the shared screen sends no camera boxes", async () => {
  const cap = cap0();
  const r = newRunner(cap);
  r.onTurn({ text: "What can I cook from this on my screen?", frames: [], screen: "data:image/jpeg;base64,SCREEN", utteranceId: 1, replyText: Promise.resolve(null) });
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(!cap.events.some((e) => e.type === "observe.boxes"));
  r.close();
});

test("Codex r2: a screen-made card is saved without the camera picture too", async () => {
  const { screenCard } = await import("../src/finds/runner.ts");
  const card = { id: "x", kind: "recipe", createdAt: "", eyebrow: "From your fridge", title: "t", subtitle: "", status: "", camera: { frame: 0, at: "", w: 1, h: 1, label: "Your camera · 5 PM" }, items: [], steps: [], options: [], why: [], ask: [], sources: [], how: ["Boxes are drawn on your camera frame."] } as unknown as import("../src/protocol.ts").FindCard;
  const out = screenCard(card);
  assert.equal(out.camera, undefined);
  assert.equal(out.eyebrow, "From your screen");
  assert.ok(!/camera/i.test(out.how.join(" ")));
});

test("QA: 'shoes that would go with this' with a share open still looks at the camera (demo S5)", async () => {
  const cap = cap0();
  const r = newRunner(cap);
  r.onTurn({ text: "Can you find me shoes that would go with this?", frames: [FRAME], screen: "data:image/jpeg;base64,SCREEN", utteranceId: 1, replyText: Promise.resolve(null) });
  await settle();
  const search = cap.prompts.find((p) => p.text.includes("Shop for them"))!;
  assert.ok(search.text.includes(CAMERA_LINE));
  assert.ok(!JSON.stringify(cap.prompts).includes("SCREEN"));
  r.close();
});

test("P0 11/4: describe / observe questions about clothes stay spoken (no find), choices keep the outfit card", () => {
  for (const l of ["What am I wearing?", "How do I look?", "Do you like my shirt?", "What color is this?", "Describe my outfit", "Does this look good on me?", "Is this jacket too big?"]) {
    assert.equal(classifyTurn(l, true), null, l);
  }
  for (const l of ["Which one should I wear tonight?", "Which one looks better on me, the white one or the black one?", "What should I wear to dinner?", "Help me pick a jacket", "뭐 입을까?", "Should I go with the coat or the blazer?"]) {
    assert.deepEqual(classifyTurn(l, true), { kind: "outfit" }, l);
  }
  // S5 keeps its routes
  assert.deepEqual(classifyTurn("Can you find me shoes that would go with this?", true), { kind: "product" });
  assert.equal(isGoesWithFollowUp("Find me some."), true);
});
