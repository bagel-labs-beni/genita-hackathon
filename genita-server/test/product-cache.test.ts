/**
 * S5 product cache (11/4): a card for "dark brown shoes" with this taste shows at once from the cache (warmed at
 * call start, or from an earlier search); colors must be proven; Spark searches share a server-wide slot limit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import { clearProductCache } from "../src/finds/productCache.ts";
import { hedgedSearch, searchSlotsUsed } from "../src/finds/product.ts";
import type { FindsVendors, OutputItem } from "../src/finds/vendors.ts";
import type { FindCard, ServerEvent } from "../src/protocol.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OPEN = (url: string): OutputItem => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url } });
const PROFILE = "How the user wants to be treated:\n- Taste: Clean, minimal clothes; black, camel, dark brown.\n- Taste: Leather accessories.";

function vendors(searchMs = 30) {
  const searches: string[] = [];
  const v: FindsVendors = {
    async spark(req) {
      const p = JSON.stringify(req.input);
      searches.push(p);
      await sleep(searchMs);
      const color = /dark brown/.test(p) ? "Dark Brown" : /black/i.test(p) && !/brown/.test(p) ? "Black" : /camel/.test(p) ? "Camel" : "Brown";
      const u1 = `https://shop.example.com/products/${color.toLowerCase().replace(" ", "-")}-boot-1`;
      const u2 = `https://store.example.com/product/${color.toLowerCase().replace(" ", "-")}-loafer-2.html`;
      return {
        text: JSON.stringify({ label: "Shoes", title: "Two for tonight", style_line: "Black, camel, dark brown.", situation_line: "Halloween party tonight", items: [
          { name: `${color} Chelsea Boot`, url: u1, store: "Shop", price: "$90", taste: "Clean, minimal", situation: "Halloween night" },
          { name: `${color} Penny Loafer`, url: u2, store: "Store", price: "", taste: "Leather", situation: "Halloween night" },
        ], say: "Two, both clean." }),
        output: [OPEN(u1), OPEN(u2)],
      };
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return []; },
    async image() { return Buffer.from([0xff, 0xd8]); },
    async pageFacts() { return { kind: "product" as const, image: "https://cdn.example.com/1.jpg" }; },
    async productImage() { return Buffer.from([0xff, 0xd8, 0xff]); },
  };
  return { v, searches };
}

function runner(v: FindsVendors, owner = "acct", profile = PROFILE) {
  const events: ServerEvent[] = [];
  const store = new MemoryFindsStore();
  const r = new FindsRunner({ vendors: v, store, images: true, imageBase: "/v1/finds", productHedge: 1, productCache: true }, { emit: (e) => events.push(e), announce: () => {}, log: () => {}, now: () => performance.now() });
  r.configure({ owner, memories: [], profile });
  return { r, events, store };
}

test("S5 cache: warmed at call start (shoes in each liked color); 'dark brown shoes' then shows at once, with no search in front of it", async () => {
  clearProductCache();
  const { v, searches } = vendors(30);
  const { r, events } = runner(v);
  await sleep(200); // the warm-up: black, camel, dark brown (at once)
  const warm = searches.length;
  assert.ok(warm >= 3, `warm searches ${warm}`);
  const t0 = performance.now();
  const started = r.onTurn({ text: "Can you find me some dark brown shoes that go with this?", frames: [], utteranceId: 2, replyText: Promise.resolve(null) });
  assert.equal(started?.kind, "product");
  await sleep(5);
  const created = events.find((e) => e.type === "find.created" && e.findId === started!.findId) as Extract<ServerEvent, { type: "find.created" }> | undefined;
  assert.ok(created && performance.now() - t0 < 200, "the card is there at once");
  assert.deepEqual(created!.card.products!.map((p) => p.name), ["Dark Brown Chelsea Boot", "Dark Brown Penny Loafer"]);
  assert.ok(created!.card.products!.every((p) => p.situation === ""), "another call's situation never travels");
  assert.equal(created!.card.id, started!.findId);
  await r.settle(); await sleep(100);
  assert.equal(searches.length, warm + 1, "one refresh search behind it, for next time");
  r.close();
});

test("S5 cache: an ask whose color the cached picks don't prove, or a different taste, searches as before", async () => {
  clearProductCache();
  const { v, searches } = vendors(10);
  const a = runner(v);
  await sleep(200);
  const before = searches.length;
  a.r.onTurn({ text: "Find me some navy shoes", frames: [], utteranceId: 2, replyText: Promise.resolve(null) });
  await a.r.settle();
  assert.ok(searches.length > before, "navy is not in the cache: a real search");
  const b = runner(v, "other", "How the user wants to be treated:\n- Taste: Bright colors, sneakers.");
  await sleep(50);
  const n = searches.length;
  const s = b.r.onTurn({ text: "Can you find me some dark brown shoes?", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  await sleep(5);
  assert.ok(!b.events.some((e) => e.type === "find.created" && e.findId === s!.findId), "another taste: no card from A's cache");
  await b.r.settle();
  assert.ok(searches.length > n);
  a.r.close(); b.r.close();
});

test("S5 cache: the same taste on another account (a second demo account) gets the cached card", async () => {
  clearProductCache();
  const { v } = vendors(10);
  const a = runner(v, "demo-1");
  await sleep(200);
  const b = runner(v, "demo-2");
  const s = b.r.onTurn({ text: "Can you find me some dark brown shoes?", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  await sleep(5);
  const created = b.events.find((e) => e.type === "find.created" && e.findId === s!.findId) as { card: FindCard } | undefined;
  assert.ok(created, "identical import: cached card");
  a.r.close(); b.r.close();
});

test("Spark search slots: never more than GENITA_SPARK_SEARCH_MAX in flight across searches; extra lanes only when free", async (t) => {
  const prev = process.env.GENITA_SPARK_SEARCH_MAX;
  process.env.GENITA_SPARK_SEARCH_MAX = "3";
  t.after(() => { if (prev === undefined) delete process.env.GENITA_SPARK_SEARCH_MAX; else process.env.GENITA_SPARK_SEARCH_MAX = prev; });
  let inFlight = 0, peak = 0;
  const v = { async spark() { inFlight++; peak = Math.max(peak, inFlight); await sleep(30); inFlight--; return { text: "{}", output: [] }; } } as unknown as FindsVendors;
  const ac = new AbortController();
  await Promise.all(Array.from({ length: 4 }, () => hedgedSearch(v, "p", 3, ac.signal)));
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.equal(searchSlotsUsed(), 0, "every slot handed back");
});

test("cardFitsColors: a plain name stands for the color it was searched for; another color never does", async () => {
  const { cardFitsColors } = await import("../src/finds/productCache.ts");
  const card = (names: string[]) => ({ products: names.map((name) => ({ name, taste: "", situation: "" })) }) as unknown as FindCard;
  assert.equal(cardFitsColors(card(["Highwood Chelsea Boot", "Lando Brown Loafer"]), ["brown"]), true);
  assert.equal(cardFitsColors(card(["Black Chelsea Boot", "Brown Loafer"]), ["brown"]), false);
  assert.equal(cardFitsColors(card([]), ["brown"]), false);
});
