/**
 * P0 11/4 (Chelsea, demo): a dish asked for by name opens the visual recipe card (dish photo from the recipe page,
 * ingredients, steps) — never a spoken recipe or a link list. Server only: same events as the fridge card.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn, isNamedRecipeAsk } from "../src/finds/intent.ts";
import { NAMED_RECIPE_SAY, namedRecipeCard, runNamedRecipe } from "../src/finds/namedRecipe.ts";
import type { PipelineCtx } from "../src/finds/pipeline.ts";
import type { ServerEvent } from "../src/protocol.ts";

test("a dish by name with no camera → the named recipe card", () => {
  for (const t of ["Give me a kimchi fried rice recipe", "kimchi fried rice recipe", "how do I make bibimbap", "How do you make pad thai?", "show me the recipe", "김치볶음밥 레시피 알려줘"]) {
    assert.deepEqual(classifyTurn(t, false), { kind: "recipe", named: true }, t);
  }
});

test("camera on but nothing pointed at → named; 'with these' stays the fridge card", () => {
  assert.deepEqual(classifyTurn("give me a kimchi fried rice recipe", true), { kind: "recipe", named: true });
  assert.deepEqual(classifyTurn("what can I make with these?", true), { kind: "recipe" });
  assert.deepEqual(classifyTurn("give me a recipe with these", true), { kind: "recipe" });
});

test("not a dish: stays off the recipe card", () => {
  for (const t of ["how do I make money online", "how do I make a website", "how do I make this?", "recipe restaurants near Gangnam", "what's the weather today"]) {
    assert.equal(isNamedRecipeAsk(t), false, t);
  }
  assert.notDeepEqual(classifyTurn("how do I make friends at work", false), { kind: "recipe", named: true });
});

const JSON_OK = {
  dish: "kimchi fried rice",
  minutes: 20,
  ingredients: [
    { name: "cooked rice", amount: "2 cups" },
    { name: "kimchi", amount: "1 cup" },
    { name: "gochujang", amount: "1 tbsp" },
    { name: "sesame oil", amount: "1 tsp" },
    { name: "egg", amount: "1" },
    { name: "green onion", amount: "2 stalks", optional: true },
  ],
  steps: ["Chop the kimchi.", "Fry kimchi in oil for 3 minutes.", "Add rice and gochujang, stir-fry.", "Top with a fried egg."],
  why: "Day-old rice keeps it from going mushy.",
  sources: [{ title: "Kimchi fried rice", url: "https://www.maangchi.com/recipe/kimchi-bokkeumbap" }, { title: "Fake", url: "https://invented.example/x" }],
  ask: ["Can I skip egg?", "Less spicy?"],
};

test("card payload: recipe kind, every ingredient 'buy' with its amount, steps, photo slots, short say", () => {
  const card = namedRecipeCard("f1", JSON_OK, ["https://www.maangchi.com/recipe/kimchi-bokkeumbap"], new Date(0), true)!;
  assert.equal(card.kind, "recipe");
  assert.equal(card.title, "Kimchi fried rice");
  assert.equal(card.camera, undefined);
  assert.equal(card.items.length, 6);
  assert.ok(card.items.every((i) => i.tier === "buy" && i.from === "recipe" && !i.box));
  assert.equal(card.items[0].name, "cooked rice · 2 cups");
  assert.equal(card.items[5].optional, true);
  assert.equal(card.steps.length, 4);
  assert.ok(card.steps.every((s) => !s.image), "no generated step pictures");
  assert.equal(card.hero, undefined, "no pending hero slot (an empty grey square if it never loads)");
  assert.equal(card.sources.length, 1, "an invented URL is dropped");
  assert.equal(card.sources[0].image, undefined);
  assert.deepEqual(card.why, ["Day-old rice keeps it from going mushy."]);
  assert.equal(card.say, NAMED_RECIPE_SAY);
  assert.ok(card.say!.split(/\s+/).length < 14);
  assert.ok(card.pill!.length <= 28);
  assert.equal(namedRecipeCard("f1", { dish: "" }, [], new Date(0), true), null);
});

test("runNamedRecipe (GENITA_FIND_IMAGE_GATE=0): started → created → hero from the page's og:image; no image generation", async () => {
  // the recipe page's own og:image path alone (web photos per row: finds-visual.test.ts)
  process.env.GENITA_FIND_WEB_IMAGES = "0";
  process.env.GENITA_FIND_IMAGE_GATE = "0";
  try {
  const events: ServerEvent[] = [];
  let generated = 0;
  const ctx = {
    findId: "f2", utteranceId: 1, kind: "recipe", question: "give me a kimchi fried rice recipe", frames: [], memories: [],
    replyText: Promise.resolve(null), emit: (e: ServerEvent) => events.push(e), signal: new AbortController().signal,
    now: () => Date.now(), log: () => {}, images: true,
    putImage: async (slot: string) => `/v1/finds/f2/images/${slot}`,
    vendors: {
      spark: async () => ({ text: JSON.stringify(JSON_OK), output: [{ type: "web_search_call", action: { type: "search", sources: [{ url: "https://www.maangchi.com/recipe/kimchi-bokkeumbap" }] } }] }),
      image: async () => { generated++; return Buffer.from("x"); },
      pageFacts: async () => ({ image: "https://www.maangchi.com/photo.jpg" }),
      productImage: async () => Buffer.from("jpeg"),
    },
  } as unknown as PipelineCtx;
  const r = await runNamedRecipe(ctx);
  assert.ok(r.card);
  assert.deepEqual(events.map((e) => e.type), ["find.started", "find.created", "find.image"]);
  assert.equal((events[0] as { kind: string }).kind, "recipe");
  const imgs = events.filter((e) => e.type === "find.image") as { slot: string; status: string }[];
  assert.deepEqual(imgs.map((e) => [e.slot, e.status]), [["hero", "ready"]]);
  assert.equal(generated, 0);
  } finally {
    delete process.env.GENITA_FIND_WEB_IMAGES;
    delete process.env.GENITA_FIND_IMAGE_GATE;
  }
});

test("GENITA_FIND_IMAGE_GATE=0: no og:image anywhere → no hero event at all (never a failed / grey slot)", async () => {
  // the recipe page's own og:image path alone (web photos per row: finds-visual.test.ts)
  process.env.GENITA_FIND_WEB_IMAGES = "0";
  process.env.GENITA_FIND_IMAGE_GATE = "0";
  try {
  const events: ServerEvent[] = [];
  const ctx = {
    findId: "f3", utteranceId: 1, kind: "recipe", question: "how do I make bibimbap", frames: [], memories: [],
    replyText: Promise.resolve(null), emit: (e: ServerEvent) => events.push(e), signal: new AbortController().signal,
    now: () => Date.now(), log: () => {}, images: true, putImage: async (slot: string) => `/x/${slot}`,
    vendors: {
      spark: async () => ({ text: JSON.stringify({ ...JSON_OK, dish: "bibimbap" }), output: [] }),
      pageFacts: async () => ({ image: null }),
      productImage: async () => null,
    },
  } as unknown as PipelineCtx;
  const r = await runNamedRecipe(ctx);
  assert.ok(r.card && !r.card.hero);
  assert.deepEqual(events.map((e) => e.type), ["find.started", "find.created"]);
  } finally {
    delete process.env.GENITA_FIND_WEB_IMAGES;
    delete process.env.GENITA_FIND_IMAGE_GATE;
  }
});
