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

function setup(macNearby?: () => boolean) {
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
    async *spark(req) { requests.push(req); yield { type: "text", delta: "Sure." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
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
  assert.equal(isOutfitAsk("Which one looks better on me, the white one or the black one?"), true);
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
