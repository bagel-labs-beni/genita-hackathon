/**
 * Chelsea 11/4 (21:00 demo): "whatever I ask → search, and show the result as a sheet". An information
 * question that no card kind takes opens a web search; its results land in the same Finds sheet as an
 * "answer" card (apps render it with the link layout: takeaways + tappable sources). Chit-chat stays spoken.
 */
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { loadConfig } from "../src/config.ts";
import { Session, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import assert from "node:assert/strict";
import { classifyTurn } from "../src/finds/intent.ts";
import { GENERAL_ACK, GENERAL_SAY, isGeneralAsk, runGeneral } from "../src/finds/general.ts";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import type { PipelineCtx } from "../src/finds/pipeline.ts";
import type { FindsVendors, OutputItem } from "../src/finds/vendors.ts";
import { checkServerEvent, type FindCard, type ServerEvent } from "../src/protocol.ts";

const FRAME = "data:image/jpeg;base64,AAAA";

export const OPENS_SHEET = [
  "Who won the World Series last night?",
  "What's the best ramen place in Seoul?",
  "Can you look up when the Met opens on Sunday?",
  "How do I get a red wine stain out of a carpet?",
  "What's the latest news on the Artemis mission?",
  "Do you know who the CEO of Nintendo is?",
  "How much does a Tesla Model 3 cost right now?",
  "Recommend a good sci-fi book for a long flight",
  "Hey Jin, which phone has the best camera in 2026?",
  "Where is the Eiffel Tower?",
  "Who won the U.S. Open this year?",
  // Codex r1
  "Who invented penicillin?",
  "What is photosynthesis?",
  "Where is Seoul?",
  "Look up how much it costs to visit the Louvre.",
  "How long does it take to fly from Seoul to Tokyo?",
  // Codex r2
  "Google ramen restaurants in Seoul",
  "Search Nintendo CEO",
  "How come the sky is blue?",
  "오늘 서울 날씨 알려줄 수 있어",
  // Codex r3
  "Jin, search Nintendo CEO",
  "What's the population of the US?",
  "서울에서 제일 맛있는 라멘집 어디야?",
  "오늘 뉴스 좀 찾아봐",
];

export const STAYS_SPOKEN = [
  "How are you?",
  "What do you think of me?",
  "Is this one better?",
  "What's your favorite color?",
  "Who are you?",
  "How do I look?",
  "What should I eat tonight?",
  "I feel kind of tired today",
  "Tell me a joke",
  "Thanks, that's great",
  "What is this?",
  "What about that one?",
  "How was your day?",
  "What did you find for me earlier?",
  "Which of these avocados looks ripe?",
  "send me the links",
  "너 오늘 기분 어때?",
  "이거 뭐야?",
  "What's the best way to kill myself?",
  // Codex r1
  "How about the black one?",
  "How about a quick chat?",
  "Do not search for anything, just chat with me.",
  "Google is great.",
  "서울 날씨 좋다",
  "오늘 뉴스 재밌었어",
  "What is next?",
  "How long does it take?",
  "Can you look it up?",
  "How long does it take to get there?",
  "How long does it take to get there by train?",
  "오늘 서울 날씨 알려줬네",
  // demo runbook (QA 11/4): other paths own these
  "I have no idea what to wear today. It's for the Halloween party tonight. Jin, can you help me pick an outfit?",
  "Find me some.",
  "Yes please",
  "Hey Jin, I'm back.",
  "What is it like?",
];

test("general: information questions open a web search, with or without the camera", () => {
  for (const line of OPENS_SHEET) {
    assert.deepEqual(classifyTurn(line, false), { kind: "answer" }, `no camera: ${line}`);
    assert.deepEqual(classifyTurn(line, true), { kind: "answer" }, `camera on: ${line}`);
  }
});

test("general: chit-chat, feelings, things in view and crisis lines stay spoken", () => {
  for (const line of STAYS_SPOKEN) {
    assert.equal(classifyTurn(line, false), null, `no camera: ${line}`);
    // with the camera on a card kind may still take it ("what should I eat tonight?" → recipe), never a search
    assert.notEqual(classifyTurn(line, true)?.kind, "answer", `camera on: ${line}`);
  }
});

test("general: the demo lines keep their own cards", () => {
  assert.deepEqual(classifyTurn("Hey Jin, what can I make with these ingredients?", true), { kind: "recipe" });
  assert.equal(classifyTurn("Hey Jin, what can I make with these ingredients?", false), null, "no camera: nothing to cook from, no search");
  assert.deepEqual(classifyTurn("Can you find me shoes that would go with this?", true), { kind: "product" });
  assert.deepEqual(classifyTurn("Can you find me shoes that would go with this?", false), { kind: "product" });
  assert.equal(classifyTurn("Is this one better?", true), null);
  assert.equal(classifyTurn("How are you?", true), null);
  assert.deepEqual(classifyTurn("look at https://x.com/a", false), { kind: "link", url: "https://x.com/a" });
});

test("general: the real Spark call asks for every page each search returned (web_search_call.action.sources)", async (t) => {
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_u: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ id: "r", output: [] }), { status: 200, headers: { "content-type": "application/json" } }); });
  const { metaVendors } = await import("../src/finds/vendors.ts");
  await metaVendors("fake").spark({ input: "q", tools: [{ type: "web_search" }] });
  assert.deepEqual(body.include, ["web_search_call.action.sources"]);
  await metaVendors("fake").spark({ input: "q" });
  assert.equal(body.include, undefined, "no tools, no include");
});

test("general pipeline: a result keeps its own page (?v=alpha is not ?v=beta); tracking parameters don't matter", async () => {
  const { pickResults } = await import("../src/finds/general.ts");
  const traced = ["https://www.youtube.com/watch?v=beta", "https://www.youtube.com/watch?v=alpha", "https://news.example.org/a"];
  const r = pickResults({ results: [
    { title: "Alpha", why: "a", url: "https://youtube.com/watch?v=alpha&utm_source=x" },
    { title: "News", why: "n", url: "https://news.example.org/a/?utm_campaign=y#top" },
  ] }, traced);
  assert.deepEqual(r.map((x) => x.url), ["https://www.youtube.com/watch?v=alpha", "https://news.example.org/a"]);
});

test("general: GENITA_WEB_SEARCH=0 (the companion's web search switch) turns it off", () => {
  assert.equal(isGeneralAsk("Who won the World Series last night?", { GENITA_WEB_SEARCH: "0" }), false);
  assert.equal(isGeneralAsk("Who won the World Series last night?", {}), true);
});

// ───────── the pipeline ─────────

const searchItem = (query: string, urls: string[]): OutputItem =>
  ({ type: "web_search_call", status: "completed", action: { type: "search", query, sources: urls.map((url) => ({ type: "url", url })) } }) as OutputItem;

function fakeVendors(text: string, output: OutputItem[], seen: { reqs: unknown[] } = { reqs: [] }): FindsVendors {
  return {
    async spark(req) { seen.reqs.push(req); return { text, output }; },
    async *sparkStream() {},
    async sam() { return []; },
    async image() { return Buffer.from(""); },
  };
}

function ctxFor(vendors: FindsVendors, events: ServerEvent[], question = "What's the best ramen place in Seoul?"): PipelineCtx {
  return {
    findId: "f1", utteranceId: 3, kind: "answer", question, frames: [], memories: [], replyText: Promise.resolve(null),
    vendors, emit: (e) => events.push(e), signal: new AbortController().signal, now: () => 0, log: () => {}, images: false,
    putImage: async () => "x",
  };
}

const TRACE = [
  searchItem("best ramen Seoul", [
    "https://www.timeout.com/seoul/restaurants/best-ramen-in-seoul",
    "https://www.eater.com/maps/best-ramen-seoul",
    "https://spam-ramen.xyz/top",
    "https://5tar.duckdns.org/ramen",
    "https://www.michelin.com/seoul/ramen",
    "https://en.wikipedia.org/wiki/Ramen",
  ]),
];

test("general pipeline: up to 5 results, each a page the search really returned; blocked and made-up links dropped", async () => {
  const json = JSON.stringify({
    title: "Best ramen in Seoul",
    results: [
      { title: "Time Out: best ramen in Seoul", why: "A recent roundup of 12 shops with prices.", url: "https://www.timeout.com/seoul/restaurants/best-ramen-in-seoul" },
      { title: "Eater map", why: "Local picks with opening hours.", url: "https://www.eater.com/maps/best-ramen-seoul" },
      { title: "Spam list", why: "Top ramen.", url: "https://spam-ramen.xyz/top" },
      { title: "Dynamic DNS host", why: "Seen in the real e2e run (11/4).", url: "https://5tar.duckdns.org/ramen" },
      { title: "Made up", why: "Not in the search.", url: "https://made-up.example/ramen" },
      { title: "Eater 2026", why: "Another page of a site the search returned (Codex r1).", url: "https://www.eater.com/maps/best-ramen-seoul-2026" },
      { title: "Michelin Guide", why: "Bib Gourmand ramen spots.", url: "https://www.michelin.com/seoul/ramen?ref=x" },
    ],
    ask: ["Which is closest?", "Any vegan ones?"],
  });
  const seen = { reqs: [] as unknown[] };
  const events: ServerEvent[] = [];
  const r = await runGeneral(ctxFor(fakeVendors(json, TRACE, seen), events));
  const card = r.card as FindCard;
  assert.ok(card, "a card");
  assert.equal(card.kind, "answer");
  assert.equal(card.title, "Best ramen in Seoul");
  assert.equal(card.say, GENERAL_SAY, "spoken: a short line, never the results");
  assert.deepEqual(card.sources.map((s) => s.domain), ["timeout.com", "eater.com", "michelin.com"]);
  assert.equal(card.sources[0].title, "Time Out: best ramen in Seoul");
  assert.equal(card.steps.length, 3);
  assert.match(card.steps[0].text, /Time Out: best ramen in Seoul — A recent roundup/);
  assert.equal(card.steps[0].source, "https://www.timeout.com/seoul/restaurants/best-ramen-in-seoul");
  assert.ok(card.sources.length >= 1 && card.sources.length <= 5);
  assert.deepEqual(card.reasons, [], "never taste chips on a looked-up fact");
  // the search is a real web search, the app sees started → created, both valid protocol events
  assert.deepEqual((seen.reqs[0] as { tools: unknown[] }).tools, [{ type: "web_search" }]);
  assert.deepEqual(events.map((e) => e.type), ["find.started", "find.created"]);
  for (const e of events) assert.deepEqual(checkServerEvent(e), [], JSON.stringify(e));
  const started = events[0] as Extract<ServerEvent, { type: "find.started" }>;
  assert.equal(started.kind, "answer");
});

test("general pipeline: no usable JSON but the search ran → the search's own pages; nothing at all → failed", async () => {
  const events: ServerEvent[] = [];
  const r = await runGeneral(ctxFor(fakeVendors("Sorry, here are some thoughts.", TRACE), events));
  assert.ok(r.card);
  assert.ok(r.card.sources.length >= 1 && r.card.sources.length <= 5);
  assert.ok(!r.card.sources.some((s) => s.domain.endsWith(".xyz") || s.domain.endsWith("duckdns.org")));
  assert.equal(r.card.steps.length, r.card.sources.length);

  const none: ServerEvent[] = [];
  const r2 = await runGeneral(ctxFor(fakeVendors("{}", []), none));
  assert.equal(r2.card, null);
  assert.deepEqual(none.map((e) => e.type), ["find.started", "find.failed"]);
  for (const e of none) assert.deepEqual(checkServerEvent(e), [], JSON.stringify(e));
});

test("general runner: an info question gets a short spoken ack, the card lands in the sheet, then one line", async () => {
  const json = JSON.stringify({ title: "Ramen in Seoul", results: [{ title: "Time Out", why: "Roundup.", url: "https://www.timeout.com/seoul/restaurants/best-ramen-in-seoul" }] });
  const events: ServerEvent[] = [];
  const said: string[] = [];
  const r = new FindsRunner({ vendors: fakeVendors(json, TRACE), store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" }, { emit: (e) => events.push(e), announce: (t) => said.push(t), log: () => {}, now: () => 0 });
  const started = r.onTurn({ text: "What's the best ramen place in Seoul?", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  assert.ok(started);
  assert.equal(started.kind, "answer");
  assert.equal(started.ack, GENERAL_ACK);
  await r.settle();
  assert.ok(events.some((e) => e.type === "find.created" && e.card.kind === "answer"));
  assert.deepEqual(said, [GENERAL_SAY]);
  assert.equal(r.onTurn({ text: "How are you?", frames: [], utteranceId: 2, replyText: Promise.resolve(null) }), null);
});

// ───────── in a call: the ack is said, the results are not ─────────


class Client implements ClientSink {
  events: ServerEvent[] = [];
  sendJson(e: unknown) { this.events.push(e as ServerEvent); }
  sendBinary() {}
  close() {}
}
const waitFor = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 2)); } };

test("general in a call: a short reaction is said, the card lands in the sheet, the results are never read aloud", async () => {
  const json = JSON.stringify({ title: "Nintendo's CEO", results: [{ title: "Nintendo IR: management", why: "Shuntaro Furukawa has been president since 2018.", url: "https://www.nintendo.co.jp/ir/en/management" }] });
  const trace = [searchItem("Nintendo CEO", ["https://www.nintendo.co.jp/ir/en/management"])];
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const client = new Client();
  let replies = 0;
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, speculate: false, sparkHedge: 1 },
    openAsr: () => asr,
    userId: "acct",
    // a full spoken answer would name him: it must never be what's said
    async *spark(): AsyncIterable<SparkStreamEvent> { replies++; yield { type: "text", delta: "It's Shuntaro Furukawa." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts() {},
    finds: { vendors: fakeVendors(json, trace), store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" },
  };
  const s = new Session("g1", client, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: "Hey Rio, who's the CEO of Nintendo now?" }));
  await waitFor(() => client.events.some((e) => e.type === "find.created"));
  const said = () => client.events.filter((e) => e.type === "say" || e.type === "reply").map((e) => String((e as { text?: string }).text ?? "")).join(" | ");
  await waitFor(() => said().includes(GENERAL_SAY), 8000).catch(() => {});
  const card = (client.events.find((e) => e.type === "find.created") as { card: FindCard }).card;
  assert.equal(card.kind, "answer");
  assert.deepEqual(card.sources.map((x) => x.domain), ["nintendo.co.jp"]);
  const spoken = said();
  assert.match(spoken, /good question/i, spoken);
  assert.ok(spoken.includes(GENERAL_SAY), `the card's line is said when it lands: ${spoken}`);
  assert.doesNotMatch(spoken, /Furukawa/, "the results are not read aloud");
  s.close();
});
