/**
 * No empty pictures (Chelsea 11/4): page → web → (product: swap | food / how-to / general: generate) → omit.
 * GENITA_FIND_IMAGE_GATE=0 and GENITA_FIND_IMAGE_GEN=0 are the kill switches.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runProduct, type ProductCtx } from "../src/finds/product.ts";
import { readPageFacts } from "../src/finds/fetchPage.ts";
import { runNamedRecipe } from "../src/finds/namedRecipe.ts";
import { rowPictures } from "../src/finds/general.ts";
import { applyFindImage } from "../src/finds/runner.ts";
import { clearWebImageCache } from "../src/finds/imageFinder.ts";
import { GEN_PARALLEL, clearGenCache, genPrompt, generatePicture } from "../src/finds/imageGen.ts";
import type { PipelineCtx } from "../src/finds/pipeline.ts";
import type { FindsVendors, OutputItem } from "../src/finds/vendors.ts";
import { checkServerEvent, type FindCard, type ServerEvent } from "../src/protocol.ts";

type ImageEvent = Extract<ServerEvent, { type: "find.image" }>;
const images = (events: ServerEvent[]) => events.filter((e): e is ImageEvent => e.type === "find.image");

/** every event is valid protocol and carries no null anywhere (absent fields are left out) */
function wireClean(events: ServerEvent[]): void {
  for (const e of events) {
    assert.deepEqual(checkServerEvent(e as unknown as Record<string, unknown>), [], JSON.stringify(e));
    const nulls: string[] = [];
    JSON.stringify(e, (k, v) => (v === null && nulls.push(k), v));
    assert.deepEqual(nulls, [], `null in ${JSON.stringify(e)}`);
  }
}

const ENV = ["GENITA_FIND_IMAGE_GATE", "GENITA_FIND_IMAGE_GEN", "GENITA_FIND_WEB_IMAGES"] as const;
beforeEach(() => {
  clearGenCache();
  clearWebImageCache();
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

// ───────── products: page → web → swap → omit (never generated) ─────────
// the swap mechanics on a two-product card (GENITA_PRODUCT_MAX=2): with the default 6, P3 is a third product, not a
// spare (the six-product card is tested in product-six.test.ts)
process.env.GENITA_PRODUCT_MAX = "2";

const P1 = "https://www.northline.example.com/products/cotton-chore-jacket-navy";
const P2 = "https://fieldandco.example.com/product/linen-overshirt-123456.html";
const P3 = "https://shop3.example.com/products/wool-field-jacket-777777";
const OPEN = (url: string): OutputItem => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url } });
const SEARCH: OutputItem = { type: "web_search_call", status: "completed", action: { type: "search", query: "jacket" } };
const ITEMS = [
  { name: "Cotton chore jacket", url: P1, store: "Northline", price: "$70", taste: "Clean, minimal", situation: "Light for a weekend" },
  { name: "Linen overshirt", url: P2, store: "Field & Co.", price: "", taste: "Understated color", situation: "Easy to layer" },
  { name: "Wool field jacket", url: P3, store: "Shop Three", price: "$120", taste: "Clean lines", situation: "Warm enough" },
];

function productRun(o: { p2Image?: boolean; p3Image?: boolean; p2Facts?: Record<string, unknown> } = {}) {
  let generated = 0;
  const v: FindsVendors = {
    async spark(req) {
      if (JSON.stringify(req.input).includes("Do one web search for")) return { text: "OK", output: [] };
      const json = JSON.stringify({ label: "Light jacket", title: "Two for the weekend", subtitle: "Light jackets.", style_line: "Clean, minimal clothes.", situation_line: "Mild this weekend", items: ITEMS, say: "Two." });
      return { text: json, output: [SEARCH, OPEN(P1), OPEN(P2), OPEN(P3)] };
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return []; },
    async image() { generated++; return Buffer.from("generated"); },
    async pageFacts(url) {
      if (url === P1) return { kind: "product", image: "https://cdn.example.com/1.jpg" };
      if (url === P2) return o.p2Facts ? (o.p2Facts as never) : { kind: "product", price: "$40", ...(o.p2Image ? { image: "https://cdn.example.com/2.jpg" } : {}) };
      if (url === P3) return { kind: "product", ...(o.p3Image === false ? {} : { image: "https://cdn.example.com/3.jpg" }) };
      return null;
    },
    async productImage(url) { return Buffer.from(`img:${url}`); },
  };
  const events: ServerEvent[] = [];
  const stored: string[] = [];
  const ctx: ProductCtx = {
    findId: "fp", utteranceId: 1, kind: "product", question: "Can we look for a jacket for this weekend?", frames: [], memories: [],
    replyText: Promise.resolve(null), timeZone: "Asia/Seoul", vendors: v, emit: (e) => events.push(e), signal: new AbortController().signal,
    now: () => performance.now(), log: () => {}, images: true, putImage: async (slot) => (stored.push(slot), `/v1/finds/fp/images/${slot}`),
    likes: ["Clean, minimal clothes."], hedge: 1,
  };
  return { ctx, events, stored, generated: () => generated };
}

test("product without an image anywhere → swapped for the next verified product that has one (never generated)", async () => {
  process.env.GENITA_FIND_WEB_IMAGES = "0"; // the web search finds nothing either
  const run = productRun();
  const r = await runProduct(run.ctx);
  const created = run.events.find((e) => e.type === "find.created") as Extract<ServerEvent, { type: "find.created" }>;
  // the card went out first with the two picked products (fast), P2 without a picture
  assert.deepEqual(created.card.products!.map((p) => p.url), [P1, P2]);
  const imgs = images(run.events);
  const p1 = imgs.find((e) => e.slot === "product-1")!;
  assert.equal(p1.status, "ready");
  const p2 = imgs.find((e) => e.slot === "product-2")!;
  // old apps read the plain "failed" they already get today; new apps swap in `replace`
  assert.equal(p2.status, "failed");
  assert.equal(p2.omit, true);
  assert.equal(p2.replace?.url, P3);
  assert.equal(p2.replace?.id, "p2", "the replacement keeps the slot's id");
  assert.deepEqual(p2.replace?.image, { slot: "product-2", status: "ready", url: "/v1/finds/fp/images/product-2" });
  assert.equal(imgs.filter((e) => e.slot === "product-2").length, 1, "one event for the slot");
  assert.equal(run.generated(), 0, "a product is never a generated picture");
  // the returned card (cache / reconnect) and the stored card (runner) both carry the swap
  assert.deepEqual(r.card!.products!.map((p) => [p.url, p.image?.status]), [[P1, "ready"], [P3, "ready"]]);
  assert.equal(r.card!.sources[1].url, P3);
  const storedCard = structuredClone(created.card) as FindCard;
  for (const e of imgs) applyFindImage(storedCard, { slot: e.slot, status: e.status, ...(e.url ? { url: e.url } : {}) }, e.replace);
  assert.equal(storedCard.products![1].url, P3);
  assert.equal(storedCard.products![1].image?.status, "ready");
  wireClean(run.events);
});

test("product: no spare with a picture either → the slot is omitted (failed + omit), never a bare failed", async () => {
  process.env.GENITA_FIND_WEB_IMAGES = "0";
  const run = productRun({ p3Image: false });
  const r = await runProduct(run.ctx);
  const p2 = images(run.events).find((e) => e.slot === "product-2")!;
  assert.deepEqual(p2, { type: "find.image", findId: "fp", slot: "product-2", status: "failed", omit: true });
  assert.deepEqual(r.card!.products![1].image, { slot: "product-2", status: "failed", omit: true });
  assert.equal(r.card!.products![1].url, P2, "the product stays; only its picture box goes");
  assert.equal(run.generated(), 0);
  wireClean(run.events);
});

test("product page that can't be bought (Target 'Item not available', OutOfStock, sold out) or has no price and no picture → never on the card; the next verified product takes its place", async () => {
  // the page reader flags it from the HTML: JSON-LD availability, the page text, the title
  const ld = (a: string) => `<script type="application/ld+json">{"@type":"Product","name":"Black Midi Slip Dress","offers":{"price":"30","priceCurrency":"USD","availability":"${a}"}}</script>`;
  assert.equal(readPageFacts(`<html><head><meta property="og:type" content="product"></head><body><h2>Item not available</h2></body></html>`, P2).unavailable, true);
  assert.equal(readPageFacts(`<html><head>${ld("https://schema.org/OutOfStock")}</head></html>`, P2).unavailable, true);
  assert.equal(readPageFacts(`<html><head>${ld("Discontinued")}</head></html>`, P2).unavailable, true);
  assert.equal(readPageFacts(`<html><head><title>Sold out - Black Midi Slip Dress</title></head></html>`, P2).unavailable, true);
  const ok = readPageFacts(`<html><head>${ld("https://schema.org/InStock")}</head><body><p>Size XS sold out</p></body></html>`, P2);
  assert.equal(ok.unavailable, undefined, "a good page with one size sold out stays");
  assert.equal(ok.price, "$30");
  process.env.GENITA_FIND_WEB_IMAGES = "0";
  for (const p2Facts of [{ kind: "product", price: "$30", image: "https://cdn.example.com/2.jpg", unavailable: true }, { kind: "product" }]) {
    const run = productRun({ p2Facts });
    const r = await runProduct(run.ctx);
    const created = run.events.find((e) => e.type === "find.created") as Extract<ServerEvent, { type: "find.created" }>;
    assert.deepEqual(created.card.products!.map((p) => p.url), [P1, P3], JSON.stringify(p2Facts));
    assert.deepEqual(r.card!.products!.map((p) => [p.url, p.image?.status]), [[P1, "ready"], [P3, "ready"]]);
    wireClean(run.events);
  }
});

test("product (GENITA_FIND_IMAGE_GATE=0): as before — no swap, no omit", async () => {
  process.env.GENITA_FIND_WEB_IMAGES = "0";
  process.env.GENITA_FIND_IMAGE_GATE = "0";
  const run = productRun();
  const r = await runProduct(run.ctx);
  assert.deepEqual(images(run.events).map((e) => [e.slot, e.status]), [["product-1", "ready"]]);
  assert.deepEqual(r.card!.products!.map((p) => p.url), [P1, P2]);
  wireClean(run.events);
});

// ───────── food: Wikipedia → web → generated → omit ─────────

const RECIPE = {
  dish: "kimchi fried rice",
  minutes: 20,
  ingredients: [{ name: "cooked rice", amount: "2 cups" }, { name: "kimchi", amount: "1 cup" }],
  steps: ["Chop the kimchi.", "Fry the rice."],
  why: "Day-old rice keeps it from going mushy.",
  sources: [{ title: "Maangchi", url: "https://www.maangchi.com/recipe/kimchi-bokkeumbap" }],
};

function recipeRun(gen: (prompt: string) => Promise<Buffer>) {
  const asked = { wiki: 0, search: 0, prompts: [] as string[] };
  const events: ServerEvent[] = [];
  const ctx = {
    findId: "fr", utteranceId: 1, kind: "recipe", question: "give me a kimchi fried rice recipe", frames: [], memories: [],
    replyText: Promise.resolve(null), emit: (e: ServerEvent) => events.push(e), signal: new AbortController().signal,
    now: () => Date.now(), log: () => {}, images: true, putImage: async (slot: string) => `/v1/finds/fr/images/${slot}`,
    vendors: {
      spark: async (req: { input: unknown }) => {
        if (JSON.stringify(req.input).includes("Do one web search for")) { asked.search++; return { text: "OK", output: [] }; }
        return { text: JSON.stringify(RECIPE), output: [{ type: "web_search_call", action: { type: "search", sources: [{ url: RECIPE.sources[0].url }] } }] };
      },
      image: async (prompt: string) => { asked.prompts.push(prompt); return gen(prompt); },
      pageFacts: async () => ({}),
      productImage: async () => null,
      wikiImage: async () => { asked.wiki++; return null; },
    },
  } as unknown as PipelineCtx;
  return { ctx, events, asked };
}

test("ingredient with no image anywhere (Wikipedia, web, generation all fail) → omitted, never a bare failed", async () => {
  const run = recipeRun(async () => { throw new Error("muse down"); });
  const r = await runNamedRecipe(run.ctx);
  assert.ok(r.card);
  assert.ok(run.asked.wiki > 0, "Wikipedia was tried");
  assert.ok(run.asked.search > 0, "the web search was tried");
  assert.ok(run.asked.prompts.length > 0, "generation was tried");
  const imgs = images(run.events);
  for (const it of r.card!.items) {
    const e = imgs.find((x) => x.slot === `ingredient-${it.id}`);
    assert.deepEqual(e, { type: "find.image", findId: "fr", slot: `ingredient-${it.id}`, status: "failed", omit: true }, it.name);
  }
  assert.ok(imgs.every((e) => e.omit === true), "every empty slot (hero, steps too) is an explicit omit");
  assert.ok(!r.card!.items.some((i) => i.image), "the item itself carries no failed picture");
  wireClean(run.events);
});

test("mocked generator: nothing found on the web → a generated picture, marked source generated, prompt from the slot", async () => {
  const run = recipeRun(async (p) => Buffer.from(`png:${p}`));
  const r = await runNamedRecipe(run.ctx);
  const imgs = images(run.events);
  const kimchi = r.card!.items.find((i) => i.name.startsWith("kimchi"))!;
  const e = imgs.find((x) => x.slot === `ingredient-${kimchi.id}`)!;
  assert.deepEqual(e, { type: "find.image", findId: "fr", slot: `ingredient-${kimchi.id}`, status: "ready", url: `/v1/finds/fr/images/ingredient-${kimchi.id}`, source: "generated" });
  assert.ok(run.asked.prompts.includes(genPrompt("ingredient", kimchi.name)));
  assert.match(genPrompt("ingredient", "kimchi · 1 cup"), /^Overhead photo of kimchi on a cutting board, natural light\./);
  // hero (the dish) and both steps too: every slot ready, no omit
  assert.deepEqual(imgs.map((x) => x.slot).sort(), ["hero", ...r.card!.items.map((i) => `ingredient-${i.id}`), "step-1", "step-2"].sort());
  assert.ok(imgs.every((x) => x.status === "ready" && x.source === "generated"));
  wireClean(run.events);
});

test("GENITA_FIND_IMAGE_GEN=0: no generation — the empty slots are omitted", async () => {
  process.env.GENITA_FIND_IMAGE_GEN = "0";
  const run = recipeRun(async () => Buffer.from("png"));
  await runNamedRecipe(run.ctx);
  assert.equal(run.asked.prompts.length, 0);
  assert.ok(images(run.events).length > 0 && images(run.events).every((e) => e.omit === true));
  wireClean(run.events);
});

test("GENITA_FIND_IMAGE_GATE=0: no generation, no omit (as before: an empty slot sends nothing)", async () => {
  process.env.GENITA_FIND_IMAGE_GATE = "0";
  const run = recipeRun(async () => Buffer.from("png"));
  await runNamedRecipe(run.ctx);
  assert.equal(run.asked.prompts.length, 0);
  assert.equal(images(run.events).length, 0);
});

// ───────── general / places ─────────

function rowsRun(layout: "place" | "general") {
  const prompts: string[] = [];
  const events: ServerEvent[] = [];
  const v = {
    spark: async () => ({ text: "OK", output: [] }),
    image: async (p: string) => (prompts.push(p), Buffer.from("png")),
    pageFacts: async () => ({}),
    productImage: async () => null,
  } as unknown as FindsVendors;
  const ctx = { findId: "fg", vendors: v, signal: new AbortController().signal, emit: (e: ServerEvent) => events.push(e), log: () => {}, putImage: async (s: string) => `/u/${s}`, images: true };
  return { run: () => rowPictures(ctx, [{ title: "Menya Seoul", url: "https://a.example/" }, { title: "Ramen House", url: "https://b.example/" }], { layout, topic: "Ramen in Seoul" }), events, prompts };
}

test("a real place never gets a made-up picture or a stand-in: rows and hero are omitted", async () => {
  const r = rowsRun("place");
  await r.run();
  assert.equal(r.prompts.length, 0);
  assert.deepEqual(images(r.events).map((e) => [e.slot, e.status, e.omit]).sort(), [["hero", "failed", true], ["source-0", "failed", true], ["source-1", "failed", true]]);
  wireClean(r.events);
});

test("a general card with no picture at all: a generated hero, the rows take it as a stand-in", async () => {
  const r = rowsRun("general");
  await r.run();
  assert.deepEqual(r.prompts, [genPrompt("general", "Ramen in Seoul")]);
  const imgs = images(r.events);
  assert.deepEqual(imgs.map((e) => e.slot).sort(), ["hero", "source-0", "source-1"]);
  assert.ok(imgs.every((e) => e.status === "ready" && e.source === "generated"));
  wireClean(r.events);
});

// ───────── the generator: cached by prompt, ≤ 4 at once ─────────

test("generatePicture: cached by prompt; never more than 4 at once", async () => {
  let running = 0;
  let peak = 0;
  let calls = 0;
  const v = {
    image: async () => {
      calls++;
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return Buffer.from("png");
    },
  } as unknown as FindsVendors;
  const signal = new AbortController().signal;
  const out = await Promise.all(Array.from({ length: 10 }, (_, i) => generatePicture(v, `prompt ${i}`, signal)));
  assert.ok(out.every((b) => b?.toString() === "png"));
  assert.equal(peak, GEN_PARALLEL);
  assert.equal(calls, 10);
  await generatePicture(v, "prompt 3", signal);
  assert.equal(calls, 10, "the same prompt again is a cache hit");
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await generatePicture(v, "prompt new", stopped.signal), null);
});
