/**
 * P0 11/5 00:55 KST (prod b8ea4abd, Chelsea's style flow): "I always wear black, I hate tight fits" → "Which one suits
 * me?" (two tops on camera) → "Find me some" came back as "Cozy Printed Pajamas — Loose prints in black and white"
 * (Amazon + Etsy, no pictures). The search subject must come from what she asked about (the picked top); her taste
 * only adds colour and fit; Amazon / Etsy pages we can't read with no picture give their place to shops that show one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import { decidePick, followUpSubject, loungeOnlyFromTaste } from "../src/finds/product.ts";
import type { FindsVendors, OutputItem } from "../src/finds/vendors.ts";
import type { FindCard, ServerEvent } from "../src/protocol.ts";

const FRAME = "data:image/jpeg;base64,AAA";
const PROFILE = "- Taste: wears black; hates tight fits, likes room to move";
const VERDICT = "The black oversized one, it gives you room to move and black is so you.";
const OPEN = (url: string): OutputItem => ({ type: "web_search_call", status: "completed", action: { type: "open_page", url } });
const textOf = (req: { input: unknown }) => {
  const input = req.input as { content: { type: string; text?: string }[] | string }[];
  return (Array.isArray(input) ? input : []).flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "input_text", text: String(m.content) }])).filter((p) => p.type === "input_text").map((p) => p.text).join("\n");
};

const AMAZON = "https://www.amazon.com/dp/B0COWPRINT1";
const ETSY = "https://www.etsy.com/listing/123456789/cow-print-pajama-set";
const TEE1 = "https://shop.example.com/products/black-oversized-tee";
const TEE2 = "https://other.example.com/products/relaxed-black-tee-123456";

test("prod 11/5 style flow: 'Find me some' after 'which one suits me' shops the picked top in black, never pajamas from 'room to move'", async () => {
  const prompts: string[] = [];
  const events: ServerEvent[] = [];
  const v: FindsVendors = {
    async spark(req) {
      const text = textOf(req);
      prompts.push(text);
      if (text.includes("Decide the ONE item")) {
        // what the pick model did in prod: the taste lines + the picture → sleepwear
        return { text: JSON.stringify({ item: "cozy printed pajamas", color: "black and white", say: "Loose black and white pajamas, so you." }), output: [] };
      }
      if (text.includes("label") && text.includes("options")) {
        return { text: JSON.stringify({ pick: 0, title: "Wear the black one.", taste: "", options: [{ label: "Black oversized tee", frame: 0 }, { label: "Grey fitted tee", frame: 0 }], why: ["Room to move.", "Tight."], ask: [], say: VERDICT }), output: [] };
      }
      if (text.includes("Shop for them")) {
        const items = [
          { name: "Cow Print Sleep Set", url: AMAZON, store: "Amazon", price: "$29", image: "", taste: "Loose", situation: "" },
          { name: "Cow Print Pajama Set", url: ETSY, store: "Etsy", price: "$45", image: "", taste: "Loose", situation: "" },
          { name: "Oversized black tee", url: TEE1, store: "Shop", price: "$30", image: "", taste: "Room to move", situation: "" },
          { name: "Relaxed black tee", url: TEE2, store: "Other", price: "$35", image: "", taste: "Black", situation: "" },
        ];
        return { text: JSON.stringify({ label: "Tees", title: "Black tees", subtitle: "Relaxed black tees.", style_line: "wears black; hates tight fits, likes room to move", items, say: "Room to move, all black." }), output: [OPEN(AMAZON), OPEN(ETSY), OPEN(TEE1), OPEN(TEE2)] };
      }
      return { text: "", output: [] };
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return []; },
    async image() { return Buffer.from([]); },
    // Amazon / Etsy block our reader (no facts); the two shops give a product page with a picture
    async pageFacts(url) { return /amazon|etsy/.test(url) ? null : { kind: "product", price: "$30", image: `${url}.jpg` }; },
    async productImage(url) { return /amazon|etsy/.test(url) ? null : Buffer.from([0xff, 0xd8, 0xff]); },
  };
  const r = new FindsRunner(
    { vendors: v, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds", productHedge: 1, productPrefetch: false, stillSearchingMs: 60_000 },
    { emit: (e) => events.push(e), announce: () => {}, log() {}, now: () => performance.now() },
  );
  r.configure({ owner: "u1", memories: [], profile: PROFILE });
  const settle = (ms = 80) => new Promise((res) => setTimeout(res, ms));
  process.env.GENITA_FIND_WEB_IMAGES = "0";
  try {
    assert.equal(r.onTurn({ text: "I always wear black, I hate tight fits", frames: [FRAME], utteranceId: 1, replyText: Promise.resolve("Noted, black and nothing tight.") }), null);
    const o = r.onTurn({ text: "Which one suits me?", frames: [FRAME, FRAME], utteranceId: 2, replyText: Promise.resolve(VERDICT) });
    assert.equal(o?.kind, "outfit");
    await settle();
    const before = prompts.length;
    const s = r.onTurn({ text: "Find me some", frames: [FRAME], utteranceId: 3, replyText: Promise.resolve(null), recent: ["User: I always wear black, I hate tight fits", "User: Which one suits me?", `You: ${VERDICT}`] });
    assert.equal(s?.kind, "product");
    await r.settle();
    const search = prompts.slice(before).find((p) => p.includes("Shop for them"))!;
    assert.ok(search, "a product search ran");
    assert.match(search, /every pick must be tees\b/, "the subject is the picked top's garment");
    assert.doesNotMatch(search, /pajama/i, "never the pick model's pajamas");
    assert.match(search, /never to choose a different kind of item/, "taste is only a modifier");
    const card = (events.find((e) => e.type === "find.created" && e.card.kind === "product") as { card: FindCard }).card;
    assert.deepEqual(card.products!.map((p) => p.url), [TEE1, TEE2], "shops whose pages give a picture; the blocked Amazon / Etsy ones wait");
    assert.ok(card.products!.every((p) => p.image), "every product shown has a picture slot");
  } finally {
    delete process.env.GENITA_FIND_WEB_IMAGES;
    r.close();
  }
});

test("follow-up subject: named now · offered · the picked option · the question; never from taste", async () => {
  assert.equal(followUpSubject({ text: "Find me some", said: VERDICT, question: "Which one suits me?", picked: "Black oversized tee" }), "tees");
  assert.equal(followUpSubject({ text: "Find me some boots", said: VERDICT, picked: "Black oversized tee" }), "boots");
  assert.equal(followUpSubject({ text: "yes", said: "The trench. Want me to find a pair for it?", picked: "Beige trench" }), "shoes");
  assert.equal(followUpSubject({ text: "yes", said: "The trench. Want me to find ankle boots for it?" }), "boots");
  assert.equal(followUpSubject({ text: "Find me some", said: "Black wins.", question: "Black or white shoes for me?" }), "shoes");
  assert.equal(followUpSubject({ text: "Find me some", said: "The black one, room to move." }), null);
  assert.equal(loungeOnlyFromTaste("cozy printed pajamas", "I always wear black, I hate tight fits"), true);
  assert.equal(loungeOnlyFromTaste("silk pajamas", "find me some silk pajamas"), false);
  const v = { async spark() { return { text: JSON.stringify({ item: "cozy printed pajamas", color: "black", say: "" }), output: [] }; } } as unknown as FindsVendors;
  assert.equal(await decidePick(v, { question: "Find me some", recent: ["User: I always wear black, I hate tight fits"], taste: [PROFILE], frames: [], signal: new AbortController().signal }), null, "the pick model's pajamas are dropped");
});

// ───────── prod 11/5 15:54–15:55 UTC (server-0100.jsonl): she did ask for pajamas ─────────

import { EventEmitter } from "node:events";
import { loadConfig } from "../src/config.ts";
import { Session, NO_PRODUCT_GUESS_LINE, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import { classifyTurn } from "../src/finds/intent.ts";
import { PICKS_PILL, cardLine, countPill } from "../src/finds/product.ts";

const ASK = "Can you find me some other design pajamas?";

test("prod utt 6 'Can you find me some other design pajamas?': a keyword product search (no judge, no free reply), pajamas allowed", async () => {
  assert.deepEqual(classifyTurn(ASK, true), { kind: "product" }, "the reply is the short reaction, never a model reply with its own web search");
  assert.equal(loungeOnlyFromTaste("black loose pajamas", ASK), false, "she said pajamas: the pick stands");
  const v = { async spark() { return { text: JSON.stringify({ item: "black loose pajamas", color: "black", say: "Black and roomy pajamas, got it." }), output: [] }; } } as unknown as FindsVendors;
  const p = await decidePick(v, { question: ASK, recent: ["User: Do I need to get tight pajamas?", "You: Nope, don't do it, Summer. That roomy fit suits you way better anyway."], taste: [PROFILE], frames: [FRAME], signal: new AbortController().signal });
  assert.equal(p?.item, "black loose pajamas");
});

test("prod utt 6 → 7: the card's line comes after its pictures, counts only what shows a picture and names a real returned product", async () => {
  const S1 = "https://www.amazon.com/dp/B0COWSET01";
  const S2 = "https://www.etsy.com/listing/22/cow-print-pajama-set";
  const S3 = "https://shop.example.com/products/black-relaxed-pajama-set";
  const said: string[] = [];
  const events: ServerEvent[] = [];
  const v: FindsVendors = {
    async spark(req) {
      const text = textOf(req);
      if (text.includes("Decide the ONE item")) return { text: JSON.stringify({ item: "black loose pajamas", color: "black", say: "Black and roomy pajamas, got it." }), output: [] };
      const items = [
        { name: "Cow Print Sleep Set", url: S1, store: "Amazon", price: "$29", image: "https://m.media-amazon.com/1.jpg", taste: "Loose", situation: "" },
        { name: "Cow Print Pajama Set", url: S2, store: "Etsy", price: "$45", image: "https://i.etsystatic.com/2.jpg", taste: "Loose", situation: "" },
        { name: "Relaxed black pajama set", url: S3, store: "Shop", price: "$40", image: "", taste: "Room to move", situation: "" },
      ];
      return { text: JSON.stringify({ label: "Pajamas", title: "Roomy pajamas", items, say: "Found 3 for you." }), output: [OPEN(S1), OPEN(S2), OPEN(S3)] };
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return []; },
    async image() { return Buffer.from([]); },
    async pageFacts(url) { return url === S3 ? { kind: "product", price: "$40", image: "https://shop.example.com/3.jpg" } : null; },
    // the Amazon / Etsy pictures never load (prod: product.image_omit product-1 and product-2)
    async productImage(url) { return url.includes("shop.example.com") ? Buffer.from([0xff, 0xd8, 0xff]) : null; },
  };
  const r = new FindsRunner(
    { vendors: v, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds", productHedge: 1, productPrefetch: false, stillSearchingMs: 60_000 },
    // as sent on the wire (JSON at send time): the runner updates its stored card in place afterwards
    { emit: (e) => events.push(JSON.parse(JSON.stringify(e))), announce: (t) => said.push(t), log() {}, now: () => performance.now() },
  );
  r.configure({ owner: "u1", memories: [], profile: PROFILE });
  process.env.GENITA_FIND_WEB_IMAGES = "0";
  try {
    const s = r.onTurn({ text: ASK, frames: [FRAME], utteranceId: 6, replyText: Promise.resolve(null), recent: ["User: Do I need to get tight pajamas?"] });
    assert.equal(s?.kind, "product");
    await r.settle();
    const created = (events.find((e) => e.type === "find.created") as { card: FindCard }).card;
    assert.equal(created.pill, PICKS_PILL, "no count before the pictures are in");
    const imgs = events.filter((e) => e.type === "find.image") as { slot: string; status: string }[];
    const ready = imgs.filter((e) => e.status === "ready").length;
    const line = said.at(-1)!;
    assert.ok(!said.includes("Found 3 for you."), `never the count of products without pictures: ${said.join(" | ")}`);
    const shown = created.products!.map((p, i) => ({ ...p, image: imgs.some((e) => e.slot === `product-${i + 1}` && e.status === "ready") ? { slot: `product-${i + 1}`, status: "ready" as const } : undefined }));
    assert.equal(ready, 1, "one picture loaded, as in prod");
    assert.equal(line, cardLine(shown, false));
    assert.equal(line, "Found one. The Relaxed black pajama set from Shop fits.");
    for (const name of ["panda", "heart-print"]) assert.doesNotMatch(line, new RegExp(name, "i"), "only returned products are named");
    // 11/5 scorecard: the pill shows the count again once the pictures are in (the app takes find.items.pill)
    const lastImage = events.map((e) => e.type).lastIndexOf("find.image");
    const pillUpdate = events.findIndex((e, i) => i > lastImage && e.type === "find.items" && (e as { findId: string }).findId === created.id);
    assert.ok(pillUpdate > 0, `a find.items pill update after the pictures: ${events.map((e) => e.type).join(",")}`);
    const upd = events[pillUpdate] as { pill?: string; items: unknown[]; checking: boolean };
    assert.equal(upd.pill, "Found one that fits.", "the count of products showing a picture, one line (≤ 28)");
    assert.deepEqual(upd.items, []);
    assert.equal(upd.checking, false);
    assert.ok(upd.pill!.length <= 28);
  } finally {
    delete process.env.GENITA_FIND_WEB_IMAGES;
    r.close();
  }
});

test("prod utt 6: every reply is told never to name products before a card shows them", async () => {
  class Client implements ClientSink { events: ServerEvent[] = []; sendJson(e: unknown) { this.events.push(e as ServerEvent); } sendBinary() {} close() {} }
  const reqs: SparkRequest[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const client = new Client();
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, speculate: false, sparkHedge: 1 },
    openAsr: () => asr,
    userId: "acct",
    async *spark(req): AsyncIterable<SparkStreamEvent> { reqs.push(req); yield { type: "text", delta: "Nope, roomy suits you." }; yield { type: "done", responseId: "r", text: "Nope, roomy suits you.", status: "completed" }; },
    async *tts() {},
    finds: { vendors: { async spark() { return { text: "", output: [] }; }, async *sparkStream() {}, async sam() { return []; }, async image() { return Buffer.from(""); } }, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" },
  };
  const s = new Session("nog", client, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: "Do I need to get tight pajamas?" }));
  const end = Date.now() + 5000;
  while (!reqs.length && Date.now() < end) await new Promise((res) => setTimeout(res, 5));
  assert.ok(String(reqs.at(-1)?.instructions).includes(NO_PRODUCT_GUESS_LINE));
  s.close();
});

test("countPill: the count of products showing a picture (all when none does), one line", () => {
  const p = (ready: boolean) => ({ id: "x", name: "n", url: "https://a.com/p", domain: "a.com", store: "A", taste: "", situation: "", ...(ready ? { image: { slot: "product-1", status: "ready" as const } } : {}) });
  assert.equal(countPill([p(true), p(false), p(true)]), "Found 2 for you.");
  assert.equal(countPill([p(false), p(false)]), "Found 2 for you.");
  assert.equal(countPill([p(true)]), "Found one that fits.");
  assert.ok(countPill(Array.from({ length: 6 }, () => p(true))).length <= 28);
});
