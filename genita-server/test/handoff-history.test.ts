import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { Session, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import type { ServerEvent } from "../src/protocol.ts";
import type { SparkRequest } from "../src/meta/spark.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";

// #199 (L3 Mac): with server memory on, start.history is ignored, so after a move to the Mac the call lost the
// iPhone's turns ("Things · searching shops", "Right here. We're looking for…" impossible).
const config = { ...loadConfig({ MODEL_API_KEY: "fake-meta", ELEVENLABS_API_KEY: "fake-eleven" }), port: 0, webSearch: false, speculate: false, sparkHedge: 1 };
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitFor(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { if (Date.now() > deadline) throw new Error("test timed out"); await pause(); } }
const IPHONE = [
  { role: "user" as const, text: "Jin, can we look for a jacket for this weekend?" },
  { role: "assistant" as const, text: "On it." },
];
function setup(requests: SparkRequest[]) {
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const deps: SessionDeps = {
    config, memory, userId: "acct", openAsr: () => asr,
    async *spark(req) { requests.push(req); yield { type: "text", delta: "Right here." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts() {},
  };
  return { deps, memory };
}
function client() {
  const events: ServerEvent[] = [];
  const sink: ClientSink = { sendJson: (e) => { events.push(e as ServerEvent); }, sendBinary() {}, close() {} };
  return { events, sink, replies: () => events.filter((e) => e.type === "reply") };
}
const inputOf = (r: SparkRequest) => JSON.stringify(r.input);

test("handoff: with memory on, the new device's call starts with the account's turns from the other call (no new hello)", async () => {
  const requests: SparkRequest[] = [];
  const { deps, memory } = setup(requests);
  const c = client();
  const mac = new Session("mac", c.sink, { ...deps, priorTurns: () => IPHONE });
  await mac.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await mac.onClientText(JSON.stringify({ type: "text", text: "Still with me?" }));
  await waitFor(() => c.replies().length >= 1);
  const asked = requests.at(-1)!;
  assert.match(inputOf(asked), /look for a jacket for this weekend/, "the iPhone's turn is in the Mac's context");
  assert.equal(c.replies().length, 1, "no greeting before the answer: the conversation continues");
  mac.close(); await memory.drain();
});

test("handoff: a start marked handoff:true uses its own history only when the server has none; unmarked history stays ignored", async () => {
  const requests: SparkRequest[] = [];
  const { deps, memory } = setup(requests);
  const a = client();
  const marked = new Session("m1", a.sink, { ...deps, priorTurns: () => null });
  await marked.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false, handoff: true, history: IPHONE }));
  await marked.onClientText(JSON.stringify({ type: "text", text: "Still with me?" }));
  await waitFor(() => requests.some((r) => /Still with me/.test(inputOf(r))));
  assert.match(inputOf(requests.at(-1)!), /look for a jacket/);
  marked.close();
  requests.length = 0;
  const b = client();
  const plain = new Session("m2", b.sink, { ...deps, priorTurns: () => null });
  await plain.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false, history: [{ role: "assistant", text: "Deleted injected history" }] }));
  await plain.onClientText(JSON.stringify({ type: "text", text: "Hi" }));
  await waitFor(() => requests.some((r) => /"Hi"|Hi/.test(inputOf(r))));
  assert.doesNotMatch(JSON.stringify(requests), /Deleted injected history/, "a normal start keeps ignoring client history");
  plain.close(); await memory.drain();
});

test("handoff (server): the Mac's call gets the same account's live iPhone turns — never another account's", { timeout: 20_000 }, async (t) => {
  const requests: SparkRequest[] = [];
  const { deps, memory } = setup(requests);
  const server = await startServer({ ...config, sessionToken: "test-token" }, () => {}, deps, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const sockets: WebSocket[] = [];
  t.after(() => sockets.forEach((ws) => ws.terminate()));
  const open = (user: string) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session`, { headers: { authorization: "Bearer test-token", "x-genita-user": user } });
    sockets.push(ws);
    ws.once("open", () => resolve(ws)); ws.once("error", reject);
  });
  const ready = new Set<WebSocket>();
  const replies = (ws: WebSocket) => { const got: string[] = []; ws.on("message", (d, bin) => { if (!bin) { const m = JSON.parse(String(d)); if (m.type === "reply") got.push(m.text); if (m.type === "ready") ready.add(ws); } }); return got; };
  const phone = await open("a"); const phoneReplies = replies(phone);
  phone.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => phoneReplies.length >= 1); // greeting
  phone.send(JSON.stringify({ type: "text", text: "Can we look for a jacket for this weekend?" }));
  await waitFor(() => phoneReplies.length >= 2);
  const other = await open("b"); const otherReplies = replies(other);
  other.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => otherReplies.length >= 1);
  other.send(JSON.stringify({ type: "text", text: "What were we doing?" }));
  await waitFor(() => requests.some((r) => /What were we doing/.test(inputOf(r))));
  assert.doesNotMatch(inputOf(requests.at(-1)!), /jacket/, "account b never sees account a's turns");
  const mac = await open("a"); const macReplies = replies(mac);
  mac.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => ready.has(mac));
  mac.send(JSON.stringify({ type: "text", text: "Still with me?" }));
  await waitFor(() => requests.some((r) => /Still with me/.test(inputOf(r))));
  assert.match(inputOf(requests.find((r) => /Still with me/.test(inputOf(r)))!), /look for a jacket for this weekend/);
  await waitFor(() => macReplies.length >= 1);
  for (const ws of [phone, other, mac]) ws.close();
  await memory.drain();
});

test("handoff: a first-call greetAfterMs window does not bring the greeting back on the continued call", async () => {
  const requests: SparkRequest[] = [];
  const { deps, memory } = setup(requests);
  const c = client();
  const mac = new Session("mac2", c.sink, { ...deps, priorTurns: () => IPHONE });
  await mac.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false, greetAfterMs: 20 }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(c.replies().length, 0, "no greeting after the window on a continued call");
  mac.close(); await memory.drain();
});
