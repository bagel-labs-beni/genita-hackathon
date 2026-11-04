/**
 * Prod 11/4 14:35–14:36 UTC (Chelsea's Mac, server-2330.jsonl): utt 18 "Best ramen places in Seoul" → the hedge
 * "Not sure off the top of my head, pulling up a few sources." + the card's line; utt 20 "How many How do I fold a
 * fitted sheet?" was answered with the ramen picks ("Okay Summer, top picks are Oreno Ramen…") and got no card.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadConfig } from "../src/config.ts";
import { Session, earlierAskLine, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import { GENERAL_HEDGE, GENERAL_REPLY_LINE, HOWTO_SAY, PLACE_ACK, PLACE_SAY, asrRestart, generalLayout } from "../src/finds/general.ts";
import { classifyTurn } from "../src/finds/intent.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import type { FindsVendors, OutputItem } from "../src/finds/vendors.ts";
import type { FindCard, ServerEvent } from "../src/protocol.ts";

class Client implements ClientSink {
  events: ServerEvent[] = [];
  sendJson(e: unknown) { this.events.push(e as ServerEvent); }
  sendBinary() {}
  close() {}
}
const waitFor = async (check: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 2)); } };
async function* chunks(parts: string[]): AsyncIterable<SparkStreamEvent> {
  for (const p of parts) yield { type: "text", delta: p };
  yield { type: "done", responseId: "r", text: parts.join(""), status: "completed" };
}
const searchItem = (urls: string[]): OutputItem => ({ type: "web_search_call", status: "completed", action: { type: "search", query: "q", sources: urls.map((url) => ({ type: "url", url })) } }) as OutputItem;

const RAMEN = "https://www.timeout.com/seoul/restaurants/best-ramen-in-seoul";
const SHEET = "https://www.marthastewart.com/how-to-fold-a-fitted-sheet";
const RAMEN_NARRATION = "Got it. Okay Summer, top picks are Oreno Ramen, Yuzu Fine Ramen, and Menya Sandaime.";
const Q1 = "Best ramen places in Seoul";
const Q2 = "How many How do I fold a fitted sheet?";

test("prod utt 18 → 20: the ramen search's answer never becomes the reply to the fitted-sheet question; that one gets its own how-to card", async () => {
  // the finds pipeline's own web search
  const vendors: FindsVendors = {
    async spark(req) {
      const q = JSON.stringify(req.input);
      if (q.includes("fitted sheet")) return { text: JSON.stringify({ title: "Fold a fitted sheet", results: [{ title: "How to fold a fitted sheet", why: "Step by step.", url: SHEET }], steps: ["Tuck the corners together.", "Fold into a rectangle."] }), output: [searchItem([SHEET])] };
      return { text: JSON.stringify({ title: "Best ramen in Seoul", results: [{ title: "Oreno Ramen", why: "Michelin Bib Gourmand.", url: RAMEN, address: "Mapo-gu", rating: 4.6 }] }), output: [searchItem([RAMEN])] };
    },
    async *sparkStream() {},
    async sam() { return []; },
    async image() { return Buffer.from(""); },
  };
  const reqs: SparkRequest[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const client = new Client();
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, speculate: false, sparkHedge: 1 },
    openAsr: () => asr,
    userId: "acct",
    // the voice model as it behaved in prod: the hedge on the search turn; on the next turn, with its own web search
    // and nothing saying the ramen question is done, it answers the open "pulling up a few sources" promise
    async *spark(req): AsyncIterable<SparkStreamEvent> {
      reqs.push(req);
      const last = JSON.stringify((req.input as unknown[]).at(-1));
      if (last.includes("ramen")) return yield* chunks([GENERAL_HEDGE]);
      const settled = String(req.instructions).includes("is already answered by the card");
      if (req.tools?.length && !settled) return yield* chunks([RAMEN_NARRATION]);
      yield* chunks(["Tuck the corners into each other first."]);
    },
    async *tts() {},
    finds: { vendors, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" },
  };
  const s = new Session("bleed", client, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  const spoken = () => client.events.filter((e) => e.type === "say" || e.type === "reply").map((e) => String((e as { text?: string }).text ?? "")).join(" | ");
  const created = () => client.events.filter((e): e is Extract<ServerEvent, { type: "find.created" }> => e.type === "find.created");

  // utt 18 + its card (utt 19)
  await s.onClientText(JSON.stringify({ type: "text", text: Q1 }));
  // 11/5 eval 5c: a place question says a short line, then the card names the top result it found
  await waitFor(() => created().length === 1 && spoken().includes("Oreno Ramen is the top pick"));
  assert.ok(spoken().startsWith(PLACE_ACK), spoken());
  const ramen = created()[0].card as FindCard;
  assert.equal(ramen.layout, "place", "a place question is the place card, not a list of links");
  assert.equal(ramen.sources[0].place?.mapUrl?.startsWith("https://maps.apple.com/?q="), true);

  // utt 20
  const before = spoken().length;
  await s.onClientText(JSON.stringify({ type: "text", text: Q2 }));
  await waitFor(() => created().length === 2);
  await waitFor(() => spoken().slice(before).includes("corners"));
  const reply = reqs.at(-1)!;
  const said = spoken().slice(before);
  assert.doesNotMatch(said, /Oreno|ramen/i, `the ramen answer bled into the next turn: ${said}`);
  assert.equal(reply.tools, undefined, "the how-to reply doesn't search (the card does)");
  assert.ok(String(reply.instructions).includes(GENERAL_REPLY_LINE));
  assert.ok(String(reply.instructions).includes(earlierAskLine(Q1)), "the earlier question is marked done");
  assert.match(JSON.stringify((reply.input as unknown[]).at(-1)), /fitted sheet/);
  const sheet = created()[1].card as FindCard;
  assert.equal(sheet.layout, "how-to");
  assert.deepEqual(sheet.steps.map((x) => x.text), ["Tuck the corners together.", "Fold into a rectangle."]);
  await waitFor(() => spoken().includes(HOWTO_SAY));
  s.close();
});

test("ASR false start: the question is judged from where it starts again", () => {
  assert.equal(asrRestart(Q2), "How do I fold a fitted sheet?");
  assert.equal(asrRestart("So What is the Eiffel Tower?"), "What is the Eiffel Tower?");
  assert.equal(asrRestart("Hey Rio, How are you"), "Hey Rio, How are you", "punctuation before it: not a restart");
  assert.equal(asrRestart("How do I fold it"), "How do I fold it");
  assert.deepEqual(classifyTurn(Q2, false), { kind: "answer" });
  assert.equal(generalLayout(Q2), "how-to");
  for (const q of ["Best ramen places in Seoul", "best sushi restaurants in Tokyo", "where to eat in Busan", "best places to eat in Seoul"]) {
    assert.deepEqual(classifyTurn(q, false), { kind: "answer" }, q);
    assert.equal(generalLayout(q), "place", q);
  }
  assert.equal(generalLayout("What is the Eiffel Tower?"), "general");
});

test("prod utt 17 'Two side by side, pick fast.': kept only on a card with exactly two products (#777 count check)", async () => {
  const { countFits, foundSay } = await import("../src/finds/product.ts");
  assert.equal(countFits("Two side by side, pick fast.", 2), true);
  for (const n of [3, 6]) {
    assert.equal(countFits("Two side by side, pick fast.", n), false, `${n} products`);
    assert.ok(countFits(foundSay(n), n));
  }
});
