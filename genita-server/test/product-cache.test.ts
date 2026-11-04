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

test("S5 cache (Codex #522 r3 P1): another account never gets this account's card, even with the identical import", async () => {
  clearProductCache();
  const { v } = vendors(10);
  const a = runner(v, "demo-1");
  await sleep(200);
  const b = runner(v, "demo-2");
  await sleep(1); // b's own warm-up has started, not finished
  const s = b.r.onTurn({ text: "Can you find me some dark brown shoes?", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  await sleep(1);
  assert.ok(!b.events.some((e) => e.type === "find.created" && e.findId === s!.findId), "a's card (its chips can quote a's memories) stays a's");
  await b.r.settle();
  a.r.close(); b.r.close();
});

test("Codex #522 r3: other things named, unknown-kind products, shades and unknown colors, pictures from a background search", async () => {
  const { categoryOf, cardIsKind, colorPhrases } = await import("../src/finds/productCache.ts");
  for (const ask of ["Find black shoes and a black blazer", "Find black shoes and a parka", "black boots and a cardigan"]) assert.equal(categoryOf(ask), null, ask);
  assert.equal(categoryOf("Find me black boots"), "boots");
  const card = (names: string[]) => ({ products: names.map((name) => ({ name, taste: "", situation: "" })) }) as unknown as FindCard;
  assert.equal(cardIsKind(card(["Black Chelsea Boot", "Black Leather Belt"]), "shoes"), false, "a belt never sits in the shoes cache");
  assert.equal(cardIsKind(card(["Black Chelsea Boot", "Samba OG"]), "shoes"), false, "a product of no known kind never passes");
  assert.notDeepEqual(colorPhrases("dark brown shoes"), colorPhrases("light brown shoes"));
  assert.deepEqual(colorPhrases("Find me some dark brown shoes"), ["dark brown"]);
  const { plainAsk } = await import("../src/finds/productCache.ts");
  assert.equal(plainAsk("Can you find me some dark brown shoes that go with this?"), true);
  assert.equal(plainAsk("Find black running shoes"), false, "running narrows it (Codex #522 r5)");
  assert.equal(plainAsk("Find black shoes for a wedding"), false);
  // an ask with no known color ("aqua") is never served from the cache
  clearProductCache();
  const { v, searches } = vendors(10);
  const a = runner(v);
  await sleep(200);
  const before = searches.length;
  const s = a.r.onTurn({ text: "Find me some aqua shoes", frames: [], utteranceId: 2, replyText: Promise.resolve(null) });
  await sleep(5);
  assert.ok(!a.events.some((e) => e.type === "find.created" && e.findId === s!.findId));
  await a.r.settle();
  assert.ok(searches.length > before);
  // the warm-up's pictures (kept in memory, no image events) show on the replayed card
  const hit = a.r.onTurn({ text: "Can you find me some dark brown shoes?", frames: [], utteranceId: 3, replyText: Promise.resolve(null) });
  await sleep(20);
  const created = a.events.find((e) => e.type === "find.created" && e.findId === hit!.findId) as { card: FindCard } | undefined;
  assert.ok(created);
  assert.ok(created!.card.products!.every((p) => !p.image || p.image.status !== "pending"), JSON.stringify(created!.card.products!.map((p) => p.image)));
  await a.r.settle();
  a.r.close();
});

test("S5 cache (Codex #522 r5 P1): a search whose profile changed while it ran is not cached", async () => {
  clearProductCache();
  const { v } = vendors(40);
  const { r, events } = runner(v, "acct-x", "");   // no profile: no warm-up
  r.onTurn({ text: "Find me some black shoes", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  await sleep(5);
  r.configure({ owner: "acct-x", memories: [], profile: "How the user wants to be treated:\n- Taste: Navy and grey, suede." }); // its warm-up: navy / grey only
  await r.settle();
  await sleep(20);
  const s = r.onTurn({ text: "Find me some black shoes", frames: [], utteranceId: 2, replyText: Promise.resolve(null) });
  await sleep(5);
  assert.ok(!events.some((e) => e.type === "find.created" && e.findId === s!.findId), "nothing cached under the new taste");
  await r.settle();
  r.close();
});

test("S5 cache (Codex #522 r6 P1): DELETE /me takes the account's cached cards and warm-ups, and nothing is cached for it again", async () => {
  clearProductCache();
  const { forgetProductCache } = await import("../src/finds/productCache.ts");
  const { ownerKey } = await import("../src/finds/store.ts");
  const { v } = vendors(10);
  const a = runner(v, "acct-del");
  await sleep(200); // warmed
  forgetProductCache(ownerKey("acct-del"));
  const s = a.r.onTurn({ text: "Can you find me some dark brown shoes?", frames: [], utteranceId: 2, replyText: Promise.resolve(null) });
  await sleep(5);
  assert.ok(!a.events.some((e) => e.type === "find.created" && e.findId === s!.findId), "the warmed card is gone");
  await a.r.settle(); await sleep(50);
  const again = a.r.onTurn({ text: "Can you find me some dark brown shoes?", frames: [], utteranceId: 3, replyText: Promise.resolve(null) });
  await sleep(5);
  assert.ok(!a.events.some((e) => e.type === "find.created" && e.findId === again!.findId), "a search finishing after the delete is not cached");
  await a.r.settle();
  a.r.close();
});

test("Spark search slots (Codex #522 r3): with a limit of 1 a background search gives up at once instead of waiting forever", async (t) => {
  const prev = process.env.GENITA_SPARK_SEARCH_MAX;
  process.env.GENITA_SPARK_SEARCH_MAX = "1";
  t.after(() => { if (prev === undefined) delete process.env.GENITA_SPARK_SEARCH_MAX; else process.env.GENITA_SPARK_SEARCH_MAX = prev; });
  let calls = 0;
  const v = { async spark() { calls++; return { text: "{}", output: [] }; } } as unknown as FindsVendors;
  const r = await hedgedSearch(v, "p", 1, new AbortController().signal, [], { background: true });
  assert.equal(r, null);
  assert.equal(calls, 0);
  assert.equal(searchSlotsUsed(), 0);
});

test("Spark search slots (Codex #522 r4): a limit of 2 lets one background search run beside a call's", async (t) => {
  const prev = process.env.GENITA_SPARK_SEARCH_MAX;
  process.env.GENITA_SPARK_SEARCH_MAX = "2";
  t.after(() => { if (prev === undefined) delete process.env.GENITA_SPARK_SEARCH_MAX; else process.env.GENITA_SPARK_SEARCH_MAX = prev; });
  let inFlight = 0, peak = 0;
  const v = { async spark() { inFlight++; peak = Math.max(peak, inFlight); await sleep(20); inFlight--; return { text: "{}", output: [] }; } } as unknown as FindsVendors;
  const ac = new AbortController();
  const bg = hedgedSearch(v, "warm", 1, ac.signal, [], { background: true });
  const fg = hedgedSearch(v, "ask", 1, ac.signal);
  await Promise.all([bg, fg]);
  assert.equal(peak, 2, "the call's search never waits behind the warm-up");
  assert.equal(searchSlotsUsed(), 0);
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

test("Codex P1s #522: one kind per ask (a bag never answers shoes, boots never answer sneakers); colors from the product's own name; no profile = this account only", async () => {
  const { categoryOf, cardIsKind, cardFitsColors } = await import("../src/finds/productCache.ts");
  const card = (names: string[], taste = "") => ({ products: names.map((name) => ({ name, taste, situation: "" })) }) as unknown as FindCard;
  assert.equal(categoryOf("Find black shoes and a black bag"), null, "two kinds: never cached or served");
  assert.equal(categoryOf("Find me black boots"), "boots");
  assert.equal(categoryOf("Can you find me some dark brown shoes?"), "shoes");
  assert.equal(categoryOf("Find black shoes and a black belt"), null, "a belt too: not one kind (Codex r2)");
  assert.equal(categoryOf("Find a black tote"), "totes");
  assert.equal(cardIsKind(card(["Black Leather Backpack", "Black Nylon Backpack"]), "totes"), false, "a backpack never answers a tote");
  assert.equal(cardIsKind(card(["Black Chelsea Boot", "Leather Tote Bag"]), "shoes"), false);
  assert.equal(cardIsKind(card(["Black Chelsea Boot", "Penny Loafer"]), "sneakers"), false);
  assert.equal(cardIsKind(card(["Black Chelsea Boot", "Penny Loafer"]), "shoes"), true);
  assert.equal(cardFitsColors(card(["Black Boot", "Penny Loafer"], "Brown palette"), ["brown"]), false, "the chip never vouches for a black boot");
  clearProductCache();
  const { v } = vendors(10);
  const a = runner(v, "no-profile-a", "");
  a.r.onTurn({ text: "Find me some black shoes", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  await a.r.settle();
  const b = runner(v, "no-profile-b", "");
  const s = b.r.onTurn({ text: "Find me some black shoes", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  await sleep(5);
  assert.ok(!b.events.some((e) => e.type === "find.created" && e.findId === s!.findId), "accounts without a profile never share");
  await b.r.settle();
  a.r.close(); b.r.close();
});

test("handover b9-6: one color rule — the cache takes what the search ranks as the asked color", async () => {
  const { cardFitsColors, colorAsks } = await import("../src/finds/productCache.ts");
  const card = (names: string[]) => ({ id: "c", kind: "product", createdAt: "", eyebrow: "", title: "", subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [], products: names.map((name, i) => ({ id: `p${i}`, name, url: "https://x.example.com/p/1", domain: "x.example.com", store: "X", taste: "", situation: "" })) }) as never;
  assert.equal(cardFitsColors(card(["Chocolate Suede Boot", "Espresso Chelsea Boot"]), colorAsks("dark brown shoes")), true, "shades of brown fit brown");
  assert.equal(cardFitsColors(card(["Black Chelsea Boot"]), colorAsks("dark brown shoes")), false);
  assert.deepEqual(colorAsks("Find shoes, but no black ones"), [], "a color ruled out is not asked");
  assert.deepEqual(colorAsks("shoes in dark brown"), ["brown"]);
  assert.deepEqual(colorAsks("shoes that go with my brown trench"), []);
});

test("P1-9 (b9 S5): a refresh that comes back with one link never replaces the two-pick card; a one-link card is never cached", async () => {
  const { cachePut, cacheGet, clearProductCache } = await import("../src/finds/productCache.ts");
  clearProductCache();
  const card = (n: number) => ({ id: "c", kind: "product", createdAt: "", eyebrow: "", title: "", subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [], products: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Dark Brown Boot ${i}`, url: `https://x.example.com/p/${i}`, domain: "x.example.com", store: "X", taste: "", situation: "" })) }) as FindCard;
  cachePut("k|account:a|", { at: Date.now(), card: card(1) });
  assert.equal(cacheGet("k|account:a|", Date.now()), null, "one link is not an answer to cache");
  cachePut("k|account:a|", { at: Date.now(), card: card(2) });
  assert.equal(cacheGet("k|account:a|", Date.now())?.card.products?.length, 2);
  cachePut("k|account:a|", { at: Date.now(), card: card(1) });
  assert.equal(cacheGet("k|account:a|", Date.now())?.card.products?.length, 2, "the smaller refresh never wins");
  clearProductCache();
});

test("P1-9 (Codex P2): a one-link warm-up that the cache turns down does not block the next call's warm-up", async () => {
  const { cachePut, claimWarm, clearProductCache } = await import("../src/finds/productCache.ts");
  clearProductCache();
  const card = (n: number) => ({ id: "c", kind: "product", createdAt: "", eyebrow: "", title: "", subtitle: "", items: [], steps: [], options: [], why: [], ask: [], sources: [], how: [], products: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Dark Brown Boot ${i}`, url: `https://x.example.com/p/${i}`, domain: "x.example.com", store: "X", taste: "", situation: "" })) }) as FindCard;
  const now = Date.now();
  assert.equal(claimWarm("w|account:a|", now), true);
  cachePut("w|account:a|", { at: now, card: card(1) });
  assert.equal(claimWarm("w|account:a|", now + 1000), true, "the next warm-up may run");
  clearProductCache();
});
