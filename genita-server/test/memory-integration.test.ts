import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { Session, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import type { ServerEvent } from "../src/protocol.ts";
import { sparkStream, sparkJson, type SparkRequest, type SparkStreamEvent } from "../src/meta/spark.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { UsPhotoService, metaPhotoVendors } from "../src/memory/photos.ts";

const config = { ...loadConfig({ MODEL_API_KEY: "fake-meta", ELEVENLABS_API_KEY: "fake-eleven" }), port: 0, webSearch: false, speculate: true, sparkHedge: 2 };
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitFor(check: () => boolean) { const deadline = Date.now() + 2000; while (!check()) { if (Date.now() > deadline) throw new Error("test timed out"); await pause(); } }
const fakePng = () => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32)]);
function setup() {
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const deps: SessionDeps = { config, memory, userId: "trusted", openAsr: () => asr, async *spark() { yield { type: "text", delta: "<happy> Oh, welcome back!" }; yield { type: "done", responseId: "r", text: "", status: "completed" }; }, async *tts() {} };
  return { repo, memory, deps, asr };
}
function client() {
  const events: ServerEvent[] = [];
  const sink: ClientSink = { sendJson: (e) => { events.push(e); }, sendBinary() {}, close() {} };
  return { events, sink, replies: () => events.filter((e) => e.type === "reply") };
}

test("session-start revisit is voiced through the normal pipeline and opener guard; client cannot choose memory identity", async () => {
  const { repo, deps, memory } = setup();
  await memory.remember("trusted", "I bought tofu for kimchi jjigae.", "episode", "old");
  const state = await repo.getState("trusted"); state.last_message_at = Date.now() - 24 * 3_600_000; state.recent_openers = ["oh"]; await repo.putState("trusted", state);
  const requests: SparkRequest[] = [];
  const source = deps.spark; deps.spark = (req, opts) => { requests.push(req); return source(req, opts); };
  const c = client(); const session = new Session("new", c.sink, deps);
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, user: { id: "attacker" }, memories: ["Deleted injected memory"], history: [{ role: "assistant", text: "Deleted injected history" }], mic: false }));
  await waitFor(() => c.replies().length === 1);
  assert.equal(c.replies()[0].text, "Welcome back!");
  assert.match(requests[0].instructions!, /kimchi jjigae/); assert.match(requests[0].instructions!, /ONE past item/); assert.doesNotMatch(requests[0].instructions!, /Deleted injected/);
  assert.doesNotMatch(JSON.stringify(requests[0].input), /Deleted injected history/);
  await memory.forget("trusted");
  await session.onClientText(JSON.stringify({ type: "text", text: "What did we talk about?" }));
  await waitFor(() => c.replies().length === 2);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /kimchi|tofu|Deleted injected/);
  session.close(); await memory.drain();
});

test("10 live-session turn pairs complete while extraction is unresolved; greeting is not extracted", async () => {
  const { deps, repo } = setup(); let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); const batches: number[] = [];
  const memory = new MemoryService({ repository: repo, state: repo, extract: async (turns) => { batches.push(turns.length); await gate; return ["I like spicy food.", "I bought tofu and kimchi.", "I plan kimchi jjigae."].map((text) => ({ text, kind: "episode", sensitive: "none", follow_up: true })); } });
  deps.memory = memory; const c = client(); const session = new Session("s", c.sink, deps);
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, mic: false }));
  await waitFor(() => c.replies().length === 1);
  for (let n = 0; n < 10; n++) {
    await session.onClientText(JSON.stringify({ type: "text", text: `I like ingredient number ${n}.` }));
    await waitFor(() => c.replies().length === n + 2);
  }
  assert.deepEqual(batches, [4]); assert.equal(c.replies().length, 11, "vendor extraction has not settled, all replies have");
  session.close(); release(); await memory.drain();
  assert.deepEqual(batches, [4, 4, 2]); assert.equal((await memory.list("trusted")).length, 3);
});

test("hedged Spark executes a winning remember once; speculative ASR partials never write memory", async () => {
  const { deps, asr, memory } = setup(); let toolRequests = 0; const originalRemember = memory.remember.bind(memory); let writes = 0;
  memory.remember = async (...args) => { writes++; return originalRemember(...args); };
  deps.spark = async function* (req): AsyncGenerator<SparkStreamEvent> {
    const input = JSON.stringify(req.input);
    if (input.includes("function_call_output")) { yield { type: "text", delta: "Saved that." }; }
    else if (input.includes("spicy")) { toolRequests++; yield { type: "function_call", name: "remember", call_id: "same-call", arguments: '{"fact":"I like spicy food.","kind":"fact"}' }; }
    else yield { type: "text", delta: "Hello there." };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  };
  const c = client(); const session = new Session("s", c.sink, deps);
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } })); await waitFor(() => c.replies().length === 1);
  await session.onClientText(JSON.stringify({ type: "playback_done", utteranceId: c.replies()[0].utteranceId }));
  asr.emit("event", { type: "partial", text: "Remember I like spicy food." }); await waitFor(() => toolRequests === 2); assert.equal(writes, 0);
  await session.onClientText(JSON.stringify({ type: "text", text: "Remember I like spicy food." })); await waitFor(() => c.replies().length === 2);
  assert.equal(toolRequests, 2, "both Spark hedge lanes emitted a call"); assert.equal(writes, 1, "only the winning lane's tool executes");
  assert.ok(c.events.some((e) => e.type === "turn.metrics" && e.speculative === "hit"));
  assert.equal((await memory.list("trusted")).length, 1); session.close(); await memory.drain();
});

test("HTTP memory routes authenticate, isolate resolved principals, forget and enforce photo input allowlist", async (t) => {
  const { deps, memory } = setup(); let edits = 0;
  deps.photos = new UsPhotoService(memory, { edit: async () => { edits++; return fakePng(); }, sameFace: async () => true });
  deps.resolveCompanionFace = async (_user, id) => id === "mina" ? fakePng() : null;
  // Test-only resolver stands in for F1's verified JWT middleware.
  const server = await startServer({ ...config, sessionToken: "test-token" }, () => {}, deps, (req) => req.headers["x-test-principal"] === "b" ? "b" : "a");
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const address = server.address(); assert.ok(address && typeof address === "object"); const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  assert.equal((await fetch(base + "/v1/memories")).status, 401);
  const m = await memory.remember("a", "I like kimchi jjigae.", "episode", "s");
  const listed = await fetch(base + "/v1/memories?userId=b", { headers }); assert.match(JSON.stringify(await listed.json()), /kimchi/); assert.equal(listed.headers.get("cache-control"), "no-store");
  const other = await fetch(base + "/v1/memories", { headers: { ...headers, "x-test-principal": "b" } }); assert.deepEqual(await other.json(), { memories: [] });
  assert.equal((await fetch(base + `/me/memories/${m!.id}`, { method: "DELETE", headers: { ...headers, "x-test-principal": "b" } })).status, 204); assert.equal((await memory.list("a")).length, 1);
  assert.equal((await fetch(base + `/v1/memories/${m!.id}`, { method: "DELETE", headers })).status, 204); assert.deepEqual(await memory.recall("a", "kimchi"), []);
  const photo = { scene_id: "fridge", companion_id: "mina", scene_description: "Cooking together", scene_ended: true, card_closed: true };
  assert.equal((await fetch(base + "/v1/us-photos", { method: "POST", headers, body: JSON.stringify({ ...photo, user_face: "never allowed" }) })).status, 400); assert.equal(edits, 0);
  assert.equal((await fetch(base + "/v1/us-photos", { method: "POST", headers, body: JSON.stringify({ ...photo, companion_face: fakePng().toString("base64") }) })).status, 400);
  assert.equal((await fetch(base + "/v1/us-photos", { method: "POST", headers, body: JSON.stringify({ ...photo, companion_id: "missing" }) })).status, 404);
  const generated = await fetch(base + "/v1/us-photos", { method: "POST", headers, body: JSON.stringify(photo) }); assert.equal(generated.status, 200); assert.equal((await generated.json() as { status: string }).status, "ready"); assert.equal(edits, 1);
  assert.equal((await fetch(base + "/v1/memory-settings", { method: "PATCH", headers, body: JSON.stringify({ photosOfUs: false, rememberSeen: false }) })).status, 200);
  assert.equal((await (await fetch(base + "/v1/us-photos", { method: "POST", headers, body: JSON.stringify({ ...photo, scene_id: "drama" }) })).json() as { status: string }).status, "disabled");
  assert.equal((await fetch(base + "/v1/memory-settings", { method: "PATCH", headers, body: '{"photosOfUs":"false"}' })).status, 400);
  assert.equal((await fetch(base + "/v1/memory-settings", { method: "PATCH", headers, body: "{bad" })).status, 400);
  assert.equal((await fetch(base + "/v1/memories", { method: "DELETE", headers })).status, 204);
  await memory.drain();
});

test("interpretation has no memory context/tools/extraction, then mode=chat enables them", async () => {
  const { deps, memory } = setup(); const requests: SparkRequest[] = []; const original = deps.spark;
  deps.spark = (req, opts) => { requests.push(req); return original(req, opts); };
  await memory.remember("trusted", "I like kimchi jjigae.", "episode", "old");
  const c = client(); const session = new Session("s", c.sink, deps);
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, mode: "interpret", mic: false }));
  assert.equal(c.replies().length, 0, "no greeting interrupts interpretation");
  await session.onClientText(JSON.stringify({ type: "text", text: "안녕하세요" })); await waitFor(() => c.replies().length === 1);
  assert.equal(requests[0].tools, undefined); assert.doesNotMatch(requests[0].instructions!, /kimchi|Stored memories/);
  await session.onClientText(JSON.stringify({ type: "mode", mode: "chat" }));
  await session.onClientText(JSON.stringify({ type: "text", text: "How about kimchi jjigae?" })); await waitFor(() => c.replies().length === 2);
  assert.match(requests.at(-1)!.instructions!, /kimchi jjigae/); assert.ok(requests.at(-1)!.tools?.length);
  session.close(); await memory.drain();
});

test("ordinary chat survives unavailable memory storage; photo route fails closed without a companion resolver", async (t) => {
  const { deps, repo } = setup(); repo.getState = async () => { throw new Error("storage offline"); };
  const c = client(); const session = new Session("s", c.sink, deps);
  await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "Hi there" })); await waitFor(() => c.replies().length === 1);
  assert.equal(c.events.some((e) => e.type === "error"), false); session.close();
  const other = setup(); other.deps.photos = new UsPhotoService(other.memory, { edit: async () => { throw new Error("must not call"); }, sameFace: async () => false });
  const server = await startServer(config, () => {}, other.deps); t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const response = await fetch(`http://127.0.0.1:${addr.port}/v1/us-photos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ companion_id: "mina", scene_id: "fridge", scene_description: "Cooking", scene_ended: true, card_closed: true }) });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "companion_storage_unavailable" });
});

test("WebSocket and REST share the same authenticated resolver; resolver rejects an upgrade", async (t) => {
  const { deps } = setup();
  const server = await startServer(config, () => {}, deps, () => null); t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session`);
  await new Promise<void>((resolve, reject) => { ws.on("unexpected-response", (_req, res) => { assert.equal(res.statusCode, 401); res.resume(); ws.terminate(); resolve(); }); ws.on("open", () => reject(new Error("unauthorized socket opened"))); ws.on("error", () => {}); });
  assert.equal((await fetch(`http://127.0.0.1:${addr.port}/v1/memories`)).status, 401);
});

test("Meta client parses/deduplicates function calls and preserves structured output request shape without vendor calls", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const call = { type: "function_call", name: "recall", call_id: "c", arguments: '{"query":"kimchi"}' };
  t.mock.method(globalThis, "fetch", async (_url: unknown, opts: RequestInit) => {
    const body = JSON.parse(opts.body as string); bodies.push(body);
    if (!body.stream) return new Response(JSON.stringify({ id: "r", output: [{ type: "message", content: [{ type: "output_text", text: '{"safe":true}' }] }] }));
    const sse = [{ type: "response.created", response: { id: "r" } }, { type: "response.output_item.done", item: call }, { type: "response.completed", response: { id: "r", status: "completed", output: [call] } }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(sse);
  });
  const events = []; for await (const e of sparkStream("fake", { input: "hi", tools: [{ type: "function", name: "recall" }] })) events.push(e);
  assert.equal(events.filter((e) => e.type === "function_call").length, 1); assert.equal(bodies[0].model, "muse-spark-1.3");
  assert.deepEqual(await sparkJson("fake", { input: "safe?", schemaName: "safety", schema: { type: "object" } }), { safe: true });
  assert.deepEqual(bodies[1].text, { format: { type: "json_schema", name: "safety", schema: { type: "object" }, strict: true } });
});

test("Muse Image edits sends only the companion image and text; Spark checks the generated face", async (t) => {
  const requests: Array<{ url: string; body: FormData | Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
    const isForm = opts.body instanceof FormData;
    requests.push({ url, body: isForm ? opts.body as FormData : JSON.parse(opts.body as string) });
    return new Response(JSON.stringify(isForm ? { data: [{ b64_json: fakePng().toString("base64") }] } : { id: "r", output: [{ type: "message", content: [{ type: "output_text", text: '{"same_companion":true}' }] }] }));
  });
  const vendors = metaPhotoVendors("fake"); const face = fakePng(); const image = await vendors.edit(face, "A cozy cooking scene."); assert.equal(await vendors.sameFace(face, image), true);
  assert.match(requests[0].url, /\/v1\/images\/edits$/); const form = requests[0].body as FormData;
  assert.deepEqual([...form.keys()].sort(), ["image", "model", "prompt", "response_format", "size"]);
  assert.deepEqual(Buffer.from(await (form.get("image") as Blob).arrayBuffer()), face);
  assert.equal(form.get("model"), "muse-image-1.0"); assert.equal((requests[1].body as Record<string, unknown>).model, "muse-spark-1.3");
});
