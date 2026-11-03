/**
 * Demo S5: Spark web search takes 15–30 s (11/3). When an outfit card lands, the runner quietly starts the
 * search for what goes with the picked outfit; a product ask in the next 5 minutes that fits it gets that
 * search's card (under its own id) instead of starting a new one. Anything else searches as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import type { FindsVendors, OutputItem } from "../src/finds/vendors.ts";
import type { ServerEvent } from "../src/protocol.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P1 = "https://shop.example.com/products/leather-loafer-dark-brown";
const P2 = "https://store.example.com/product/chelsea-boot-123456.html";
const OPEN = (url: string): OutputItem => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url } });
const FRAME = "data:image/jpeg;base64,QUFB";

function vendors(searchMs = 60) {
  const searches: string[] = [];
  const v: FindsVendors = {
    async spark(req) {
      const p = JSON.stringify(req.input);
      if (p.includes("Shop for them")) {
        searches.push(p);
        await sleep(searchMs);
        return {
          text: JSON.stringify({ label: "Shoes", title: "Two to go with it", style_line: "Black, camel, dark brown.", situation_line: "With the black outfit", items: [
            { name: "Leather loafer", url: P1, store: "Shop", price: "$90", taste: "Dark brown", situation: "Goes with black" },
            { name: "Chelsea boot", url: P2, store: "Store", price: "", taste: "Leather", situation: "Halloween night" },
          ], say: "Two, both dark brown." }),
          output: [OPEN(P1), OPEN(P2)],
        };
      }
      // the outfit card
      return { text: JSON.stringify({ pick: 1, title: "Wear the black dress.", taste: "", options: [{ label: "White top", frame: 0 }, { label: "Black dress", frame: 1 }], why: ["Fresh", "Halloween night"], ask: ["Shoes?", "Bag?"], say: "Black, for sure." }), output: [] };
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return [{ x1: 10, y1: 10, x2: 100, y2: 200, w: 480, h: 854, nx1: 0.02, ny1: 0.01, nx2: 0.2, ny2: 0.23 }]; },
    async image() { return Buffer.from([0xff, 0xd8]); },
    async pageFacts() { return { kind: "product" as const, image: "https://cdn.example.com/1.jpg" }; },
    async productImage() { return Buffer.from([0xff, 0xd8, 0xff]); },
  };
  return { v, searches };
}

function runner(v: FindsVendors, now = () => performance.now()) {
  const events: ServerEvent[] = [];
  const store = new MemoryFindsStore();
  const r = new FindsRunner({ vendors: v, store, images: true, imageBase: "/v1/finds", productHedge: 1, likes: async () => ["Black, camel, dark brown."] }, { emit: (e) => events.push(e), announce: () => {}, log: () => {}, now });
  r.configure({ owner: "acct", memories: [] });
  return { r, events, store };
}
const SAID = "Black, for sure. You have warm undertones, so dark brown shoes or leather accessories would be perfect.";

test("an outfit card starts the matching shoe search in the background; a later ask reuses it (no second search)", async () => {
  const { v, searches } = vendors(400);
  const { r, events } = runner(v);
  r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(SAID) });
  await sleep(20);
  const pre = searches.length;
  assert.ok(pre >= 1, "prefetch started as soon as the spoken pick was out");
  assert.match(searches[0], /dark brown shoes or leather accessories/, "it follows what the companion suggested");
  assert.ok(!events.some((e) => e.type === "find.started" && e.kind === "product"), "nothing on screen until she asks");
  await r.settle(); await sleep(600); // the prefetch has landed by the time she asks
  const t0 = performance.now();
  const started = r.onTurn({ text: "Can you find me some dark brown shoes that go with this?", frames: [FRAME], utteranceId: 2, replyText: Promise.resolve(null) });
  assert.equal(started?.kind, "product");
  await r.settle();
  assert.equal(searches.length, pre, "no second search");
  const mine = events.filter((e) => "findId" in e && e.findId === started!.findId);
  assert.deepEqual(mine.filter((e) => e.type === "find.started").length, 1);
  const created = mine.find((e) => e.type === "find.created") as Extract<ServerEvent, { type: "find.created" }>;
  assert.ok(created, "the card arrives under the ask's own id");
  assert.equal(created.card.id, started!.findId);
  assert.deepEqual(created.card.products!.map((p) => p.url), [P1, P2]);
  assert.ok(performance.now() - t0 < 300, "the card is there at once (a search takes 400 ms here)");
  const img = mine.find((e) => e.type === "find.image" && e.status === "ready") as Extract<ServerEvent, { type: "find.image" }>;
  assert.ok(img?.url?.startsWith(`/v1/finds/${started!.findId}/images/`), "pictures are stored under the ask's id");
  assert.ok(!events.some((e) => "findId" in e && e.findId !== started!.findId && e.type === "find.created" && e.card.kind === "product"), "the prefetch's own id never reaches the app");
});

test("an unrelated ask, or one after 5 minutes, searches as before", async () => {
  const { v, searches } = vendors(10);
  let now = 0;
  const { r } = runner(v, () => now);
  r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(SAID) });
  await r.settle(); await sleep(30);
  const pre = searches.length;
  assert.ok(pre >= 1);
  r.onTurn({ text: "Can you find me a desk lamp?", frames: [], utteranceId: 2, replyText: Promise.resolve(null) });
  await r.settle();
  assert.equal(searches.length, pre + 1, "a lamp is not what the prefetch looked for");
  now += 6 * 60_000;
  r.onTurn({ text: "Can you find me some dark brown shoes?", frames: [], utteranceId: 3, replyText: Promise.resolve(null) });
  await r.settle();
  assert.equal(searches.length, pre + 2, "too old: a fresh search");
});

test("no outfit card, no prefetch; a failed prefetch falls back to a normal search", async () => {
  const { v, searches } = vendors(10);
  const { r } = runner(v);
  r.onTurn({ text: "How was your day?", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  await r.settle();
  assert.equal(searches.length, 0);
  const broken: FindsVendors = { ...v, async spark(req) { if (JSON.stringify(req.input).includes("Shop for them") && searches.length === 0) { searches.push("fail"); throw new Error("503"); } return v.spark(req); } };
  const b = runner(broken);
  b.r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(SAID) });
  await b.r.settle(); await sleep(30);
  const s = b.r.onTurn({ text: "Find me dark brown shoes for this", frames: [FRAME], utteranceId: 2, replyText: Promise.resolve(null) });
  await b.r.settle();
  assert.ok(b.events.some((e) => e.type === "find.created" && e.findId === s!.findId), "a fresh search made the card");
});

test("Codex r1: a blazer, a lamp next to shoes, or a color the prefetch never had in view → a fresh search", async () => {
  for (const ask of ["Find me a blazer", "Find me shoes and a lamp", "Can you find me some neon green shoes?"]) {
    const { v, searches } = vendors(10);
    const { r } = runner(v);
    r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(SAID) });
    await r.settle(); await sleep(30);
    const pre = searches.length;
    r.onTurn({ text: ask, frames: [], utteranceId: 2, replyText: Promise.resolve(null) });
    await r.settle();
    assert.equal(searches.length, pre + 1, ask);
  }
  // prod 11/3 13:00: "dark brown shoes" reused a prefetch steered by "go with the black dress" and showed black boots.
  // A color in the ask must be one the background search was asked for (what was said), not just the import's taste.
  const { v, searches } = vendors(10);
  const { r } = runner(v);
  r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve("The black one, for sure.") });
  await r.settle(); await sleep(30);
  const pre = searches.length;
  r.onTurn({ text: "Can you find me dark brown shoes that go with this?", frames: [], utteranceId: 2, replyText: Promise.resolve(null) });
  await r.settle();
  assert.equal(searches.length, pre + 1, "a taste color the search wasn't steered by: fresh search");
});

test("Codex r1: a failed prefetch's fresh search shows one 'searching' state; a stopped ask never searches again", async () => {
  let fail = true;
  const { v, searches } = vendors(40);
  // the background search fails; the ask's own search (started beside it) works
  const flaky: FindsVendors = { ...v, async spark(req) { const p = JSON.stringify(req.input); if (fail && p.includes("outfit they just picked")) { searches.push("x"); await sleep(40); throw new Error("503"); } return v.spark(req); } };
  const { r, events } = runner(flaky);
  r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(SAID) });
  await sleep(10);
  const s1 = r.onTurn({ text: "Find me dark brown shoes for this", frames: [FRAME], utteranceId: 2, replyText: Promise.resolve(null) })!;
  await sleep(5); fail = false;
  await r.settle();
  assert.equal(events.filter((e) => e.type === "find.started" && e.findId === s1.findId).length, 1, "one searching state for the ask");
  assert.ok(events.some((e) => e.type === "find.created" && e.findId === s1.findId));
  // stop while the prefetch is still running, then the prefetch fails: no fresh search, nothing new on screen
  fail = true;
  const b = runner(flaky);
  b.r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(SAID) });
  await sleep(10);
  const s2 = b.r.onTurn({ text: "Find me dark brown shoes for this", frames: [FRAME], utteranceId: 2, replyText: Promise.resolve(null) })!;
  b.r.stop(s2.findId);
  await b.r.settle(); await sleep(60);
  assert.ok(!b.events.some((e) => e.type === "find.created" && e.findId === s2.findId), "a stopped ask shows no card");
  assert.equal(b.events.filter((e) => e.type === "find.started" && e.findId === s2.findId).length, 1, "and no second searching state");
});

test("Codex r1: the prefetch sees both outfit frames (the pick may be the first)", async () => {
  const { v, searches } = vendors(10);
  const { r } = runner(v);
  r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: ["data:image/jpeg;base64,V0hJVEU=", "data:image/jpeg;base64,QkxBQ0s="], utteranceId: 1, replyText: Promise.resolve("The first one, the white top.") });
  await r.settle(); await sleep(30);
  assert.ok(searches[0].includes("V0hJVEU=") && searches[0].includes("QkxBQ0s="), "both frames");
});

test("coordinator: a prefetch still running when she asks → a fresh search starts at once; the first card wins", async () => {
  const searches: string[] = [];
  const { v } = vendors(10);
  const slowPre: FindsVendors = { ...v, async spark(req) {
    const p = JSON.stringify(req.input);
    if (p.includes("Shop for them")) { searches.push(p); if (p.includes("outfit they just picked")) await sleep(400); }
    return v.spark(req);
  } };
  const { r, events } = runner(slowPre);
  r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(SAID) });
  await sleep(20);
  const t0 = performance.now();
  const s = r.onTurn({ text: "Can you find me some dark brown shoes that go with this?", frames: [FRAME], utteranceId: 2, replyText: Promise.resolve(null) })!;
  await r.settle();
  const created = events.find((e) => e.type === "find.created" && e.findId === s.findId);
  assert.ok(created, "a card");
  assert.ok(performance.now() - t0 < 350, "the fresh search's card, not the slow prefetch's");
  assert.equal(events.filter((e) => e.type === "find.started" && e.findId === s.findId).length, 1);
  assert.equal(events.filter((e) => e.type === "find.created" && e.findId === s.findId).length, 1, "only one card for the ask");
});

test("coordinator: nothing by ~30 s → one natural 'still hunting' line, not repeated; none once the card is in", async () => {
  const { v } = vendors(300);
  const said: string[] = [];
  const store = new MemoryFindsStore();
  const r = new FindsRunner({ vendors: v, store, images: false, imageBase: "/v1/finds", productHedge: 1, stillSearchingMs: 60 }, { emit: () => {}, announce: (t) => said.push(t), log: () => {}, now: () => performance.now() });
  r.configure({ owner: "acct", memories: [] });
  r.onTurn({ text: "Can you find me some white sneakers?", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  await r.settle(); await sleep(100);
  assert.equal(said.filter((t) => /still hunting/i.test(t)).length, 1, said.join(" | "));
  const quick = vendors(5);
  const said2: string[] = [];
  const r2 = new FindsRunner({ vendors: quick.v, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds", productHedge: 1, stillSearchingMs: 250 }, { emit: () => {}, announce: (t) => said2.push(t), log: () => {}, now: () => performance.now() });
  r2.configure({ owner: "acct", memories: [] });
  r2.onTurn({ text: "Can you find me some white sneakers?", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  await r2.settle(); await sleep(300);
  assert.ok(!said2.some((t) => /still hunting/i.test(t)), "card first: no filler");
});

test("Codex P2 (#366 r4): an exclusion, a material, a size or a brand the prefetch never had in view → a fresh search; the demo line still reuses", async () => {
  for (const ask of [
    "Find me dark brown shoes with no leather",
    "Find me dark brown shoes without laces",
    "Can you find me suede shoes for this?",
    "Find me dark brown shoes in size 8",
    "Find me some Nike shoes that go with this",
    "Find me shoes that aren't too formal, not loafers",
    "Find me shoes from Nike, preferably dark brown",
    "Find me some On shoes that go with this",
  ]) {
    const { v, searches } = vendors(10);
    const { r } = runner(v);
    r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(SAID) });
    await r.settle(); await sleep(30);
    const pre = searches.length;
    r.onTurn({ text: ask, frames: [], utteranceId: 2, replyText: Promise.resolve(null) });
    await r.settle();
    assert.equal(searches.length, pre + 1, ask);
  }
  // SAID mentions "leather accessories": leather was in view, so "leather shoes" still fits; the scripted S5 line fits too
  for (const ask of ["Can you find me some dark brown shoes that go with this?", "Find me dark brown leather shoes for this", "Hey Rio, can you find me some dark brown shoes that go with this?", "Okay Rio, find me dark brown shoes. I'm going out tonight."]) {
    const { v, searches } = vendors(10);
    const { r } = runner(v);
    r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: [FRAME, FRAME], utteranceId: 1, replyText: Promise.resolve(SAID) });
    await r.settle(); await sleep(30);
    const pre = searches.length;
    r.onTurn({ text: ask, frames: [], utteranceId: 2, replyText: Promise.resolve(null) });
    await r.settle();
    assert.equal(searches.length, pre, `reused: ${ask}`);
  }
});
