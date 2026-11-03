/**
 * Demo S4: on an iPhone call, when the account's Mac app is open (presence active) and the user asks what to
 * wear, the companion suggests moving the call to the Mac so it can see the whole outfit — once per call,
 * no outfit card from the phone's frames on that turn. Nothing changes without a Mac, on the Mac, or for
 * other questions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { Session, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import { HandoffHub } from "../src/handoff/hub.ts";
import { MemoryOwnershipStore } from "../src/handoff/store.ts";
import { isOutfitAsk } from "../src/finds/intent.ts";
import type { ServerEvent } from "../src/protocol.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";

const config = { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, webSearch: false, speculate: false, sparkHedge: 1 };
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
async function waitFor(check: () => boolean, ms = 3000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("test timed out"); await pause(); } }
const MAC_LINE = /move this call to their Mac/;
const ASK = "I have no idea what to wear today. Rio, can you help me pick an outfit?";

function setup(macNearby?: () => boolean, fail?: { on: boolean; partial?: boolean; incomplete?: boolean }) {
  const requests: SparkRequest[] = [];
  const events: ServerEvent[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const findCalls: string[] = [];
  const vendors = {
    async spark() { findCalls.push("spark"); return { text: "", output: [] }; },
    async *sparkStream() { findCalls.push("sparkStream"); },
    async sam() { findCalls.push("sam"); return []; },
    async image() { findCalls.push("image"); return Buffer.from([0xff, 0xd8]); },
  };
  const deps: SessionDeps = {
    config, openAsr: () => asr, userId: "acct",
    async *spark(req) { requests.push(req); if (fail?.on && fail.incomplete) { yield { type: "text", delta: "Sure, I can help. " }; yield { type: "done", responseId: "r", text: "", status: "incomplete" }; return; } if (fail?.on && fail.partial) { yield { type: "text", delta: "Sure, I can help. " }; throw new Error("stream cut"); } if (fail?.on) throw new Error("upstream 503"); yield { type: "text", delta: MAC_LINE.test(req.instructions ?? "") ? "Can we move this call to your Mac? I want to see the whole outfit." : "Sure." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts() {},
    macNearby,
  };
  const sink: ClientSink = { sendJson: (e) => { events.push(e as ServerEvent); }, sendBinary() {}, close() {} };
  return { deps, sink, requests, events, vendors, findCalls };
}
const replies = (events: ServerEvent[]) => events.filter((e) => e.type === "reply").length;

test("isOutfitAsk: the S4 phone line and 'what should I wear' count; cooking, shopping and small talk do not", () => {
  assert.equal(isOutfitAsk(ASK), true);
  assert.equal(isOutfitAsk("What should I wear to the party tonight?"), true);
  assert.equal(isOutfitAsk("What should I wear to dinner tonight?"), true, "dinner is the occasion, not cooking (Codex P2)");
  assert.equal(isOutfitAsk("Which one is better, Python or JavaScript?"), false, "a bare comparison is not about clothes (Codex P2)");
  assert.equal(isOutfitAsk("What can I cook for dinner?"), false);
  assert.equal(isOutfitAsk("Summarize this page: https://fashion.example.com/outfit"), false, "a link card, not an outfit ask (Codex P2, round 3)");
  assert.equal(isOutfitAsk("What can I make with these ingredients?"), false);
  assert.equal(isOutfitAsk("Can you find me some dark brown shoes?"), false, "a product search, not an outfit ask");
  assert.equal(isOutfitAsk("How was your day?"), false);
});

test("iPhone call, Mac app open: an outfit ask gets the move-to-Mac line, once per call", async () => {
  const { deps, sink, requests, events } = setup(() => true);
  const s = new Session("p1", sink, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: ASK }));
  await waitFor(() => replies(events) >= 1);
  assert.match(requests.at(-1)!.instructions ?? "", MAC_LINE, "the companion is told to suggest the Mac");
  await s.onClientText(JSON.stringify({ type: "text", text: "Just tell me what to wear here." }));
  await waitFor(() => replies(events) >= 2);
  assert.doesNotMatch(requests.at(-1)!.instructions ?? "", MAC_LINE, "asked once; the user can say no");
  s.close();
});

test("a failed first reply does not use up the suggestion: the retry asks again (Codex P2)", async () => {
  const fail = { on: true };
  const { deps, sink, requests, events } = setup(() => true, fail);
  const s = new Session("p4", sink, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: ASK }));
  await waitFor(() => events.some((e) => e.type === "reply" || e.type === "error"));
  await new Promise((r) => setTimeout(r, 50));
  // every attempt failed: only the in-character "lost you" line was said (Spark outage rule), never the suggestion
  assert.deepEqual(events.filter((e) => e.type === "reply" && e.text).map((e) => (e as { text: string }).text), ["Sorry, I lost you for a sec. Say that again?"]);
  fail.on = false;
  const n = requests.length;
  await s.onClientText(JSON.stringify({ type: "text", text: ASK }));
  await waitFor(() => requests.length > n);
  assert.match(requests.at(-1)!.instructions ?? "", MAC_LINE, "nothing was said the first time");
  s.close();
});

test("a reply cut off mid-stream does not use up the suggestion (Codex P2, round 2)", async () => {
  const fail = { on: true, partial: true };
  const { deps, sink, requests, events } = setup(() => true, fail);
  const s = new Session("p5", sink, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: ASK }));
  await waitFor(() => events.some((e) => e.type === "reply"));
  await new Promise((r) => setTimeout(r, 50));
  fail.on = false;
  const n = requests.length;
  await s.onClientText(JSON.stringify({ type: "text", text: ASK }));
  await waitFor(() => requests.length > n);
  assert.match(requests.at(-1)!.instructions ?? "", MAC_LINE, "the cut-off reply may not have said it");
  s.close();
});

test("a reply that ends incomplete before naming the Mac does not use up the suggestion (Codex P2, round 3)", async () => {
  const fail = { on: true, incomplete: true };
  const { deps, sink, requests, events } = setup(() => true, fail);
  const s = new Session("p7", sink, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: ASK }));
  await waitFor(() => events.some((e) => e.type === "reply"));
  await new Promise((r) => setTimeout(r, 30));
  fail.on = false;
  const n = requests.length;
  await s.onClientText(JSON.stringify({ type: "text", text: ASK }));
  await waitFor(() => requests.length > n);
  assert.match(requests.at(-1)!.instructions ?? "", MAC_LINE);
  s.close();
});

test("product refines keep counting for the whole search window, not just the last few lines (Codex P2, round 3)", async () => {
  const { deps, sink, requests, events, vendors } = setup(() => true);
  const { MemoryFindsStore } = await import("../src/finds/store.ts");
  const s = new Session("p8", sink, { ...deps, finds: { vendors, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" } });
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: "Can you look for a jacket for this weekend?" }));
  await waitFor(() => replies(events) >= 1);
  for (const [i, t] of ["Something cheaper?", "Another color?", "Cheaper still?", "In navy?"].entries()) {
    await s.onClientText(JSON.stringify({ type: "text", text: t }));
    await waitFor(() => replies(events) >= i + 2);
  }
  const n = replies(events);
  await s.onClientText(JSON.stringify({ type: "text", text: "Another one in black to go with this outfit." }));
  await waitFor(() => replies(events) > n);
  assert.doesNotMatch(requests.at(-1)?.instructions ?? "", MAC_LINE);
  s.close();
});

test("a product follow-up after a search is not an outfit ask (Codex P2, round 2)", async () => {
  const { deps, sink, requests, events } = setup(() => true);
  const s = new Session("p6", sink, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: "Can you look for a jacket for this weekend?" }));
  await waitFor(() => replies(events) >= 1);
  await s.onClientText(JSON.stringify({ type: "text", text: "Another one in black to go with this outfit." }));
  await waitFor(() => replies(events) >= 2);
  assert.doesNotMatch(requests.at(-1)!.instructions ?? "", MAC_LINE, "a refine of the search, not 'what should I wear'");
  s.close();
});

test("no Mac, a Mac call, or a non-outfit question: no move-to-Mac line", async () => {
  for (const [label, nearby, text] of [
    ["no Mac open", () => false, ASK],
    ["not an iPhone call (no hook)", undefined, ASK],
    ["not about clothes", () => true, "What can I make with these ingredients?"],
  ] as const) {
    const { deps, sink, requests, events } = setup(nearby);
    const s = new Session("p2", sink, deps);
    await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
    await s.onClientText(JSON.stringify({ type: "text", text }));
    await waitFor(() => replies(events) >= 1);
    assert.doesNotMatch(requests.at(-1)!.instructions ?? "", MAC_LINE, label);
    s.close();
  }
});

test("camera still on (from the kitchen): the suggest turn starts no outfit card from the phone's frames", async () => {
  const { deps, sink, requests, events, vendors, findCalls } = setup(() => true);
  const { MemoryFindsStore } = await import("../src/finds/store.ts");
  const s = new Session("p3", sink, { ...deps, finds: { vendors, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" } });
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: ASK, frames: ["AAAA", "BBBB"] }));
  await waitFor(() => replies(events) >= 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.match(requests.at(-1)!.instructions ?? "", MAC_LINE);
  assert.equal(events.filter((e) => e.type === "find.started").length, 0, "no outfit card on the suggest turn");
  assert.deepEqual(findCalls, [], "no Finds vendor calls");
  s.close();
});

test("hub.isPresent: an open, active Mac presence counts; locked or closed does not", () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  assert.equal(hub.isPresent("u", "mac"), false);
  const mac = hub.connect("u", { device: "mac", send() {} });
  assert.equal(hub.isPresent("u", "mac"), true);
  assert.equal(hub.isPresent("other", "mac"), false, "never another account's Mac");
  mac.setActive(false);
  assert.equal(hub.isPresent("u", "mac"), false, "Mac asleep or locked");
  mac.setActive(true);
  mac.close();
  assert.equal(hub.isPresent("u", "mac"), false);
});

test("server: the iPhone call hears about the account's open Mac app; the Mac's own call does not", { timeout: 15_000 }, async (t) => {
  const DEV = "dev-token-suggest";
  const cfg = { ...config, sessionToken: DEV };
  const requests: SparkRequest[] = [];
  const deps: SessionDeps = {
    config: cfg,
    openAsr: () => Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } }),
    async *spark(req): AsyncGenerator<SparkStreamEvent> { requests.push(req); yield { type: "text", delta: "Sure." }; yield { type: "done", responseId: "r", text: "Sure.", status: "completed" }; },
    async *tts() {},
  };
  const server = await startServer(cfg, () => {}, deps, {}, null);
  t.after(() => new Promise((r) => server.close(r)));
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = (path: string, user = "chel") => new Promise<{ ws: WebSocket; json: Record<string, unknown>[] }>((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}${path}`, { headers: { authorization: `Bearer ${DEV}`, "x-genita-user": user } });
    const c = { ws, json: [] as Record<string, unknown>[] };
    ws.on("message", (d, bin) => { if (!bin) c.json.push(JSON.parse(String(d))); });
    ws.on("open", () => resolve(c));
    ws.on("error", reject);
  });
  const ask = async (path: string, user?: string) => {
    const call = await open(path, user);
    call.ws.send(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
    await waitFor(() => call.json.some((m) => m.type === "ready"));
    const n = requests.length;
    call.ws.send(JSON.stringify({ type: "text", text: ASK }));
    await waitFor(() => requests.length > n);
    call.ws.close();
    return requests.at(-1)!.instructions ?? "";
  };
  assert.doesNotMatch(await ask("/v1/session?device=iphone"), MAC_LINE, "no Mac app open yet");
  const macPresence = await open("/v1/presence?device=mac");
  macPresence.ws.send(JSON.stringify({ type: "hello", owner: "phone", epoch: 0 }));
  await waitFor(() => macPresence.json.some((m) => m.type === "ownership"));
  assert.match(await ask("/v1/session?device=iphone"), MAC_LINE, "the Mac app is open on this account");
  assert.doesNotMatch(await ask("/v1/session?device=iphone", "someone-else"), MAC_LINE, "another account's Mac never counts");
  assert.doesNotMatch(await ask("/v1/session?device=mac"), MAC_LINE, "already on the Mac");
  macPresence.ws.close();
});

test("QA P2 (S4 1/4): Spark ignores the move-to-Mac ask and gives outfit advice → the fixed Mac line is said instead, 10/10, no card", async () => {
  const { SUGGEST_MAC_REPLIES } = await import("../src/session/session.ts");
  for (let i = 0; i < 10; i++) {
    const { deps, sink, events } = setup(() => true);
    deps.spark = async function* () {
      yield { type: "text", delta: "<happy> Go with the black jeans and the cream knit. " };
      yield { type: "text", delta: "Simple, sharp, and so you. Add the loafers." };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    };
    const s = new Session(`qa${i}`, sink, deps);
    await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
    for (let k = 0; k < i; k++) await s.onClientText(JSON.stringify({ type: "text", text: "hi" })); // rotate utterance ids
    const before = replies(events);
    await s.onClientText(JSON.stringify({ type: "text", text: ASK }));
    await waitFor(() => replies(events) > before);
    const reply = events.filter((e) => e.type === "reply").at(-1) as { text: string };
    assert.match(reply.text, /\bMac\b/, `run ${i}`);
    assert.ok(SUGGEST_MAC_REPLIES.some((l) => l.replace(/<[^>]*>\s*/, "") === reply.text), reply.text);
    assert.ok(!events.some((e) => e.type === "find.created" || e.type === "find.started"), "no card on the suggest turn");
    s.close();
  }
});

test("mustNameMac: a reply naming the Mac in its second sentence passes through unchanged", async () => {
  const { mustNameMac } = await import("../src/session/session.ts");
  async function* src() {
    yield { type: "text" as const, delta: "<excited> Of course! " };
    yield { type: "text" as const, delta: "Can you move our call to your Mac? I want to see it all." };
    yield { type: "done" as const, responseId: "r", text: "", status: "completed" };
  }
  let out = "";
  for await (const ev of mustNameMac(src(), "FIXED")) if (ev.type === "text") out += ev.delta;
  assert.equal(out, "<excited> Of course! Can you move our call to your Mac? I want to see it all.");
});

test("mustNameMac (Codex #423): a stream that stalls after its first words gets the fixed line on its own clock", async () => {
  const { mustNameMac } = await import("../src/session/session.ts");
  async function* stalled() {
    yield { type: "text" as const, delta: "<excited> Of course! " };
    await new Promise((r) => setTimeout(r, 5000));
    yield { type: "done" as const, responseId: "r", text: "", status: "completed" };
  }
  const t0 = Date.now();
  let out = "";
  for await (const ev of mustNameMac(stalled(), "FIXED Mac line", Date.now, 300)) if (ev.type === "text") out += ev.delta;
  assert.equal(out, "FIXED Mac line");
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
});

test("Codex #423 final: a guard drops the Mac sentence (camera off, 'you look great') → the ask is still said", async () => {
  const { deps, sink, events } = setup(() => true);
  deps.spark = async function* () {
    yield { type: "text", delta: "<happy> Of course! You look great already, but move our call to your Mac so I can see it all." };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  };
  const s = new Session("qa-mac-guard", sink, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Rio" }, mic: false }));
  await s.onClientText(JSON.stringify({ type: "text", text: ASK }));
  await waitFor(() => replies(events) >= 1);
  const reply = events.filter((e) => e.type === "reply").at(-1) as { text: string };
  assert.match(reply.text, /\bMac\b/);
  s.close();
});
