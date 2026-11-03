/**
 * Chelsea 11/3: an answer the companion looked up on the web lands in the Finds sheet with its
 * sources, after the answer was said. No extra Spark call: the reply's own search results.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadConfig } from "../src/config.ts";
import { Session, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import { sparkStream, type SparkRequest, type SparkStreamEvent } from "../src/meta/spark.ts";
import { answerPoints, webAnswerCard } from "../src/finds/webAnswer.ts";
import type { FindCard, ServerEvent } from "../src/protocol.ts";

const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
const collect = async (source: AsyncIterable<SparkStreamEvent>) => { const out: SparkStreamEvent[] = []; for await (const e of source) out.push(e); return out; };
const SEARCH = {
  type: "web_search_call", id: "ws_1", status: "completed",
  action: { type: "search", query: "current CEO of Nintendo 2026", queries: ["current CEO of Nintendo 2026"], sources: [
    { type: "url", url: "https://www.nintendo.co.jp/ir/en/management" },
    { type: "url", url: "https://simplywall.st/a" },
    { type: "url", url: "https://simplywall.st/b" },
    { type: "url", url: "https://screenrant.com/c" },
    { type: "url", url: "https://famiboards.com/d" },
  ] },
};

test("Spark stream: asks for search sources with web_search and yields each finished search once", async (t) => {
  let sent: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return sse([
      { type: "response.created", response: { id: "r" } },
      { type: "response.output_text.delta", delta: "Let me check. " },
      { type: "response.output_item.done", item: SEARCH },
      { type: "response.output_text.delta", delta: "It's Shuntaro Furukawa." },
      { type: "response.completed", response: { id: "r", status: "completed", output: [SEARCH, { type: "web_search_call", id: "ws_2", action: { type: "open_page", url: "https://x.com" } }] } },
    ]);
  });
  const events = await collect(sparkStream("fake", { input: "who runs Nintendo?", tools: [{ type: "web_search" }] }));
  assert.deepEqual(sent.include, ["web_search_call.action.sources"]);
  const found = events.filter((e) => e.type === "sources");
  assert.equal(found.length, 1, "the completed copy and the open_page action add nothing");
  assert.deepEqual(found[0], { type: "sources", query: "current CEO of Nintendo 2026", urls: SEARCH.action.sources.map((s) => s.url) });
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { sent = JSON.parse(String(init.body)); return sse([{ type: "response.completed", response: { status: "completed", output: [] } }]); });
  await collect(sparkStream("fake", { input: "hi" }));
  assert.equal(sent.include, undefined, "no tools: no include");
});

test("the card: the spoken answer without the 'let me check' line, one source per site, at most 3", () => {
  assert.deepEqual(answerPoints("Got it — I'll quickly check who leads Nintendo right now. It's Shuntaro Furukawa — he's still Nintendo's president! He's held the role since June 2018."), [
    "It's Shuntaro Furukawa — he's still Nintendo's president!",
    "He's held the role since June 2018.",
  ]);
  const card = webAnswerCard({ id: "f1", question: "Who is the CEO of Nintendo?", said: "It's Shuntaro Furukawa.", searches: [{ query: SEARCH.action.query, urls: SEARCH.action.sources.map((s) => s.url) }] })!;
  assert.equal(card.kind, "answer");
  assert.equal(card.eyebrow, "From the web");
  assert.equal(card.title, "Current CEO of Nintendo 2026");
  assert.deepEqual(card.sources.map((s) => s.domain), ["nintendo.co.jp", "simplywall.st", "screenrant.com"]);
  assert.deepEqual(card.steps, [{ text: "It's Shuntaro Furukawa." }]);
  assert.equal(card.say, undefined, "already said: the card has no line of its own");
  assert.equal(webAnswerCard({ id: "f2", question: "q", said: "Hi.", searches: [{ query: "q", urls: [] }] }), null, "no pages, no card");
  assert.equal(webAnswerCard({ id: "f3", question: "q", said: "", searches: [{ query: "q", urls: ["https://a.com"] }] }), null, "nothing said, no card");
});

class Client implements ClientSink {
  events: ServerEvent[] = [];
  sendJson(e: unknown) { this.events.push(e as ServerEvent); }
  sendBinary() {}
  close() {}
}

function setup(script: (req: SparkRequest) => SparkStreamEvent[]) {
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const vendors = { async spark() { return { text: "", output: [] }; }, async *sparkStream() {}, async sam() { return []; }, async image() { return Buffer.from([0xff, 0xd8]); } };
  const client = new Client();
  const store = new MemoryFindsStore();
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, speculate: false, sparkHedge: 1 },
    openAsr: () => asr,
    userId: "acct",
    async *spark(req) { yield* script(req); },
    async *tts() {},
    finds: { vendors, store, images: false, imageBase: "/v1/finds" },
  };
  return { client, deps, store };
}
const waitFor = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 2)); } };

test("a looked-up answer: speech first, then the sheet card with its sources (kind answer)", async () => {
  const { client, deps } = setup(() => [
    { type: "text", delta: "It's Shuntaro Furukawa. He's been president since 2018." },
    { type: "sources", query: "current CEO of Nintendo", urls: ["https://www.nintendo.co.jp/ir", "https://screenrant.com/x"] },
    { type: "done", responseId: "r", text: "", status: "completed" },
  ]);
  const s = new Session("w1", client, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: "Who's the CEO of Nintendo now?" }));
  // device voice here: the card waits for the estimated end of playback (~4.6 s for this answer)
  await waitFor(() => client.events.some((e) => e.type === "find.created"), 10_000);
  const types = client.events.map((e) => e.type);
  assert.ok(types.lastIndexOf("reply") < types.indexOf("find.started"), "the answer is said before the sheet");
  const started = client.events.find((e) => e.type === "find.started") as Extract<ServerEvent, { type: "find.started" }>;
  assert.equal(started.kind, "answer");
  const card = (client.events.find((e) => e.type === "find.created") as { card: FindCard }).card;
  assert.equal(card.kind, "answer");
  assert.deepEqual(card.sources.map((x) => x.domain), ["nintendo.co.jp", "screenrant.com"]);
  assert.deepEqual(card.steps.map((x) => x.text), ["It's Shuntaro Furukawa.", "He's been president since 2018."]);
  assert.equal(client.events.filter((e) => e.type === "say" || e.type === "reply").filter((e) => "text" in e && /Shuntaro/.test(String(e.text))).length >= 1, true);
  s.close();
});

test("no card: an answer without a search, and a turn whose own card (link) runs", async () => {
  const { client, deps } = setup((req) => [
    { type: "text", delta: "Sure thing." },
    ...(JSON.stringify(req.input).includes("example.com") ? [{ type: "sources", query: "example", urls: ["https://example.com/a"] } as SparkStreamEvent] : []),
    { type: "done", responseId: "r", text: "", status: "completed" },
  ]);
  const s = new Session("w2", client, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: "How are you?" }));
  await waitFor(() => client.events.filter((e) => e.type === "reply").length >= 1);
  await s.onClientText(JSON.stringify({ type: "text", text: "Read this https://example.com/a" }));
  await waitFor(() => client.events.filter((e) => e.type === "reply").length >= 2);
  // past the end of playback, when an answer card would land
  await new Promise((r) => setTimeout(r, 3000));
  assert.ok(client.events.some((e) => e.type === "find.started" && e.kind === "link"), "the link turn ran its own card");
  assert.equal(client.events.filter((e) => e.type === "find.started" && e.kind === "answer").length, 0);
  s.close();
});
