/**
 * Chelsea 11/4 (21:00 demo): "whatever I ask → search, and show the result as a sheet". An information
 * question that no card kind takes opens a web search; its results land in the same Finds sheet as an
 * "answer" card (apps render it with the link layout: takeaways + tappable sources). Chit-chat stays spoken.
 */
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { loadConfig } from "../src/config.ts";
import { Session, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import assert from "node:assert/strict";
import { classifyTurn } from "../src/finds/intent.ts";
import { GENERAL_REPLY_LINE, GENERAL_SAY, firstSentenceOnly, isGeneralAsk, runGeneral } from "../src/finds/general.ts";
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
  "오늘 서울 날씨 알려줄 수 있어",
  // P0 11/4 (device test): external, look-up-able only
  "Recommend a good dinner place near Gangnam",
  "Best KBBQ in Suwon?",
  // Codex r1 (narrowing)
  "who is the ceo of nintendo?",
  "닌텐도 CEO 누구야?",
  "Can you recommend a good dinner place near Gangnam for me?",
  // Codex r2 (narrowing)
  "where is the eiffel tower?",
  "에펠탑은 어디에 있어?",
  "Recommend a good cafe for me",
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
  // P0 11/4 (device test): personal advice / opinion is a spoken answer from the camera and her profile, never a web sheet
  "Recommend black or white for me",
  "Recommend black or white for my phone",
  "Recommend black or white",
  "Black or white?",
  "Which is better, black or white?",
  "What should I eat for dinner?",
  "Which color suits me?",
  "Should I get bangs?",
  "Suggest something to wear for me",
  "What's the best thing to do when you're bored?",
  "How come the sky is blue?",
  "What makes a good friend?",
  "Does black or white look good in daylight?",
  // Codex r3 (narrowing)
  "What's good?",
  "What's the vibe?",
  "What's the next step?",
  "어디까지 얘기 했지?",
  "행복은 어디서 오는 걸까?",
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

test("general (Codex r1): cooking with the camera stays a recipe even with 'near' / 'place' in it", () => {
  assert.deepEqual(classifyTurn("What can I make with ingredients near their expiration date?", true), { kind: "recipe" });
  assert.deepEqual(classifyTurn("How should I place ingredients in a bowl for dinner?", true), { kind: "recipe" });
  assert.deepEqual(classifyTurn("How do I make restaurant-style pasta with these ingredients?", true), { kind: "recipe" });
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
  assert.match(card.sources[0].title, /^Time Out: best ramen in Seoul — A recent roundup/);
  assert.equal(card.sources[0].url, "https://www.timeout.com/seoul/restaurants/best-ramen-in-seoul");
  assert.equal(card.steps.length, 1, "one summary line; each result once, in Sources");
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
  assert.equal(r.card.steps.length, 1);

  const none: ServerEvent[] = [];
  const r2 = await runGeneral(ctxFor(fakeVendors("{}", []), none));
  assert.equal(r2.card, null);
  assert.deepEqual(none.map((e) => e.type), ["find.started", "find.failed"]);
  const failed = none.find((e) => e.type === "find.failed") as Extract<ServerEvent, { type: "find.failed" }>;
  assert.deepEqual([failed.reason, failed.message], ["stopped", ""], "a failed search is silent (Chelsea 11/4: finds only add a sheet)");
  for (const e of none) assert.deepEqual(checkServerEvent(e), [], JSON.stringify(e));
});

test("general runner (mix): no fixed ack — the turn answers in one sentence itself; the card lands, then one line", async () => {
  const json = JSON.stringify({ title: "Ramen in Seoul", results: [{ title: "Time Out", why: "Roundup.", url: "https://www.timeout.com/seoul/restaurants/best-ramen-in-seoul" }] });
  const events: ServerEvent[] = [];
  const said: string[] = [];
  const r = new FindsRunner({ vendors: fakeVendors(json, TRACE), store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" }, { emit: (e) => events.push(e), announce: (t) => said.push(t), log: () => {}, now: () => 0 });
  const started = r.onTurn({ text: "What's the best ramen place in Seoul?", frames: [], utteranceId: 1, replyText: Promise.resolve(null) });
  assert.ok(started);
  assert.equal(started.kind, "answer");
  assert.equal(started.ack, undefined, "no fixed line: the reply answers from what it knows");
  await r.settle();
  assert.ok(events.some((e) => e.type === "find.created" && e.card.kind === "answer"));
  assert.deepEqual(said, [GENERAL_SAY]);
  assert.equal(r.onTurn({ text: "How are you?", frames: [], utteranceId: 2, replyText: Promise.resolve(null) }), null);
});

const collect = async (src: AsyncIterable<SparkStreamEvent>) => { const out: SparkStreamEvent[] = []; for await (const e of src) out.push(e); return out; };
async function* chunks(parts: string[]): AsyncIterable<SparkStreamEvent> {
  for (const p of parts) yield { type: "text", delta: p };
  yield { type: "done", responseId: "r", text: parts.join(""), status: "completed" };
}
const textOf = (evs: SparkStreamEvent[]) => evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");

test("firstSentenceOnly: one sentence, words streamed as they come, no links, abbreviations kept", async () => {
  const a = await collect(firstSentenceOnly(chunks(["It's Shuntaro ", "Furukawa, the pres", "ident. He has led ", "it since 2018."])));
  assert.equal(textOf(a).trim(), "It's Shuntaro Furukawa, the president.");
  assert.equal(a.at(-1)?.type, "done");
  assert.ok(a.filter((e) => e.type === "text").length >= 2, "streamed, not held to the end");
  const b = await collect(firstSentenceOnly(chunks(["The U.S. Open is in New York, see https://usopen.org", " for tickets. More here."])));
  assert.equal(textOf(b).trim(), "The U.S. Open is in New York, see for tickets.");
  const c = await collect(firstSentenceOnly(chunks(["Not sure off the top of my head, pulling up a few sources"])));
  assert.equal(textOf(c).trim(), "Not sure off the top of my head, pulling up a few sources");
  // Codex mix r1
  const d = await collect(firstSentenceOnly(chunks(["Mt. Everest is the tallest ", "mountain in the world. It is in Nepal."])));
  assert.equal(textOf(d).trim(), "Mt. Everest is the tallest mountain in the world.");
  const e = await collect(firstSentenceOnly(chunks(["I'll look that up. ", "Paris is the capital of France. ", "It is lovely."])));
  assert.match(textOf(e), /Paris is the capital of France\.$/, "a line the voice drops is not the one sentence");
  assert.doesNotMatch(textOf(e), /lovely/);
  const f = await collect(firstSentenceOnly(chunks(['See "https://example.com" or the [official site](https://example.dev) for details. More.'])));
  assert.doesNotMatch(textOf(f), /https?:|example\./, textOf(f));
  assert.match(textOf(f), /official site/);
  // Codex mix r2: tags don't hide a narration line, voice tags are kept
  const h = await collect(firstSentenceOnly(chunks(["<warm> I'll look that up. ", "<warm> [smile] Paris is the capital of France. ", "More."])));
  assert.match(textOf(h), /\[smile\] Paris is the capital of France\.$/, textOf(h));
  // a tool call after the sentence still reaches the session
  async function* withTool(): AsyncIterable<SparkStreamEvent> {
    yield { type: "text", delta: "Got it, more words here. " };
    yield { type: "text", delta: "And another sentence. " };
    yield { type: "function_call", name: "remember", call_id: "c1", arguments: "{}" };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  }
  const g = await collect(firstSentenceOnly(withTool()));
  assert.ok(g.some((x) => x.type === "function_call"), "remember still runs");
  assert.doesNotMatch(textOf(g), /another/);
  assert.equal(g.at(-1)?.type, "done");
});

// ───────── in a call (mix): one sentence now, the sheet fills, then one line ─────────

class Client implements ClientSink {
  events: ServerEvent[] = [];
  sendJson(e: unknown) { this.events.push(e as ServerEvent); }
  sendBinary() {}
  close() {}
}
const waitFor = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 2)); } };

test("general in a call (mix): one spoken sentence before the search lands, no links or result titles; the sheet fills; then one line", async () => {
  const json = JSON.stringify({ title: "Nintendo's CEO", results: [{ title: "Nintendo IR: management page", why: "Shuntaro Furukawa has been president since 2018.", url: "https://www.nintendo.co.jp/ir/en/management" }] });
  const trace = [searchItem("Nintendo CEO", ["https://www.nintendo.co.jp/ir/en/management"])];
  // the search takes a while; the spoken answer must not wait for it
  let releaseSearch: () => void = () => {};
  const searchGate = new Promise<void>((r) => (releaseSearch = r));
  const vendors = fakeVendors(json, trace);
  const slow: FindsVendors = { ...vendors, async spark(req, signal) { await searchGate; return vendors.spark(req, signal); } };
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const client = new Client();
  const reqs: SparkRequest[] = [];
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, speculate: false, sparkHedge: 1 },
    openAsr: () => asr,
    userId: "acct",
    async *spark(req): AsyncIterable<SparkStreamEvent> {
      reqs.push(req);
      yield* chunks(["It's Shuntaro Furukawa, ", "Nintendo's president. ", "Check https://www.nintendo.co.jp/ir for more. ", "He took over in 2018."]);
    },
    async *tts() {},
    finds: { vendors: slow, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" },
  };
  const s = new Session("g1", client, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  const spokenNow = () => client.events.filter((e) => e.type === "say" || e.type === "reply").map((e) => String((e as { text?: string }).text ?? "")).join(" | ");
  await s.onClientText(JSON.stringify({ type: "text", text: "Hey Rio, who's the CEO of Nintendo now?" }));
  await waitFor(() => /Furukawa/.test(spokenNow()));
  assert.ok(!client.events.some((e) => e.type === "find.created"), "spoken before the search resolved");
  assert.ok(client.events.some((e) => e.type === "find.started" && e.kind === "answer"), "the sheet starts at once");
  const reply = reqs.at(-1)!;
  assert.equal(reply.tools, undefined, "the reply itself never searches (the sheet does)");
  assert.ok(String(reply.instructions).includes(GENERAL_REPLY_LINE), "the one-sentence line rides the reply");
  releaseSearch();
  await waitFor(() => client.events.some((e) => e.type === "find.created"));
  await waitFor(() => spokenNow().includes(GENERAL_SAY), 8000).catch(() => {});
  const card = (client.events.find((e) => e.type === "find.created") as { card: FindCard }).card;
  assert.equal(card.kind, "answer");
  assert.deepEqual(card.sources.map((x) => x.domain), ["nintendo.co.jp"]);
  const spoken = spokenNow();
  const answer = spoken.split(GENERAL_SAY)[0];
  assert.doesNotMatch(answer, /https?:|www\.|nintendo\.co/i, `no links: ${spoken}`);
  assert.doesNotMatch(answer, /Nintendo IR: management page/, "no result titles");
  assert.doesNotMatch(answer, /2018/, `one sentence only: ${spoken}`);
  assert.ok(spoken.includes(GENERAL_SAY), `the card's line is said when it lands: ${spoken}`);
  s.close();
});

// ───────── P0 11/4 (prod Mac test): a general turn never ends in "Sorry, I lost you" ─────────

async function callWith(reply: () => AsyncIterable<SparkStreamEvent>) {
  const json = JSON.stringify({ title: "KBBQ in Suwon", results: [{ title: "Suwon galbi guide", why: "Five spots.", url: "https://www.timeout.com/suwon-galbi" }] });
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const client = new Client();
  const reqs: SparkRequest[] = [];
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, speculate: false, sparkHedge: 1 },
    openAsr: () => asr,
    userId: "acct",
    async *spark(req): AsyncIterable<SparkStreamEvent> { reqs.push(req); yield* reply(); },
    async *tts() {},
    finds: { vendors: fakeVendors(json, [searchItem("kbbq suwon", ["https://www.timeout.com/suwon-galbi"])]), store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" },
  };
  const s = new Session("p0", client, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: "What is the best KBBQ place in Suwon?" }));
  const spoken = () => client.events.filter((e) => e.type === "say" || e.type === "reply").map((e) => String((e as { text?: string }).text ?? "")).join(" | ");
  await waitFor(() => spoken().length > 0 && client.events.some((e) => e.type === "find.created"), 8000);
  await new Promise((r) => setTimeout(r, 50));
  s.close();
  return { spoken: spoken(), reqs, events: client.events };
}

test("P0: a general turn whose only sentence is a lookup announcement, a bare tag, or nothing (token cap) gets the hedge, never 'lost you'", async () => {
  for (const out of [["I'll look that up for you. "], ["<warm> "], []]) {
    const r = await callWith(() => chunks(out));
    assert.doesNotMatch(r.spoken, /lost you/i, `${JSON.stringify(out)} → ${r.spoken}`);
    assert.match(r.spoken, /off the top of my head/i, `${JSON.stringify(out)} → ${r.spoken}`);
    assert.ok(!r.events.some((e) => e.type === "error"), "no error card");
  }
});

test("P0 (Codex): the voice model failing twice on a general turn → the hedge, no error card / retry UI", async () => {
  // eslint-disable-next-line require-yield
  const r = await callWith(async function* () { throw new Error("upstream 503"); });
  assert.match(r.spoken, /off the top of my head/i, r.spoken);
  assert.doesNotMatch(r.spoken, /lost you/i);
  assert.ok(!r.events.some((e) => e.type === "error"), `no spark_unavailable: ${JSON.stringify(r.events.filter((e) => e.type === "error"))}`);
});

test("P0: the general reply keeps the normal output budget (reasoning spends ~120 tokens before any text)", async () => {
  const r = await callWith(() => chunks(["Galbi spots near Suwon station are a safe bet. "]));
  const req = r.reqs.at(-1)!;
  assert.ok((req.maxOutputTokens ?? 800) >= 800, `maxOutputTokens ${req.maxOutputTokens}`);
});

test("P0: the sheet card lists each result once (title — why, with its link) and has no empty 'Why these' / how lines", async () => {
  const json = JSON.stringify({ title: "Best ramen in Seoul", results: [
    { title: "Time Out: best ramen", why: "A roundup of 12 shops.", url: "https://www.timeout.com/seoul/restaurants/best-ramen-in-seoul" },
    { title: "Eater map", why: "Local picks.", url: "https://www.eater.com/maps/best-ramen-seoul" },
  ] });
  const events: ServerEvent[] = [];
  const r = await runGeneral(ctxFor(fakeVendors(json, TRACE), events));
  const card = r.card!;
  assert.deepEqual(card.sources.map((s) => s.title), ["Time Out: best ramen — A roundup of 12 shops.", "Eater map — Local picks."]);
  for (const s of card.sources) assert.equal(card.steps.filter((st) => st.text.includes(s.title.split(" — ")[0])).length, 0, "no second listing in the steps");
  assert.equal(card.steps.length, 1, "one summary line (the iPhone link layout always shows its Takeaways label)");
  assert.deepEqual(card.how, [], "the Mac shows how lines under 'Why these'");
  assert.deepEqual(card.why, []);
});
