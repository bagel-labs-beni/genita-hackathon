/**
 * Demo S5 latency (lead 11/4): the searching sheet shows the instant the product intent fires, the visible wait is
 * capped (~12 s: best card so far, else a graceful line while the search keeps going and fills the sheet later).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import { hedgedSearch } from "../src/finds/product.ts";
import type { ServerEvent } from "../src/protocol.ts";
import type { FindsVendors, SparkResult } from "../src/finds/vendors.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lane(proven: number): SparkResult {
  const urls = ["https://shop-a.example.com/products/boot-1", "https://shop-b.example.com/products/boot-2"].slice(0, proven);
  return {
    text: JSON.stringify({ label: "Boots", items: urls.map((url, i) => ({ name: `Boot ${i + 1}`, url, store: "S", price: "$1", image: "", taste: "", situation: "" })) }),
    output: urls.map((url) => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url } })),
  };
}

test("S5: find.started goes out in the same tick the product intent fires, even while the account's likes still load", () => {
  const events: ServerEvent[] = [];
  const v: FindsVendors = {
    spark: () => new Promise(() => {}),
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    sam: async () => [], image: async () => Buffer.from([]),
  };
  const r = new FindsRunner(
    { vendors: v, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds", productHedge: 1, productPrefetch: false, likes: () => new Promise(() => {}) },
    { emit: (e) => events.push(e), announce() {}, log() {}, now: () => performance.now() },
  );
  r.configure({ owner: "u1", memories: [] });
  const s = r.onTurn({ text: "Can you find me shoes that would go with this?", frames: ["data:image/jpeg;base64,AAA"], utteranceId: 1, replyText: Promise.resolve(null) });
  assert.equal(s?.kind, "product");
  assert.ok(s?.ack, "the turn has a line to say at once (the session turns it into a quick reaction)");
  assert.equal(events[0]?.type, "find.started", "the searching sheet shows before any await");
  r.close();
});

test("S5 cap: past the soft cap two lanes with one product page each make the card (topped up), not the straggler", async () => {
  let calls = 0;
  const v: FindsVendors = {
    async spark() {
      calls++;
      if (calls === 1) { await sleep(20); return lane(1); }
      if (calls === 2) { await sleep(30); return { ...lane(2), text: JSON.stringify({ items: [{ name: "Boot 2", url: "https://shop-b.example.com/products/boot-2", store: "S", price: "", image: "", taste: "", situation: "" }] }), output: [{ type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://shop-b.example.com/products/boot-2" } }] }; }
      return new Promise(() => {});
    },
    async *sparkStream() {}, sam: async () => [], image: async () => Buffer.from([]),
  };
  const t0 = performance.now();
  const r = await hedgedSearch(v, "p", 3, new AbortController().signal, [], { softMs: 80 });
  const ms = performance.now() - t0;
  assert.equal(JSON.parse(r!.text).items.length, 2, "the winner topped up from the other lane");
  assert.ok(ms < 400, `returned at the soft cap, not the straggler (${Math.round(ms)} ms)`);
});

test("S5 cap (QA 11/4): one product page alone at the soft cap keeps waiting for a second (no one-link card)", async () => {
  let calls = 0;
  const v: FindsVendors = {
    async spark() {
      calls++;
      if (calls === 1) { await sleep(10); return lane(1); }
      await sleep(150);
      return lane(2);
    },
    async *sparkStream() {}, sam: async () => [], image: async () => Buffer.from([]),
  };
  const r = await hedgedSearch(v, "p", 2, new AbortController().signal, [], { softMs: 40 });
  assert.ok(JSON.parse(r!.text).items.length >= 2);
});

test("S5 cap: before the soft cap a one-pick lane still waits for a two-pick one", async () => {
  let calls = 0;
  const v: FindsVendors = {
    async spark() {
      calls++;
      if (calls === 1) { await sleep(10); return lane(1); }
      await sleep(40);
      return lane(2);
    },
    async *sparkStream() {}, sam: async () => [], image: async () => Buffer.from([]),
  };
  const r = await hedgedSearch(v, "p", 2, new AbortController().signal, [], { softMs: 5_000 });
  assert.equal(JSON.parse(r!.text).items.length, 2);
});

test("S5 cap: nothing by ~12 s → one graceful line (default), the search keeps going", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/finds/runner.ts", import.meta.url), "utf8"));
  assert.match(src, /stillSearchingMs \?\? 12_000/, "the default visible wait before the line is 12 s");
});

test("S5 cap (Codex #722): a category page alone never wins at the soft cap; the lane with real products still can", async () => {
  let calls = 0;
  const category: SparkResult = {
    text: JSON.stringify({ items: [{ name: "Women's boots", url: "https://shop-c.example.com/collections/womens-boots", store: "S", price: "", image: "", taste: "", situation: "" }] }),
    output: [{ type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://shop-c.example.com/collections/womens-boots" } }],
  };
  const v: FindsVendors = {
    async spark() {
      calls++;
      if (calls === 1) { await sleep(10); return category; }
      await sleep(150);
      return lane(2);
    },
    async *sparkStream() {}, sam: async () => [], image: async () => Buffer.from([]),
  };
  const r = await hedgedSearch(v, "p", 2, new AbortController().signal, [], { softMs: 40 });
  assert.equal(JSON.parse(r!.text).items.length, 2, "waited for the lane with product pages");
});

test("S5 hard cap (QA 11/4 #726: 26 s cards): past it one fitting page is shown instead of waiting for the stragglers", async () => {
  let calls = 0;
  const v: FindsVendors = {
    async spark() { calls++; if (calls === 1) { await sleep(10); return lane(1); } return new Promise(() => {}); },
    async *sparkStream() {}, sam: async () => [], image: async () => Buffer.from([]),
  };
  const t0 = performance.now();
  const r = await hedgedSearch(v, "p", 2, new AbortController().signal, [], { softMs: 30, hardMs: 90 });
  assert.ok(r && performance.now() - t0 < 500);
});

// ───────────── S5 speed (11/4: cards 16–21 s, often one link) ─────────────

const shopItem = (n: number) => ({ name: `Leather Boot ${n}`, url: `https://shop-${n}.example.com/products/boot-${n}`, store: "S", price: "$100", image: "", taste: "", situation: "" });
const shopOpen = (n: number) => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url: `https://shop-${n}.example.com/products/boot-${n}` } });

async function slowShopCard(): Promise<{ created: number; links: number }> {
  const { runProduct } = await import("../src/finds/product.ts");
  const v: FindsVendors = {
    async spark() { await sleep(10); return { text: JSON.stringify({ label: "Boots", items: [shopItem(1), shopItem(2)] }), output: [shopOpen(1)] } as SparkResult; },
    async *sparkStream() {}, sam: async () => [], image: async () => Buffer.from([]),
    // shop 2 never answers
    async pageFacts(url: string) { if (url.includes("boot-2")) return new Promise(() => {}); await sleep(5); return { kind: "product" as const, title: "Boot" }; },
  };
  const t0 = performance.now();
  let created = -1;
  let links = 0;
  await runProduct({
    findId: "f1", utteranceId: 1, kind: "product", question: "find me leather boots", frames: [], memories: [], vendors: v,
    signal: new AbortController().signal, now: () => performance.now(), hedge: 1, log() {}, putImage: async () => "x",
    emit: (e: ServerEvent) => { if (e.type === "find.created") { created = performance.now() - t0; links = e.card.products?.length ?? 0; } },
  } as unknown as Parameters<typeof runProduct>[0]);
  return { created, links };
}
async function withEnv<T>(k: string, v: string | undefined, f: () => Promise<T>): Promise<T> {
  const saved = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return await f(); } finally { if (saved === undefined) delete process.env[k]; else process.env[k] = saved; }
}

test("S5 speed: a slow shop page does not hold the card past the page budget; by default an unread link is never shown (F7)", async () => {
  const { created, links } = await withEnv("GENITA_PRODUCT_FILL_UNREAD", undefined, slowShopCard);
  assert.ok(created >= 0 && created < 3600, `card within the 3 s page budget (${Math.round(created)} ms)`);
  assert.equal(links, 1, "Codex r1 P1: a page nobody opened (maybe invented) stays out by default");
});

test("S5 speed (GENITA_PRODUCT_FILL_UNREAD=1): the unread shop's product link fills the second slot", async () => {
  const { created, links } = await withEnv("GENITA_PRODUCT_FILL_UNREAD", "1", slowShopCard);
  assert.ok(created >= 0 && created < 3600, `card within the 3 s page budget (${Math.round(created)} ms)`);
  assert.equal(links, 2);
});

test("S5 speed (GENITA_PRODUCT_FILL_UNREAD=1): past the soft cap a lane with one opened page + one listed product page is enough", async () => withEnv("GENITA_PRODUCT_FILL_UNREAD", "1", async () => {
  let calls = 0;
  const v: FindsVendors = {
    async spark() { calls++; if (calls === 1) { await sleep(10); return { text: JSON.stringify({ items: [shopItem(1), shopItem(2)] }), output: [shopOpen(1)] } as SparkResult; } return new Promise(() => {}); },
    async *sparkStream() {}, sam: async () => [], image: async () => Buffer.from([]),
  };
  const r = await Promise.race([hedgedSearch(v, "p", 2, new AbortController().signal, [], { softMs: 40 }), sleep(1000).then(() => "stuck" as const)]);
  assert.notEqual(r, "stuck", "the lane with 2 product links won at the soft cap");
  assert.equal(JSON.parse((r as SparkResult).text).items.length, 2);
}));

test("S5 speed: budgets have env knobs with the old values recoverable", async () => {
  const p = await import("../src/finds/product.ts");
  assert.equal(p.productPageMs({}), 3000);
  assert.equal(p.productPageMs({ GENITA_PRODUCT_PAGE_MS: "4500" }), 4500);
  assert.equal(p.productSoftMs({ GENITA_PRODUCT_SOFT_MS: "10000" }), 10_000);
  assert.equal(p.productHardMs({ GENITA_PRODUCT_HARD_MS: "16000" }), 16_000);
  assert.equal(p.productDeadlineMs({ GENITA_PRODUCT_DEADLINE_MS: "0" }), 0);
  assert.equal(p.fillUnread({}), false, "off by default (Codex r1 P1)");
  assert.equal(p.fillUnread({ GENITA_PRODUCT_FILL_UNREAD: "1" }), true);
});
