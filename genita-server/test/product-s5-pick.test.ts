/**
 * S5 (QA 11/4, prod code + live vendors): the spoken line said "chunky white sneakers" while the card showed one
 * "Black Chelsea Bootie" (1/3), and 2/6 cards had one link. One pick now drives both the line and the search; what
 * contradicts it never shows; the card is topped up from the other lanes to two links.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contradictsPick, decidePick, runProduct, type ProductCtx } from "../src/finds/product.ts";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import type { ServerEvent } from "../src/protocol.ts";
import type { FindsVendors, SparkResult } from "../src/finds/vendors.ts";

const PICK = { item: "white sneakers", color: "white", say: "That trench begs for chunky white sneakers." };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function laneOf(items: { name: string; slug: string }[]): SparkResult {
  const urls = items.map((i) => `https://${i.slug}.example.com/products/${i.slug}`);
  return {
    text: JSON.stringify({ label: "Sneakers", title: "Two for the trench", items: items.map((i, k) => ({ name: i.name, url: urls[k], store: "S", price: "$90", image: "", taste: "Clean", situation: "Goes with camel" })) }),
    output: urls.map((url) => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url } })),
  };
}

test("pick: another kind or another colour contradicts the spoken pick; a name without either doesn't", () => {
  assert.equal(contradictsPick("Black Chelsea Bootie", PICK), true);
  assert.equal(contradictsPick("Heeled Leather Chelsea Boots", PICK), true);
  assert.equal(contradictsPick("Black leather sneakers", PICK), true);
  assert.equal(contradictsPick("Stan Smith White Sneakers", PICK), false);
  assert.equal(contradictsPick("Nike Air Force 1 '07", PICK), false);
  assert.equal(contradictsPick("Campo leather shoe", PICK), false);
  // a brand isn't a colour (Codex #726)
  const brown = { item: "brown boots", color: "brown", say: "" };
  assert.equal(contradictsPick("Red Wing Iron Ranger Boot", brown), false);
  assert.equal(contradictsPick("Black Chelsea Boot", brown), true);
  assert.equal(contradictsPick("Black Leather Boots", brown), true);
});

function vendors(lanes: (() => Promise<SparkResult>)[], prompts: string[] = []): FindsVendors {
  let n = 0;
  return {
    async spark(req) {
      const text = JSON.stringify(req.input);
      prompts.push(text);
      if (text.includes("Decide the ONE item")) return { text: JSON.stringify(PICK), output: [] };
      const lane = lanes[Math.min(n++, lanes.length - 1)];
      return lane();
    },
    async *sparkStream() {},
    sam: async () => [], image: async () => Buffer.from([]),
    pageFacts: async () => ({ kind: "product" as const, title: "", price: "$90" }) as never,
    productImage: async () => null,
  };
}
function ctxFor(v: FindsVendors, extra: Partial<ProductCtx> = {}): { ctx: ProductCtx; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  return {
    events,
    ctx: {
      findId: "p1", utteranceId: 1, kind: "product", question: "Can you find me shoes that would go with this?", frames: ["data:image/jpeg;base64,AAA"], memories: [],
      replyText: Promise.resolve(null), vendors: v, emit: (e) => events.push(e), signal: new AbortController().signal, now: () => performance.now(), log: () => {},
      images: false, putImage: async () => "", hedge: 2, ...extra,
    },
  };
}

test("S5: what contradicts the spoken pick never shows; the second link is topped up from the other lane", async () => {
  const v = vendors([
    async () => laneOf([{ name: "Black Chelsea Bootie", slug: "boot" }, { name: "Stan Smith White Sneakers", slug: "stan" }]),
    async () => { await sleep(20); return laneOf([{ name: "Campo White Sneakers", slug: "campo" }]); },
  ]);
  const { ctx } = ctxFor(v, { pick: Promise.resolve(PICK) });
  const r = await runProduct(ctx);
  const names = r.card!.products!.map((p) => p.name);
  assert.deepEqual(names.sort(), ["Campo White Sneakers", "Stan Smith White Sneakers"]);
});

test("S5: the search prompt shops exactly the spoken pick", async () => {
  const prompts: string[] = [];
  const v = vendors([async () => laneOf([{ name: "Stan Smith White Sneakers", slug: "stan" }, { name: "Campo White Sneakers", slug: "campo" }])], prompts);
  const { ctx } = ctxFor(v, { pick: Promise.resolve(PICK) });
  await runProduct(ctx);
  assert.ok(prompts.some((p) => p.includes("every pick must be white sneakers in white")));
});

test("S5 runner: the turn's spoken line is the pick's own line (same decision as the search)", async () => {
  const prompts: string[] = [];
  const v = vendors([async () => laneOf([{ name: "Stan Smith White Sneakers", slug: "stan" }, { name: "Campo White Sneakers", slug: "campo" }])], prompts);
  const r = new FindsRunner({ vendors: v, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds", productHedge: 1, productPrefetch: false }, { emit() {}, announce() {}, log() {}, now: () => performance.now() });
  r.configure({ owner: "u1", memories: [] });
  const s = r.onTurn({ text: "Can you find me shoes that would go with this?", frames: ["data:image/jpeg;base64,AAA"], utteranceId: 1, replyText: Promise.resolve(null) });
  assert.equal(await s!.reaction, PICK.say);
  await sleep(50);
  assert.ok(prompts.some((p) => p.includes("every pick must be white sneakers")));
  r.close();
});

test("S5: a pick whose line doesn't name its item says nothing specific (the plain ack instead)", async () => {
  const v: FindsVendors = { ...vendors([]), async spark() { return { text: JSON.stringify({ item: "white sneakers", color: "white", say: "Ooh, love this look!" }), output: [] }; } };
  const p = await decidePick(v, { question: "q", recent: [], taste: [], frames: [], signal: new AbortController().signal });
  assert.equal(p?.item, "white sneakers");
  assert.equal(p?.say, "");
});

test("Codex #726: duplicates across lanes don't crowd out the third lane's second product", async () => {
  const four = [{ name: "White Sneaker A", slug: "a" }, { name: "Black Chelsea Bootie", slug: "b" }, { name: "Black Boot C", slug: "c" }, { name: "Black Boot D", slug: "d" }];
  const v = vendors([
    async () => laneOf(four),
    async () => { await sleep(10); return laneOf(four); },
    async () => { await sleep(20); return laneOf([{ name: "White Sneaker E", slug: "e" }]); },
  ]);
  const { ctx } = ctxFor(v, { pick: Promise.resolve(PICK), hedge: 3 });
  const r = await runProduct(ctx);
  assert.deepEqual(r.card!.products!.map((p) => p.name).sort(), ["White Sneaker A", "White Sneaker E"]);
});

test("QA 11/4 D: vision decisions get room to finish (200 tokens came back empty on a 1024 px screen frame, 4/4)", async () => {
  const { runIdentify } = await import("../src/finds/pipeline.ts");
  const budgets: number[] = [];
  const v: FindsVendors = {
    async spark(req) { budgets.push(req.maxOutputTokens ?? 0); return { text: JSON.stringify(PICK), output: [] }; },
    async *sparkStream() {}, sam: async () => [], image: async () => Buffer.from([]),
  };
  await decidePick(v, { question: "q", recent: [], taste: [], frames: ["data:image/jpeg;base64,AAA"], signal: new AbortController().signal });
  await runIdentify({ findId: "i", utteranceId: 1, kind: "answer", question: "What's this?", frames: ["data:image/jpeg;base64,AAA"], memories: [], replyText: Promise.resolve(null), vendors: v, emit() {}, signal: new AbortController().signal, now: () => 0, log() {}, images: false, putImage: async () => "", speak() {} });
  assert.ok(budgets.length >= 2);
  assert.ok(budgets.every((b) => b >= 800), JSON.stringify(budgets));
});
