/**
 * Visual everything (Chelsea 11/4 21:09): every Finds card is visual. A picture for any row comes from the web
 * (one Spark web search → the first returned page whose og:image loads), re-hosted like product photos, cached,
 * time-boxed; only `ready` pictures ever go on the wire (no pending / failed slot = no empty grey square).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearWebImageCache, findWebImage, ingredientLookups, ingredientQuery, isJunkImageUrl, stepQuery } from "../src/finds/imageFinder.ts";
import { firstContentImage } from "../src/finds/fetchPage.ts";
import { runNamedRecipe } from "../src/finds/namedRecipe.ts";
import { generalLayout, placeFields, runGeneral } from "../src/finds/general.ts";
import { applyFindImage } from "../src/finds/runner.ts";
import { toWire, Candidates } from "../src/finds/tiers.ts";
import type { PipelineCtx } from "../src/finds/pipeline.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";
import type { FindCard, ServerEvent } from "../src/protocol.ts";

beforeEach(() => clearWebImageCache());

const searchOut = (...urls: string[]) => [{ type: "web_search_call", action: { type: "search", sources: urls.map((url) => ({ url })) } }];

function vendors(o: { pages?: Record<string, string | null>; spark?: FindsVendors["spark"]; calls?: { spark: number } } = {}): FindsVendors {
  const pages = o.pages ?? {};
  return {
    spark: o.spark ?? (async (req) => {
      if (o.calls) o.calls.spark++;
      const q = JSON.stringify(req.input);
      const slug = (q.match(/for: \\"([^\\]+)\\"/)?.[1] ?? "x").replace(/\s+/g, "-");
      return { text: "OK", output: searchOut(`https://site.example/${slug}`, `https://other.example/${slug}`) };
    }),
    sparkStream: async function* () {},
    sam: async () => [],
    image: async () => { throw new Error("no generation in these tests"); },
    pageFacts: async (url) => (url in pages ? (pages[url] ? { kind: "unknown", image: pages[url]! } : { kind: "unknown" }) : { kind: "unknown", image: `${url}/og.jpg` }),
    productImage: async (url) => (url.includes("broken") ? null : Buffer.from(`img:${url}`)),
  } as FindsVendors;
}

test("queries: ingredient drops the amount; a step keeps the dish and its verb + object", () => {
  assert.equal(ingredientQuery("cooked rice · 2 cups"), "cooked rice ingredient");
  assert.equal(ingredientQuery("Kimchi"), "kimchi ingredient");
  assert.equal(stepQuery("kimchi fried rice", "Fry the kimchi in oil for 3 minutes."), "kimchi fried rice fry kimchi oil");
  assert.equal(stepQuery("bibimbap", "Top with a fried egg."), "bibimbap top fried egg");
});

test("findWebImage: the first returned page with a loadable og:image; logos are skipped", async () => {
  const v = vendors({ pages: { "https://site.example/kimchi-ingredient": "https://site.example/logo.png" } });
  const b = await findWebImage(v, "kimchi ingredient", new AbortController().signal);
  assert.equal(b?.toString(), "img:https://other.example/kimchi-ingredient/og.jpg");
  assert.equal(isJunkImageUrl("https://x.com/assets/favicon-32.png"), true);
  assert.equal(isJunkImageUrl("https://x.com/images/kimchi.jpg"), false);
});

test("findWebImage: cached — the same query twice is one search", async () => {
  const calls = { spark: 0 };
  const v = vendors({ calls });
  const [a, b] = await Promise.all([findWebImage(v, "egg ingredient", new AbortController().signal), findWebImage(v, "Egg  ingredient", new AbortController().signal)]);
  const c = await findWebImage(v, "egg ingredient", new AbortController().signal);
  assert.ok(a && b && c);
  assert.equal(calls.spark, 1);
});

test("findWebImage: nothing found or over budget → null (never throws)", async () => {
  const none = vendors({ spark: async () => ({ text: "OK", output: [] }) });
  assert.equal(await findWebImage(none, "nothing", new AbortController().signal), null);
  const slow = vendors({ spark: () => new Promise((r) => setTimeout(() => r({ text: "OK", output: searchOut("https://a.example/x") }), 400)) });
  assert.equal(await findWebImage(slow, "slow one", new AbortController().signal, { budgetMs: 50 }), null);
  const noPages = vendors({ pages: { "https://site.example/plain": null, "https://other.example/plain": null } });
  assert.equal(await findWebImage(noPages, "plain", new AbortController().signal), null);
});

const RECIPE = {
  dish: "kimchi fried rice",
  minutes: 20,
  ingredients: [{ name: "cooked rice", amount: "2 cups" }, { name: "kimchi", amount: "1 cup" }, { name: "egg", amount: "1" }],
  steps: ["Chop the kimchi.", "Fry the kimchi in oil for 3 minutes.", "Top with a fried egg."],
  sources: [{ title: "Kimchi fried rice", url: "https://www.maangchi.com/recipe/kimchi-bokkeumbap" }],
  ask: [],
};

function namedCtx(events: ServerEvent[], v: FindsVendors): PipelineCtx {
  return {
    findId: "f-named", utteranceId: 1, kind: "recipe", question: "give me a kimchi fried rice recipe", frames: [], memories: [],
    replyText: Promise.resolve(null), emit: (e: ServerEvent) => events.push(e), signal: new AbortController().signal,
    now: () => Date.now(), log: () => {}, images: true, putImage: async (slot: string) => `/v1/finds/f-named/images/${slot}`, vendors: v,
  } as unknown as PipelineCtx;
}

test("named recipe: layout recipe; every ingredient and step gets a ready photo by its slot; never pending/failed", async () => {
  const events: ServerEvent[] = [];
  const base = vendors({ pages: { "https://www.maangchi.com/recipe/kimchi-bokkeumbap": null } });
  const v = { ...base, spark: async (req: Parameters<FindsVendors["spark"]>[0]) => (JSON.stringify(req.input).includes("asks for a recipe") ? { text: JSON.stringify(RECIPE), output: searchOut(RECIPE.sources[0].url) } : base.spark(req)) } as FindsVendors;
  const r = await runNamedRecipe(namedCtx(events, v));
  assert.equal(r.card?.layout, "recipe");
  const imgs = events.filter((e) => e.type === "find.image") as Extract<ServerEvent, { type: "find.image" }>[];
  assert.ok(imgs.every((e) => e.status === "ready" && e.url));
  const slots = imgs.map((e) => e.slot).sort();
  assert.deepEqual(slots, ["hero", "ingredient-ing-1", "ingredient-ing-2", "ingredient-ing-3", "step-1", "step-2", "step-3"]);
  // no og:image on the recipe page → the hero came from the finder ("<dish>"); the runner keeps each on its row
  const stored = structuredClone(r.card!);
  for (const e of imgs) applyFindImage(stored, { slot: e.slot, status: e.status, url: e.url });
  assert.ok(stored.items.every((i) => i.image?.status === "ready"));
  assert.ok(stored.steps.every((s) => s.image?.status === "ready"));
  assert.equal(stored.hero?.status, "ready");
});

test("named recipe (GENITA_FIND_IMAGE_GATE=0): a step with no picture found gets no slot at all", async () => {
  const events: ServerEvent[] = [];
  const base = vendors();
  const v = {
    ...base,
    spark: async (req: Parameters<FindsVendors["spark"]>[0]) => {
      const q = JSON.stringify(req.input);
      if (q.includes("asks for a recipe")) return { text: JSON.stringify(RECIPE), output: searchOut(RECIPE.sources[0].url) };
      if (q.includes("top fried egg")) return { text: "OK", output: [] };
      return base.spark(req);
    },
  } as FindsVendors;
  process.env.GENITA_FIND_IMAGE_GATE = "0";
  await runNamedRecipe(namedCtx(events, v)).finally(() => delete process.env.GENITA_FIND_IMAGE_GATE);
  const slots = (events.filter((e) => e.type === "find.image") as { slot: string }[]).map((e) => e.slot);
  assert.ok(slots.includes("step-2"));
  assert.ok(!slots.includes("step-3"));
  assert.ok(!events.some((e) => e.type === "find.image" && e.status !== "ready"));
});

test("general layout: places, how-to, else general", () => {
  assert.equal(generalLayout("best ramen near Gangnam station"), "place");
  assert.equal(generalLayout("good cafes in Seongsu"), "place");
  assert.equal(generalLayout("how do I tie a tie"), "how-to");
  assert.equal(generalLayout("how to fix a leaky faucet"), "how-to");
  assert.equal(generalLayout("who won the world series"), "general");
});

test("place fields: only what the search said; rating 0–5; the map link is built from name + address", () => {
  const p = placeFields("Menya Sandaime", { address: "12 Gangnam-daero, Seoul", rating: 4.6, reviews: "1,234", hours: "11:00–21:00" })!;
  assert.equal(p.address, "12 Gangnam-daero, Seoul");
  assert.equal(p.rating, 4.6);
  assert.equal(p.reviews, 1234);
  assert.equal(p.hours, "11:00–21:00");
  assert.equal(p.mapUrl, "https://maps.apple.com/?q=Menya%20Sandaime%2C%2012%20Gangnam-daero%2C%20Seoul");
  const q = placeFields("Cafe X", { rating: 9 })!;
  assert.equal(q.rating, undefined);
  assert.equal(q.mapUrl, "https://maps.apple.com/?q=Cafe%20X");
});

function generalCtx(question: string, events: ServerEvent[], v: FindsVendors): PipelineCtx {
  return {
    findId: "f-gen", utteranceId: 1, kind: "answer", question, frames: [], memories: [],
    replyText: Promise.resolve(null), emit: (e: ServerEvent) => events.push(e), signal: new AbortController().signal,
    now: () => Date.now(), log: () => {}, images: true, putImage: async (slot: string) => `/v1/finds/f-gen/images/${slot}`, vendors: v,
  } as unknown as PipelineCtx;
}

test("general: a result whose page has no og:image still gets a ready picture from the finder; place rows carry place", async () => {
  const events: ServerEvent[] = [];
  const base = vendors({ pages: { "https://menya.example/": null } });
  const answer = {
    title: "Ramen near Gangnam",
    results: [
      { title: "Menya Sandaime", why: "Rich tonkotsu, short line.", url: "https://menya.example/", address: "12 Gangnam-daero, Seoul", rating: 4.6, reviews: 320 },
      { title: "Ramen Ya", why: "Late-night bowls.", url: "https://ramenya.example/" },
    ],
    ask: [],
  };
  const v = { ...base, spark: async (req: Parameters<FindsVendors["spark"]>[0]) => (JSON.stringify(req.input).includes("pick the best pages") ? { text: JSON.stringify(answer), output: searchOut("https://menya.example/", "https://ramenya.example/") } : base.spark(req)) } as FindsVendors;
  const r = await runGeneral(generalCtx("best ramen near Gangnam", events, v));
  assert.equal(r.card?.layout, "place");
  assert.equal(r.card?.sources[0].place?.rating, 4.6);
  assert.ok(r.card?.sources[0].place?.mapUrl?.startsWith("https://maps.apple.com/?q="));
  const created = events.find((e) => e.type === "find.created") as Extract<ServerEvent, { type: "find.created" }>;
  assert.ok(created.card.sources.every((s) => !s.image), "no pending picture on the card");
  const imgs = events.filter((e) => e.type === "find.image") as Extract<ServerEvent, { type: "find.image" }>[];
  assert.ok(imgs.every((e) => e.status === "ready"));
  assert.deepEqual(imgs.map((e) => e.slot).sort(), ["hero", "source-0", "source-1"]);
});

test("general how-to: real steps on the card, each with a step-N photo when one is found", async () => {
  const events: ServerEvent[] = [];
  const base = vendors();
  const answer = {
    title: "Tie a tie",
    results: [{ title: "Four-in-hand knot", why: "The easiest knot.", url: "https://ties.example/four" }],
    steps: ["Drape the tie around your neck.", "Cross the wide end over the narrow end.", "Pull it through the loop."],
    ask: [],
  };
  const v = { ...base, spark: async (req: Parameters<FindsVendors["spark"]>[0]) => (JSON.stringify(req.input).includes("pick the best pages") ? { text: JSON.stringify(answer), output: searchOut("https://ties.example/four") } : base.spark(req)) } as FindsVendors;
  const r = await runGeneral(generalCtx("how do I tie a tie", events, v));
  assert.equal(r.card?.layout, "how-to");
  assert.deepEqual(r.card?.steps.map((s) => s.text), answer.steps);
  const slots = (events.filter((e) => e.type === "find.image") as { slot: string }[]).map((e) => e.slot);
  assert.ok(["step-1", "step-2", "step-3"].every((s) => slots.includes(s)));
});

test("runner: find.image ingredient-<id> lands on that item (by id, not position)", () => {
  const card = { items: [{ id: "i2", name: "egg", tier: "have", from: "camera" }, { id: "ing-1", name: "rice", tier: "buy", from: "recipe" }], steps: [], sources: [] } as unknown as FindCard;
  applyFindImage(card, { slot: "ingredient-ing-1", status: "ready", url: "/u" });
  assert.equal(card.items[1].image?.url, "/u");
  assert.equal(card.items[0].image, undefined);
});

test("fridge re-sends keep an ingredient's photo (toWire carries the candidate's image)", () => {
  const c = new Candidates();
  const cand = c.add("kimchi", { recipe: true })!;
  cand.image = { slot: `ingredient-${cand.id}`, status: "ready", url: "/k" };
  assert.equal(toWire(c.all())[0].image?.url, "/k");
});

// ───────── P0 11/4 device (named recipe on 2864c878): every ingredient tile was an initial-letter placeholder ─────────

const DEVICE_7 = ["doenjang · 2 tbsp", "tofu · 1 block", "zucchini", "potato · 1", "onion", "garlic · 3 cloves", "anchovy stock · 4 cups"];

test("the 7 ingredients from the device shot: 7/7 get a photo (Wikipedia first; 'anchovy stock' → 'anchovy')", async () => {
  const wikiAsked: string[] = [];
  const known = new Set(["doenjang", "tofu", "zucchini", "potato", "onion", "garlic", "anchovy"]);
  let searches = 0;
  const v = {
    ...vendors(),
    spark: async () => { searches++; return { text: "OK", output: [] }; },
    wikiImage: async (t: string) => { wikiAsked.push(t); return known.has(t) ? `https://upload.wikimedia.org/x/${t}.jpg` : null; },
  } as FindsVendors;
  const t0 = Date.now();
  const got = await Promise.all(DEVICE_7.map((n) => findWebImage(v, ingredientLookups(n).query, new AbortController().signal, ingredientLookups(n))));
  assert.equal(got.filter(Boolean).length, 7, "hit rate 7/7");
  assert.equal(got[6]?.toString(), "img:https://upload.wikimedia.org/x/anchovy.jpg");
  assert.equal(searches, 0, "no web search needed when Wikipedia has it");
  assert.ok(Date.now() - t0 < 4000);
  assert.deepEqual(ingredientLookups("anchovy stock · 4 cups"), { query: "anchovy stock ingredient", wiki: ["anchovy stock", "stock", "anchovy"], variants: ["anchovy stock food", "anchovy stock"] });
});

test("no Wikipedia picture: the web search; its pages' og:image, else the first content <img> in the page", async () => {
  const v = {
    ...vendors({ pages: { "https://site.example/doenjang-ingredient": null, "https://other.example/doenjang-ingredient": null } }),
    pageFacts: async (url: string) => (url.includes("other.example") ? { kind: "unknown", inPageImage: "https://other.example/doenjang.jpg" } : { kind: "unknown" }),
    wikiImage: async () => null,
  } as FindsVendors;
  const b = await findWebImage(v, "doenjang ingredient", new AbortController().signal, ingredientLookups("doenjang"));
  assert.equal(b?.toString(), "img:https://other.example/doenjang.jpg");
});

test("first search finds nothing → '<x> food' and '<x>' are tried", async () => {
  const asked: string[] = [];
  const base = vendors();
  const v = {
    ...base,
    wikiImage: async () => null,
    spark: async (req: Parameters<FindsVendors["spark"]>[0]) => {
      const q = JSON.stringify(req.input).match(/for: \\"([^\\]+)\\"/)?.[1] ?? "";
      asked.push(q);
      return q === "tofu food" ? base.spark(req) : { text: "OK", output: [] };
    },
  } as FindsVendors;
  const b = await findWebImage(v, "tofu ingredient", new AbortController().signal, ingredientLookups("tofu"));
  assert.ok(b);
  assert.deepEqual(asked.sort(), ["tofu", "tofu food", "tofu ingredient"]);
});

test("firstContentImage: alt text or a large raster picture; never logos, icons, svg, gif or tiny ones", () => {
  const abs = (v?: string) => (v ? new URL(v, "https://p.example/a/").toString() : undefined);
  const html = `<html><head></head><body>
    <img src="/logo.png" alt="Site"><img src="/i/spinner.gif" alt="x"><img src="/i/a.svg" alt="y">
    <img src="/i/small.jpg" width="40" height="40" alt="thumb"><img src="/i/noalt.jpg">
    <img data-src="/i/doenjang-paste.jpg" src="data:image/gif;base64,R0" alt="Doenjang paste in a bowl"></body></html>`;
  assert.equal(firstContentImage(html, abs), "https://p.example/i/doenjang-paste.jpg");
  assert.equal(firstContentImage(`<body><img src="/big.webp" width="800" height="600"></body>`, abs), "https://p.example/big.webp");
  assert.equal(firstContentImage(`<body><img src="/x.jpg"></body>`, abs), undefined);
});

test("server-wide search cap: never more than GENITA_FIND_WEB_IMAGE_SEARCHES searches in flight", async () => {
  process.env.GENITA_FIND_WEB_IMAGE_SEARCHES = "2";
  try {
    let inFlight = 0;
    let peak = 0;
    const base = vendors();
    const v = { ...base, spark: async (req: Parameters<FindsVendors["spark"]>[0]) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; return base.spark(req); } } as FindsVendors;
    const got = await Promise.all(["a1", "a2", "a3", "a4", "a5"].map((q) => findWebImage(v, q, new AbortController().signal)));
    assert.equal(got.filter(Boolean).length, 5);
    assert.ok(peak >= 1 && peak <= 2, `peak ${peak}`);
  } finally {
    delete process.env.GENITA_FIND_WEB_IMAGE_SEARCHES;
  }
});

test("layout on every web card: link → general, spoken-answer card → general", async () => {
  const { webAnswerCard } = await import("../src/finds/webAnswer.ts");
  const card = webAnswerCard({ id: "w1", question: "who won the world series", said: "The Dodgers won it.", searches: [{ query: "world series winner", urls: ["https://www.mlb.com/news/world-series"] }] });
  assert.equal(card?.layout, "general");
});

test("rowPictures: row 0 without any picture → hero is the next row's picture (never a text-only card)", async () => {
  const { rowPictures } = await import("../src/finds/general.ts");
  const events: ServerEvent[] = [];
  const v = { ...vendors({ pages: { "https://a.example/": null, "https://b.example/": "https://b.example/b.jpg" } }), spark: async () => ({ text: "OK", output: [] }) } as FindsVendors;
  await rowPictures({ findId: "r1", vendors: v, signal: new AbortController().signal, emit: (e) => events.push(e), log: () => {}, putImage: async (s) => `/u/${s}` }, [{ title: "A", url: "https://a.example/" }, { title: "B", url: "https://b.example/" }]);
  const imgs = events as Extract<ServerEvent, { type: "find.image" }>[];
  assert.deepEqual(imgs.map((e) => e.slot).sort(), ["hero", "source-0", "source-1"]);
  // no empty pictures: row 0 (nothing found) takes the hero as a stand-in
  assert.ok(imgs.every((e) => e.status === "ready" && !e.source));
});

test("over budget or already stopped: no further paid search starts (Codex P2)", async () => {
  const asked: string[] = [];
  const v = {
    ...vendors(),
    spark: async (req: Parameters<FindsVendors["spark"]>[0]) => { asked.push(JSON.stringify(req.input)); await new Promise((r) => setTimeout(r, 60)); return { text: "OK", output: [] }; },
  } as FindsVendors;
  assert.equal(await findWebImage(v, "late one", new AbortController().signal, { budgetMs: 20, variants: ["late one food", "late one"] }), null);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(asked.length, 1, "the variants never start after the budget");
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await findWebImage(v, "never", stopped.signal), null);
  assert.equal(asked.length, 1, "an already-stopped call searches nothing");
});
