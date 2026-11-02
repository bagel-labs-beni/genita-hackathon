/** Better recall (memory lane 11/3): stop words, Spark re-rank on the recall tool only (bounded), pinned stable facts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadConfig } from "../src/config.ts";
import { Session, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import type { ServerEvent } from "../src/protocol.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { createReranker, RERANK_BUDGET_MS, type Reranker } from "../src/memory/rerank.ts";

const config = { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, webSearch: false, speculate: false, sparkHedge: 1 };
const pause = () => new Promise<void>((r) => setTimeout(r, 2));
async function waitFor(check: () => boolean, ms = 4000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("test timed out"); await pause(); } }

function service(rerank?: Reranker) {
  const repo = new InMemoryMemoryRepository();
  return new MemoryService({ repository: repo, state: repo, extract: async () => [], rerank });
}
async function seed(m: MemoryService, user = "u") {
  for (const t of ["My cat Miso steals my running socks.", "I am training for a 10K in December.", "I like 90s hip hop for long runs.", "I drink oat milk lattes."]) await m.remember(user, t, "fact", "s0");
}

test("recall: stop words are not evidence ('What is my name?' no longer matches every 'my' memory)", async () => {
  const m = service(); await seed(m);
  assert.deepEqual(await m.recall("u", "What is my name?"), []);
  assert.deepEqual((await m.recall("u", "how is the 10K going")).map((x) => x.text), ["I am training for a 10K in December."]);
});

test("recall tool (GENITA_MEMORY_RERANK=1): Spark re-ranks overlap candidates padded with the newest items; the per-reply recall never calls it", async () => {
  const asked: string[][] = [];
  const rerank: Reranker = async (_q, c) => { asked.push(c); return [c.findIndex((t) => /cat/.test(t))]; };
  const m = service(rerank); await seed(m);
  assert.deepEqual(await m.recall("u", "what pet do I have"), [], "no overlap, no rerank on the implicit path");
  assert.equal(asked.length, 0);
  const got = await m.recall("u", "what pet do I have", { rerank: true });
  assert.deepEqual(got.map((x) => x.text), ["My cat Miso steals my running socks."], "same meaning found");
  assert.equal(asked[0].length, 4, "padded with the newest items");
});

test("recall tool: a slow or failing re-rank falls back to overlap within the budget", async () => {
  const slow = service(() => new Promise(() => {})); await seed(slow);
  const t0 = Date.now();
  assert.deepEqual((await slow.recall("u", "10K training", { rerank: true })).map((x) => x.text), ["I am training for a 10K in December."]);
  assert.ok(Date.now() - t0 < RERANK_BUDGET_MS + 400, `${Date.now() - t0}ms`);
  const broken = service(async () => { throw new Error("vendor"); }); await seed(broken);
  assert.equal((await broken.recall("u", "oat milk", { rerank: true }))[0].text, "I drink oat milk lattes.");
});

test("recall tool: a Forget while Spark ranks returns nothing from before it; never another user's items", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let m!: MemoryService;
  m = service(async (_q, c) => { await gate; return [0, 1]; });
  await seed(m); await seed(m, "other");
  const pending = m.recall("u", "runs", { rerank: true });
  await pause();
  await m.forget("u");
  release();
  assert.deepEqual(await pending, []);
  const seen: string[][] = [];
  const m2 = service(async (_q, c) => { seen.push(c); return [0]; });
  await m2.remember("a", "I like sushi.", "fact", "s"); await m2.remember("b", "I like ramen.", "fact", "s");
  await m2.recall("a", "food", { rerank: true });
  assert.deepEqual(seen[0], ["I like sushi."]);
});

test("createReranker: indexes validated, deduped, at most three", async () => {
  const r = createReranker(async () => ({ picks: [2, 2, 9, -1, 0, 1, 3] }) as never);
  assert.deepEqual(await r("q", ["a", "b", "c", "d"]), [2, 0, 1]);
});

function client() {
  const events: ServerEvent[] = [];
  const sink: ClientSink = { sendJson: (e) => { events.push(e as ServerEvent); }, sendBinary() {}, close() {} };
  return { sink, replies: () => events.filter((e) => e.type === "reply"), ready: () => events.some((e) => e.type === "ready") };
}

test("pinned facts: the call's top stable facts sit in every reply without a tool call; Forget clears them; per account", async () => {
  const m = service(); await seed(m, "acct");
  const requests: SparkRequest[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const deps: SessionDeps = { config, memory: m, userId: "acct", openAsr: () => asr, async *spark(req): AsyncGenerator<SparkStreamEvent> { requests.push(req); yield { type: "text", delta: "Sure." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; }, async *tts() {} };
  const c = client(); const s = new Session("p", c.sink, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => c.replies().length >= 1);
  await s.onClientText(JSON.stringify({ type: "text", text: "Any plans for tonight?" }));
  await waitFor(() => c.replies().length >= 2);
  const inst = requests.at(-1)!.instructions!;
  assert.match(inst, /What you already know about them/);
  assert.match(inst, /cat Miso/); assert.match(inst, /10K/);
  assert.equal((inst.match(/oat milk/g) ?? []).length, 1, "a pinned fact is not repeated as a recalled one");
  await m.forget("acct");
  await s.onClientText(JSON.stringify({ type: "text", text: "And tomorrow? oat milk?" }));
  await waitFor(() => c.replies().length >= 3);
  assert.doesNotMatch(requests.at(-1)!.instructions!, /Miso|10K|oat milk lattes/);
  s.close(); await m.drain();
  // another account starts with nothing pinned
  requests.length = 0;
  const c2 = client(); const s2 = new Session("q", c2.sink, { ...deps, userId: "other" });
  await s2.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => c2.replies().length >= 1);
  assert.doesNotMatch(JSON.stringify(requests.map((r) => r.instructions)), /What you already know/);
  s2.close(); await m.drain();
});

test("recall keys: extraction keys widen the overlap match with zero reply-time cost; explicit remember gets keys in the background", async () => {
  const repo = new InMemoryMemoryRepository();
  let keyCalls = 0;
  const m = new MemoryService({ repository: repo, state: repo,
    extract: async () => [{ text: "My cat Miso steals my running socks.", kind: "fact", sensitive: "none", follow_up: false, keys: ["Cat", "pet", "animal", "doctor", "miso"] }],
    keys: async (t) => { keyCalls++; return /cello/.test(t) ? ["instrument", "music"] : undefined; } });
  await m.extract("u", "s1", [{ user: "My cat Miso steals my running socks.", assistant: "Ha!" }], 0);
  const [row] = await m.list("u");
  assert.deepEqual(row.keys, ["cat", "pet", "animal", "miso"], "lowercased, sensitive key dropped");
  assert.equal((await m.recall("u", "what pet do I have"))[0]?.text, "My cat Miso steals my running socks.", "found without a re-rank");
  assert.equal(keyCalls, 0, "extraction brings its own keys");
  await m.remember("u", "I play the cello in a community orchestra.", "fact", "s2");
  assert.deepEqual(await m.recall("u", "which instrument"), [], "keys not there yet: the reply path never waits for them");
  await m.drain();
  assert.equal(keyCalls, 1);
  assert.equal((await m.recall("u", "which instrument"))[0]?.text, "I play the cello in a community orchestra.");
});

test("recall keys: a Forget before the background keys land wins", async () => {
  const repo = new InMemoryMemoryRepository();
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const m = new MemoryService({ repository: repo, state: repo, extract: async () => [], keys: async () => { await gate; return ["instrument"]; } });
  await m.remember("u", "I play the cello.", "fact", "s");
  await m.forget("u");
  release(); await m.drain();
  assert.deepEqual(await m.list("u"), []);
});
