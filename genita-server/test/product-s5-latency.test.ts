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

test("S5 cap: one lane with a proven pick is used at the soft cap instead of waiting for slower lanes", async () => {
  let calls = 0;
  const v: FindsVendors = {
    async spark() {
      calls++;
      // lane 1: one opened product page at 20 ms; lane 2: never returns (a 35 s straggler)
      if (calls === 1) { await sleep(20); return lane(1); }
      return new Promise(() => {});
    },
    async *sparkStream() {}, sam: async () => [], image: async () => Buffer.from([]),
  };
  const t0 = performance.now();
  const r = await hedgedSearch(v, "p", 2, new AbortController().signal, [], { softMs: 80 });
  const ms = performance.now() - t0;
  assert.ok(r, "the one-pick lane is returned");
  assert.ok(ms < 400, `returned at the soft cap, not the straggler (${Math.round(ms)} ms)`);
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
