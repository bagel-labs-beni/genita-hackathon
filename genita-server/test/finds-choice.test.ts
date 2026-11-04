import { test } from "node:test";
import assert from "node:assert/strict";
import { choiceForSearch, choiceOptions, spokenChoice } from "../src/finds/choice.ts";

test("black or white shoes: the search follows the spoken verdict (device 11/4)", () => {
  assert.deepEqual(choiceOptions("Black or white shoes for me?"), ["black", "white"]);
  assert.equal(choiceForSearch("Black or white shoes for me?", "Honestly, white suits you better with that outfit."), "white");
  assert.equal(choiceForSearch("Black or white shoes for me?", "Black is classic, but white suits you more."), "white");
  assert.equal(choiceForSearch("black or white shoes for me?", "I'd go with the white, black feels heavy here."), "white");
  assert.equal(spokenChoice(["black", "white"], "Black would look sharp on you."), "black");
});

test("no clear pick out loud: no search", () => {
  assert.equal(choiceForSearch("black or white shoes for me?", "Both work, depends on the vibe."), false);
  assert.equal(choiceForSearch("black or white shoes?", "Black and white both look great on you."), false);
});

test("not a choice ask: nothing enforced", () => {
  assert.equal(choiceForSearch("which jacket, this or that?", "The navy one."), null);
  assert.equal(choiceForSearch("find me some shoes", "Sure."), null);
});

// ───────── runner: the outfit verdict's follow-up search (device 11/4) ─────────
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";
import type { ServerEvent } from "../src/protocol.ts";

const FRAME = "data:image/jpeg;base64,AAA";
function newRunner(prompts: string[], events: ServerEvent[]): FindsRunner {
  const v: FindsVendors = {
    async spark(req) {
      const input = req.input as { content: { type: string; text?: string }[] }[];
      const parts = Array.isArray(input) ? input.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) : [];
      const text = parts.filter((p) => p.type === "input_text").map((p) => p.text).join("\n");
      prompts.push(text);
      // the pick model contradicts the spoken verdict (what happened on device)
      if (/"item"/.test(text)) return { text: JSON.stringify({ item: "shoes", color: "black", say: "Black shoes it is." }), output: [] };
      return { text: "", output: [] };
    },
    async *sparkStream() { yield { type: "done" as const, responseId: null, text: "", status: "completed" }; },
    async sam() { return []; },
    async image() { return Buffer.from([]); },
    async pageFacts() { return null; },
    async productImage() { return null; },
  };
  const r = new FindsRunner(
    { vendors: v, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds", productHedge: 1, productPrefetch: false, stillSearchingMs: 60_000 },
    { emit: (e) => events.push(e), announce: () => {}, log() {}, now: () => performance.now() },
  );
  r.configure({ owner: "u1", memories: [], profile: "" });
  return r;
}
const settle = () => new Promise((r) => setTimeout(r, 60));

test("runner: 'black or white shoes?' → 'white suits you' → 'find me some' searches white, never black", async () => {
  const prompts: string[] = [];
  const events: ServerEvent[] = [];
  const r = newRunner(prompts, events);
  const said = "White suits you better with that look. Want me to find a pair?";
  r.onTurn({ text: "Black or white shoes for me?", frames: [FRAME], utteranceId: 1, replyText: Promise.resolve(said) });
  await settle();
  const before = prompts.length;
  const s = r.onTurn({ text: "Yes, find me some", frames: [FRAME], utteranceId: 2, replyText: Promise.resolve(null), recent: [`You: ${said}`] });
  assert.equal(s?.kind, "product");
  await settle();
  const search = prompts.slice(before).find((p) => p.includes("Shop for exactly that"));
  assert.ok(search, "a product search ran with the pick");
  assert.ok(/in white/.test(search!), "searches the spoken white");
  assert.ok(!/in black/.test(search!), "never the black the pick model said");
  r.close();
});

test("runner: an 'A or B' verdict with no clear pick opens no product sheet", async () => {
  const prompts: string[] = [];
  const events: ServerEvent[] = [];
  const r = newRunner(prompts, events);
  const said = "Both work, honestly. Want me to find some?";
  r.onTurn({ text: "Black or white shoes for me?", frames: [FRAME], utteranceId: 1, replyText: Promise.resolve(said) });
  await settle();
  assert.equal(r.onTurn({ text: "Yes, find me some", frames: [FRAME], utteranceId: 2, replyText: Promise.resolve(null), recent: [`You: ${said}`] }), null);
  r.close();
});

import { readableTitle } from "../src/finds/general.ts";
test("web sheet rows never show a bare domain when the page path or line says more (device 11/4)", () => {
  assert.equal(readableTitle("", "", "https://www.maangchi.com/recipe/kimchi-bokkeumbap", "maangchi.com"), "Kimchi bokkeumbap");
  assert.equal(readableTitle("maangchi.com", "", "https://maangchi.com/recipe/kimchi-fried-rice/", "maangchi.com"), "Kimchi fried rice");
  assert.equal(readableTitle("www.example.com", "Easy kimchi fried rice in 15 minutes.", "https://www.example.com/p/123456", "example.com"), "Easy kimchi fried rice in 15 minutes");
  assert.equal(readableTitle("Kimchi Fried Rice", "", "https://x.com/", "x.com"), "Kimchi Fried Rice");
  assert.equal(readableTitle("", "", "https://x.com/", "x.com"), "x.com");
});
