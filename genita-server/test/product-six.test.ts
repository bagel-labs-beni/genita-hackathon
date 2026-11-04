/**
 * "Who recommends only two outfits?" (Chelsea 11/4): a product card carries up to GENITA_PRODUCT_MAX (default 6)
 * verified products. The first 2 never wait longer than before (same search caps, one shared page-read window), the
 * rules stay (verified page, not sold out, picture or swap/omit, the asked color, a mix of stores) and no title says "two".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardTitle, countFits, foundSay, hedgedSearch, productMax, productPrompt, readPages, runProduct, statusLine, PILL_MAX, type ProductCtx } from "../src/finds/product.ts";
import type { PageFacts } from "../src/finds/fetchPage.ts";
import { checkServerEvent, type FindCard, type ServerEvent } from "../src/protocol.ts";
import type { FindsVendors, OutputItem } from "../src/finds/vendors.ts";

process.env.GENITA_FIND_WEB_IMAGES = "0";

const OPEN = (url: string): OutputItem => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url } });
const SEARCH: OutputItem = { type: "web_search_call", status: "completed", action: { type: "search", query: "jacket" } };
const url = (store: string, slug: string) => `https://${store}.example.com/products/${slug}`;
type Item = { name: string; url: string; store: string };
const item = (store: string, name: string): Item => ({ name, url: url(store, name.toLowerCase().replace(/\s+/g, "-")), store });

function vendors(o: { items: Item[]; opened: string[]; facts?: (u: string, signal?: AbortSignal) => Promise<PageFacts | null>; title?: string; say?: string }): FindsVendors {
  return {
    async spark() {
      const json = JSON.stringify({ label: "Light jacket", title: o.title ?? "Two For Tonight", subtitle: "Light jackets, matched to your style.", style_line: "Clean, minimal clothes.", situation_line: "Mild tonight", items: o.items.map((i) => ({ ...i, price: "", image: "", taste: "Clean", situation: "Light" })), say: o.say ?? "Two, both simple cuts." });
      return { text: json, output: [SEARCH, ...o.opened.map(OPEN)] };
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return []; },
    async image() { throw new Error("never a generated product picture"); },
    pageFacts: o.facts ?? (async (u) => ({ kind: "product", image: `https://cdn.example.com/${encodeURIComponent(u)}.jpg` })),
    async productImage() { return Buffer.from([0xff, 0xd8, 0xff, 0xe0]); },
  };
}

function ctxFor(v: FindsVendors, extra: Partial<ProductCtx> = {}) {
  const events: ServerEvent[] = [];
  const ctx: ProductCtx = {
    findId: "f6", utteranceId: 1, kind: "product", question: "Can we look for a jacket for tonight?", frames: [], memories: [],
    replyText: Promise.resolve(null), timeZone: "Asia/Seoul", vendors: v,
    emit: (e) => { assert.deepEqual(checkServerEvent(e as unknown as Record<string, unknown>), [], JSON.stringify(e)); events.push(e); },
    signal: new AbortController().signal, now: () => performance.now(), log: () => {}, images: true,
    putImage: async (slot) => `/v1/finds/f6/images/${slot}`, likes: ["Clean, minimal clothes."], hedge: 1, ...extra,
  };
  return { ctx, events, created: () => (events.find((e) => e.type === "find.created") as Extract<ServerEvent, { type: "find.created" }> | undefined)?.card as FindCard | undefined };
}

const SIX = ["northline", "fieldco", "quince", "everlane", "uniqlo", "cos"].map((s, k) => item(s, `Jacket ${["one", "alpha", "beta", "gamma", "delta", "omega"][k]}`));

test("6 verified candidates → 6 products on the card; no 'two' in the title or the line", async () => {
  const run = ctxFor(vendors({ items: SIX, opened: SIX.map((i) => i.url) }));
  const r = await runProduct(run.ctx);
  const card = run.created()!;
  assert.equal(card.products!.length, 6);
  assert.deepEqual(card.products!.map((p) => p.url), SIX.map((i) => i.url));
  assert.deepEqual(card.products!.map((p) => p.image?.slot), ["product-1", "product-2", "product-3", "product-4", "product-5", "product-6"]);
  assert.equal(card.title, "Picks For Tonight");
  assert.doesNotMatch(card.title, /\btwo\b/i);
  assert.equal(card.say, "Found 6 for you.", "the model's 'Two, both simple cuts.' names another count");
  assert.equal(card.status, "6 links · northline.example.com, fieldco.example.com +4");
  assert.equal(r.card!.products!.filter((p) => p.image?.status === "ready").length, 6);
  // old apps show products[0..1]: the first two are the same first two as before
  assert.deepEqual(card.products!.slice(0, 2).map((p) => p.url), SIX.slice(0, 2).map((i) => i.url));
});

test("GENITA_PRODUCT_MAX=2 brings back the two-product card (rollback)", async () => {
  process.env.GENITA_PRODUCT_MAX = "2";
  try {
    assert.equal(productMax(), 2);
    const run = ctxFor(vendors({ items: SIX, opened: SIX.map((i) => i.url) }));
    await runProduct(run.ctx);
    assert.equal(run.created()!.products!.length, 2);
  } finally { delete process.env.GENITA_PRODUCT_MAX; }
  assert.equal(productMax({ GENITA_PRODUCT_MAX: "1" }), 6, "below the 2 a card waits for → default");
  assert.equal(productMax({}), 6);
});

test("slow pages: the card goes out inside today's page window with the 2 already verified; slow reads are aborted", async () => {
  process.env.GENITA_PRODUCT_PAGE_MS = "600";
  try {
    // the search opened two pages; four more were only listed and need our own read, which never answers in time
    let aborted = 0;
    const facts = (u: string, signal?: AbortSignal) => {
      if (u === SIX[0].url || u === SIX[1].url) return Promise.resolve<PageFacts>({ kind: "product", image: "https://cdn.example.com/a.jpg" });
      return new Promise<PageFacts | null>((resolve) => signal?.addEventListener("abort", () => { aborted++; resolve(null); }, { once: true }));
    };
    const run = ctxFor(vendors({ items: SIX, opened: [SIX[0].url, SIX[1].url], facts }));
    const t0 = performance.now();
    await runProduct(run.ctx);
    const card = run.created()!;
    const took = performance.now() - t0;
    assert.ok(took < 1200, `card in ${Math.round(took)} ms (page window 600 ms)`);
    assert.deepEqual(card.products!.map((p) => p.url), [SIX[0].url, SIX[1].url], "only verified pages; an unread listed page never fills a slot");
    assert.equal(aborted, 4, "the slow reads were stopped at the window");
  } finally { delete process.env.GENITA_PRODUCT_PAGE_MS; }
});

test("page reads: at most 6 at once, one shared window (a late read gets what is left, never a fresh budget)", async () => {
  let inFlight = 0;
  let peak = 0;
  const started: number[] = [];
  const t0 = Date.now();
  const out = await readPages(9, 300, new AbortController().signal, (i, signal) => {
    inFlight++; peak = Math.max(peak, inFlight); started.push(i);
    // the first six take 200 ms; the rest would take 500 ms
    return new Promise<number | null>((resolve) => {
      let done = false;
      const end = (v: number | null) => { if (!done) { done = true; inFlight--; resolve(v); } };
      const t = setTimeout(() => end(i), i < 6 ? 200 : 500);
      signal.addEventListener("abort", () => { clearTimeout(t); end(null); }, { once: true });
    });
  });
  const took = Date.now() - t0;
  assert.equal(peak, 6);
  assert.deepEqual(out.slice(0, 6), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(out.slice(6), [null, null, null], "the 7th–9th started at 200 ms with 100 ms left: cut at the window");
  assert.ok(took < 450, `all reads done in ${took} ms (window 300 ms)`);
  assert.equal(inFlight, 0, "nothing left running");
  assert.deepEqual(await readPages(3, 300, new AbortController().signal, null), [null, null, null]);
});

test("hedged search: a lane with 2 opened pages still wins at once — more products never hold the first 2", async () => {
  const fast = { text: JSON.stringify({ items: [{ url: SIX[0].url }, { url: SIX[1].url }, { url: SIX[2].url }] }), output: [OPEN(SIX[0].url), OPEN(SIX[1].url)] };
  let calls = 0;
  const v: FindsVendors = {
    spark(_req, signal) {
      calls++;
      return new Promise((resolve, reject) => {
        // the first lane lists 3 and opened 2; the others never answer
        if (calls === 1) { setTimeout(() => resolve(fast), 20); return; }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    async *sparkStream() {}, async sam() { return []; }, async image() { return Buffer.alloc(0); },
  };
  const t0 = performance.now();
  const r = await hedgedSearch(v, "p", 3, new AbortController().signal, [], { softMs: 6000, hardMs: 16000 });
  assert.ok(performance.now() - t0 < 500);
  assert.equal(r, fast);
});

test("hard cap: past GENITA_PRODUCT_HARD_MS the card goes with what is verified (1 page), as before", async () => {
  const one = { text: JSON.stringify({ items: [{ url: SIX[0].url }] }), output: [OPEN(SIX[0].url)] };
  let calls = 0;
  const v: FindsVendors = {
    spark(_req, signal) {
      calls++;
      return new Promise((resolve, reject) => {
        if (calls === 1) { setTimeout(() => resolve(one), 10); return; }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    async *sparkStream() {}, async sam() { return []; }, async image() { return Buffer.alloc(0); },
  };
  const t0 = performance.now();
  const r = await hedgedSearch(v, "p", 2, new AbortController().signal, [], { softMs: 100, hardMs: 250 });
  const took = performance.now() - t0;
  assert.ok(took >= 240 && took < 600, `resolved at ${Math.round(took)} ms (hard 250 ms)`);
  assert.match(r!.text, /northline/);
});

test("a mix of stores: a second page from a store already on the card waits for the ones from new stores", async () => {
  const items = [item("northline", "Jacket one"), item("northline", "Jacket two b"), item("northline", "Jacket three c"), item("quince", "Jacket four"), item("cos", "Jacket five")];
  process.env.GENITA_PRODUCT_MAX = "3";
  try {
    const run = ctxFor(vendors({ items, opened: items.map((i) => i.url) }));
    await runProduct(run.ctx);
    assert.deepEqual(run.created()!.products!.map((p) => p.store), ["northline", "quince", "cos"]);
  } finally { delete process.env.GENITA_PRODUCT_MAX; }
  // all from one store: they still fill the card (diversity only where possible)
  const same = [item("northline", "Jacket one"), item("northline", "Jacket two b"), item("northline", "Jacket three c")];
  const run = ctxFor(vendors({ items: same, opened: same.map((i) => i.url) }));
  await runProduct(run.ctx);
  assert.equal(run.created()!.products!.length, 3);
});

test("the asked color still holds on a bigger card: another color only fills a card under 2", async () => {
  const items = [item("a", "Black jacket"), item("b", "Navy jacket"), item("c", "Black wool jacket"), item("d", "Red jacket")];
  const run = ctxFor(vendors({ items, opened: items.map((i) => i.url) }), { question: "Can we look for a black jacket for tonight?" });
  await runProduct(run.ctx);
  assert.deepEqual(run.created()!.products!.map((p) => p.name), ["Black jacket", "Black wool jacket"]);
});

test("sold-out pages never take one of the six slots", async () => {
  const facts = async (u: string): Promise<PageFacts> => (u === SIX[2].url ? { kind: "product", price: "$40", image: "https://cdn.example.com/x.jpg", unavailable: true } : { kind: "product", image: "https://cdn.example.com/y.jpg" });
  const run = ctxFor(vendors({ items: SIX, opened: SIX.map((i) => i.url), facts }));
  await runProduct(run.ctx);
  const urls = run.created()!.products!.map((p) => p.url);
  assert.equal(urls.length, 5);
  assert.ok(!urls.includes(SIX[2].url));
});

test("no 'two' in titles, lines or the search prompt", () => {
  for (const n of [2, 3, 4, 5, 6]) {
    for (const t of ["Two For Tonight", "Two picks for the weekend", "Two for you", "A pair of boots", "Both go with the trench", "One for you", ""]) {
      const title = cardTitle(t, n);
      assert.doesNotMatch(title, /\b(two|both|pair|one)\b/i, `${t} → ${title}`);
    }
    assert.ok(foundSay(n).length <= PILL_MAX);
    assert.ok(countFits(foundSay(n), n));
  }
  assert.equal(cardTitle("Two For Tonight", 6), "Picks For Tonight");
  assert.equal(cardTitle("Two picks for the weekend", 4), "Picks for the weekend");
  assert.equal(cardTitle("Jackets under $100", 6), "Jackets under $100", "a price is not a count");
  assert.equal(cardTitle("Two for the trench", 1), "One for the trench");
  assert.equal(countFits("Two, both simple cuts.", 6), false);
  assert.equal(countFits("All simple, clean cuts.", 6), true);
  assert.equal(statusLine(2, ["a.com", "b.com"]), "2 links · a.com, b.com");
  assert.equal(statusLine(1, ["a.com"]), "1 link · a.com");
  const prompt = productPrompt({ question: "a jacket for tonight", recent: [], taste: [], city: null, region: "US", today: "Tuesday, November 4", oneSearch: true, max: 6 });
  assert.doesNotMatch(prompt, /\btwo\b/i);
  assert.match(prompt, /up to 6 products/);
  assert.match(prompt, /List up to 6 products in all/);
});

test("hedged search: a lane that wins with 2 is topped up by the lanes already back (more products, no wait)", async () => {
  const early = { text: JSON.stringify({ items: [{ url: SIX[2].url }] }), output: [OPEN(SIX[2].url)] };
  const win = { text: JSON.stringify({ items: [{ url: SIX[0].url }, { url: SIX[1].url }] }), output: [OPEN(SIX[0].url), OPEN(SIX[1].url)] };
  let calls = 0;
  const v: FindsVendors = {
    spark(_req, signal) {
      const k = calls++;
      return new Promise((resolve, reject) => {
        if (k === 0) { setTimeout(() => resolve(early), 10); return; }
        if (k === 1) { setTimeout(() => resolve(win), 30); return; }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    async *sparkStream() {}, async sam() { return []; }, async image() { return Buffer.alloc(0); },
  };
  const r = await hedgedSearch(v, "p", 3, new AbortController().signal, [], { softMs: 6000, hardMs: 16000 });
  const urls = (JSON.parse(r!.text).items as { url: string }[]).map((i) => i.url);
  assert.deepEqual(urls, [SIX[0].url, SIX[1].url, SIX[2].url], "the winner's own first, then the early lane's");
});
