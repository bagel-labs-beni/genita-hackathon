/**
 * Session memory (memory lane 11/3): per-thread call summaries, written off the reply path, injected
 * into the next call, one thread across an iPhone ↔ Mac handoff, dropped by Forget, per account.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { createAccounts } from "../src/auth/index.ts";
import { startServer } from "../src/server.ts";
import { Session, RECONNECT_LINE, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import type { ServerEvent } from "../src/protocol.ts";
import type { SparkRequest } from "../src/meta/spark.ts";
import { InMemoryMemoryRepository, mergeSummary } from "../src/memory/repository.ts";
import { PgMemoryRepository } from "../src/memory/pgRepository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { cleanKeys, safeMemoryText, type Turn } from "../src/memory/extract.ts";
import { MemoryCall } from "../src/memory/call.ts";
import { cleanSummary, createSummarizer, summaryPrompt, SUMMARY_KEEP, type CallSummary, type Summarizer } from "../src/memory/summaries.ts";

const config = { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, webSearch: false, speculate: false, sparkHedge: 1 };
const pause = () => new Promise<void>((r) => setTimeout(r, 2));
async function waitFor(check: () => boolean, ms = 4000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("test timed out"); await pause(); } }

const NOTES = { topics: ["Jacket shopping for Saturday"], mood: "excited", open_threads: ["Choosing between the green and the navy jacket"], promises: ["Check the weather before Saturday"], asks: ["Find a warm jacket"] };
function fakeSummarizer() {
  const calls: Array<{ turns: Turn[]; previous?: CallSummary | null }> = [];
  const fn: Summarizer = async (turns, previous) => { calls.push({ turns, previous }); return cleanSummary(NOTES); };
  return { fn, calls };
}
function setup(summarize = fakeSummarizer().fn, now = () => Date.now()) {
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [], summarize, now });
  const requests: SparkRequest[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const deps: SessionDeps = {
    config, memory, userId: "acct-a", openAsr: () => asr,
    async *spark(req) { requests.push(req); yield { type: "text", delta: "Sounds good." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts() {},
  };
  return { repo, memory, deps, requests };
}
function client() {
  const events: ServerEvent[] = [];
  const sink: ClientSink = { sendJson: (e) => { events.push(e as ServerEvent); }, sendBinary() {}, close() {} };
  return { sink, replies: () => events.filter((e) => e.type === "reply"), ready: () => events.some((e) => e.type === "ready") };
}
async function call(deps: SessionDeps, id: string, lines: string[], extra: Record<string, unknown> = {}) {
  const c = client();
  const s = new Session(id, c.sink, deps);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false, ...extra }));
  await waitFor(c.ready);
  const base = c.replies().length;
  for (let i = 0; i < lines.length; i++) {
    // the greeting may still be in flight: wait for each answer
    await s.onClientText(JSON.stringify({ type: "text", text: lines[i] }));
    await waitFor(() => c.replies().length >= base + i + 1);
  }
  return { session: s, client: c };
}
const inst = (r: SparkRequest) => r.instructions ?? "";

test("summaries: every line goes through the sensitive filter (health, religion, politics, sex, income/debt)", () => {
  for (const bad of ["Talked about going to church on Sunday", "Worried about the election", "Their sex life", "Paying off a student loan", "Their salary review", "A doctor visit for the knee"]) {
    assert.equal(safeMemoryText(bad), false, bad);
  }
  const s = cleanSummary({ topics: ["Jacket shopping", "Praying more often"], mood: "tired", open_threads: ["Voting next week"], promises: ["Ask about the debt"], asks: [] });
  assert.deepEqual(s, { topics: ["Jacket shopping"], mood: "tired", open_threads: [], promises: [], asks: [] });
  assert.equal(cleanSummary({ topics: ["Their mortgage"], mood: "", open_threads: [], promises: [], asks: [] }), null, "nothing left = nothing stored");
});

test("summaries: one row per thread, a shorter copy never replaces a fuller one, newest SUMMARY_KEEP kept", () => {
  const mk = (thread: string, turns: number, at: number): CallSummary => ({ ...NOTES, thread_id: thread, turns, created_at: at, updated_at: at });
  let list = mergeSummary([], mk("t1", 5, 1));
  list = mergeSummary(list, mk("t1", 3, 2));
  assert.equal(list.length, 1); assert.equal(list[0].turns, 5, "the other device's older half lost");
  list = mergeSummary(list, mk("t1", 7, 3));
  assert.equal(list[0].turns, 7); assert.equal(list[0].created_at, 1);
  for (let i = 0; i < 15; i++) list = mergeSummary(list, mk(`x${i}`, 1, 10 + i));
  assert.equal(list.length, SUMMARY_KEEP); assert.equal(list[0].thread_id, "x14");
});

test("session memory: call close writes a summary in the background; the next call's greeting and replies get the notes", async () => {
  const fake = fakeSummarizer();
  const { memory, deps, requests } = setup(fake.fn);
  const first = await call(deps, "call-1", ["I need a warm jacket for Saturday.", "Green or navy, I can't decide."]);
  assert.equal(fake.calls.length, 0, "no summary on the reply path");
  first.session.close(); await memory.drain();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].turns.length, 2, "only this call's completed pairs; greeting excluded");
  assert.equal((await memory.summaries("acct-a")).length, 1);

  requests.length = 0;
  const second = await call(deps, "call-2", ["Hey again."]);
  const greet = requests[0];
  assert.match(inst(greet), /Your notes from your last calls/);
  assert.match(inst(greet), /Choosing between the green and the navy jacket/);
  assert.match(inst(greet), /picking up where you left off/);
  assert.match(inst(requests.at(-1)!), /Check the weather before Saturday/, "later replies keep the notes");
  second.session.close(); await memory.drain();
});

test("session memory: Forget (one item) drops every summary, a summary started before Forget is never stored", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const slow: Summarizer = async () => { await gate; return cleanSummary(NOTES); };
  const { memory, deps, requests } = setup(slow);
  const m = await memory.remember("acct-a", "I like long walks on the beach.", "fact", "x");
  const first = await call(deps, "call-1", ["I need a warm jacket for Saturday."]);
  first.session.close();
  await memory.forget("acct-a", m!.id);
  release(); await memory.drain();
  assert.deepEqual(await memory.summaries("acct-a"), [], "pre-Forget summary dropped");
  // and an existing summary is dropped by a later Forget
  await memory.summarizeThread("acct-a", "t-old", [{ user: "I need a jacket.", assistant: "Sure." }], (await memory.state.getState("acct-a")).revision);
  assert.equal((await memory.summaries("acct-a")).length, 1);
  await memory.forget("acct-a", "mem_" + "0".repeat(32));
  assert.deepEqual(await memory.summaries("acct-a"), []);
  requests.length = 0;
  const next = await call(deps, "call-2", ["Hi."]);
  assert.doesNotMatch(JSON.stringify(requests.map(inst)), /jacket/);
  next.session.close(); await memory.drain();
});

test("session memory: an iPhone → Mac handoff is ONE thread — one summary, the fuller copy wins, the Mac sees no notes of its own thread", async () => {
  const fake = fakeSummarizer();
  const { memory, deps, requests } = setup(fake.fn);
  // an earlier, separate call → notes the Mac SHOULD see
  await memory.summarizeThread("acct-a", "earlier-thread", [{ user: "Movie night ideas?", assistant: "Sure." }], 0);
  const phone = await call(deps, "phone", ["I need a warm jacket for Saturday.", "Green or navy?", "Let's look at the navy one."]);
  const handed = phone.session.historySnapshot();
  const thread = phone.session.threadInfo()!;
  assert.equal(thread.threadId, "phone"); assert.equal(thread.covered, 3);
  requests.length = 0;
  const mac = await call({ ...deps, priorTurns: () => handed, priorThread: () => thread }, "mac", ["Okay, on the Mac now."]);
  assert.equal(mac.session.threadInfo()!.threadId, "phone", "the Mac continues the iPhone's thread");
  assert.equal(mac.session.threadInfo()!.covered, 4);
  assert.match(JSON.stringify(requests.at(-1)!.input), /look at the navy one/, "full session context on the Mac");
  assert.doesNotMatch(inst(requests.at(-1)!), /"thread_id":"phone"/);
  mac.session.close(); await memory.drain();
  const runs = fake.calls.length;
  phone.session.close(); await memory.drain(); // the old device closes last, with fewer turns
  assert.equal(fake.calls.length, runs, "the old device no longer summarizes a thread the Mac continued");
  const rows = await memory.summaries("acct-a");
  assert.deepEqual(rows.map((r) => [r.thread_id, r.turns]).sort(), [["earlier-thread", 1], ["phone", 4]]);
  const macCall = fake.calls.find((c) => c.turns.some((t) => /on the Mac now/.test(t.user)))!;
  assert.ok(macCall.turns.some((t) => /warm jacket/.test(t.user)), "the summary covers both devices' turns");
});

test("session memory: two accounts never see each other's notes", async () => {
  const { memory, deps, requests } = setup();
  const a = await call(deps, "a-1", ["I need a warm jacket for Saturday."]);
  a.session.close(); await memory.drain();
  requests.length = 0;
  const b = await call({ ...deps, userId: "acct-b" }, "b-1", ["Hello."]);
  assert.doesNotMatch(JSON.stringify(requests.map(inst)), /jacket|notes from your last calls/i);
  b.session.close(); await memory.drain();
  assert.deepEqual((await memory.summaries("acct-b")).map((r) => r.thread_id), ["b-1"], "B's own call only");
  assert.deepEqual((await memory.summaries("acct-a")).map((r) => r.thread_id), ["a-1"]);
});

test("session memory: a slow summary store never holds the call start (bounded load)", async () => {
  const { memory, deps } = setup();
  const repo = memory.repository as InMemoryMemoryRepository;
  repo.listSummaries = () => new Promise(() => {}); // never answers
  const t0 = Date.now();
  const c = await call(deps, "slow", ["Hi."]);
  assert.ok(Date.now() - t0 < 2500, `ready in ${Date.now() - t0}ms`);
  c.session.close();
});

test("summaryPrompt: newest first, at most three, no notes = empty", () => {
  assert.equal(summaryPrompt([], 0), "");
  const rows = Array.from({ length: 5 }, (_, i): CallSummary => ({ ...NOTES, topics: [`Topic ${i}`], thread_id: `t${i}`, turns: 1, created_at: 0, updated_at: 0 }));
  const p = summaryPrompt(rows, 3_600_000 * 30);
  assert.match(p, /Topic 0/); assert.match(p, /Topic 2/); assert.doesNotMatch(p, /Topic 3/);
  assert.match(p, /untrusted data/);
});

test("createSummarizer: sends turns (+ previous notes of the same thread) and filters the answer", async () => {
  const seen: string[] = [];
  const s = createSummarizer(async (req) => { seen.push(String(req.input)); return { ...NOTES, topics: [...NOTES.topics, "Their therapist"], sensitive: true } as never; });
  const out = await s([{ user: "jacket?", assistant: "sure" }], { ...NOTES, thread_id: "t", turns: 1, created_at: 0, updated_at: 0 });
  assert.deepEqual(out?.topics, NOTES.topics);
  assert.match(seen[0], /"previous"/);
});

test("PgMemoryRepository summaries: per-user rows, fuller copy wins, cap, cascade", async () => {
  const db = await openDb("pglite:memory");
  const accounts = (await createAccounts({ GENITA_JWT_SECRET: "j".repeat(40) }, () => {}, { loopback: true, db, mail: null, blobs: { kind: "fs", async put() {}, async get() { return null; }, async list() { return []; }, async deletePrefix() { return 0; }, signedUrl() { return null; } } }))!;
  const u1 = (await accounts.accounts.userForVerifiedEmail("s1@example.test")).user.id;
  const u2 = (await accounts.accounts.userForVerifiedEmail("s2@example.test")).user.id;
  const repo = new PgMemoryRepository(db);
  const mk = (thread: string, turns: number, at: number): CallSummary => ({ ...NOTES, thread_id: thread, turns, created_at: at, updated_at: at });
  await repo.putSummary(u1, mk("t1", 5, 1000));
  await repo.putSummary(u1, mk("t1", 2, 2000));
  assert.equal((await repo.listSummaries(u1, 10))[0].turns, 5);
  await repo.putSummary(u1, mk("t1", 6, 3000));
  const row = (await repo.listSummaries(u1, 10))[0];
  assert.equal(row.turns, 6); assert.equal(row.created_at, 1000);
  assert.deepEqual(await repo.listSummaries(u2, 10), []);
  for (let i = 0; i < 12; i++) await repo.putSummary(u1, mk(`x${i}`, 1, 10_000 + i));
  assert.equal((await repo.listSummaries(u1, 50)).length, SUMMARY_KEEP);
  await repo.putSummary(u2, mk("t9", 1, 1));
  await repo.deleteSummaries(u1);
  assert.deepEqual(await repo.listSummaries(u1, 10), []);
  assert.equal((await repo.listSummaries(u2, 10)).length, 1);
  await accounts.accounts.deleteUser(u2);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM call_summaries")).rows[0].n, 0, "cascade");
  await accounts.close();
});

test("server: a Mac call that picks up the iPhone's ended call continues its thread (one summary row)", { timeout: 20_000 }, async (t) => {
  const fake = fakeSummarizer();
  const { memory, deps } = setup(fake.fn);
  const server = await startServer({ ...config, sessionToken: "test-token" }, () => {}, deps, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const open = () => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session`, { headers: { authorization: "Bearer test-token", "x-genita-user": "acct-a" } });
    let n = 0; let ok = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
    ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
  });
  const phone = await open();
  phone.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => phone.replies() >= 1);
  phone.ws.send(JSON.stringify({ type: "text", text: "I need a warm jacket for Saturday." }));
  await waitFor(() => phone.replies() >= 2);
  phone.ws.close();
  await waitFor(() => fake.calls.length === 1);
  await memory.drain();
  const mac = await open();
  mac.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(mac.ready);
  mac.ws.send(JSON.stringify({ type: "text", text: "Still with me on the Mac?" }));
  await waitFor(() => mac.replies() >= 1);
  mac.ws.close();
  await waitFor(() => fake.calls.length === 2);
  await memory.drain();
  const rows = await memory.summaries("acct-a");
  assert.equal(rows.length, 1, "one conversation, one summary");
  assert.equal(rows[0].turns, 2);
  assert.ok(fake.calls[1].previous, "the Mac's summary merges the iPhone's notes");
});

test("Codex P1: a Forget while the notes are loading never brings the pre-Forget summary back", async () => {
  const { memory, deps, requests, repo } = setup();
  await memory.summarizeThread("acct-a", "old-thread", [{ user: "I need a jacket.", assistant: "Sure." }], 0);
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const real = repo.listSummaries.bind(repo);
  let loading = false;
  repo.listSummaries = async (u, n) => { const rows = await real(u, n); loading = true; await gate; return rows; };
  const c = client();
  const s = new Session("race", c.sink, deps);
  const starting = s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => loading);
  await memory.forget("acct-a"); // completes (rows deleted, calls notified) while the load is still out
  release();
  await starting;
  repo.listSummaries = real;
  await waitFor(c.ready);
  await s.onClientText(JSON.stringify({ type: "text", text: "Hi again." }));
  await waitFor(() => requests.some((r) => /Hi again/.test(JSON.stringify(r.input))));
  assert.doesNotMatch(JSON.stringify(requests.map(inst)), /navy jacket|notes from your last calls/);
  s.close(); await memory.drain();
});

test("Codex P1: a semantic safety pass drops lines the word filter misses; a failed check stores nothing", async () => {
  const raw = { topics: ["Takes insulin daily", "Jacket shopping"], mood: "calm", open_threads: ["Practicing Buddhism more"], promises: [], asks: [], sensitive: true };
  const ok = createSummarizer(async () => raw as never, async (lines) => lines.map((l) => !/insulin|buddhism/i.test(l)));
  assert.deepEqual(await ok([{ user: "x", assistant: "y" }]), { topics: ["Jacket shopping"], mood: "calm", open_threads: [], promises: [], asks: [] });
  const broken = createSummarizer(async () => raw as never, async () => { throw new Error("vendor down"); });
  await assert.rejects(broken([{ user: "x", assistant: "y" }]));
  const { memory } = setup(broken);
  await memory.summarizeThread("acct-a", "t", [{ user: "x", assistant: "y" }], 0).catch(() => null);
  assert.deepEqual(await memory.summaries("acct-a"), []);
});

test("Codex P2: a long call handed off mid-way — the Mac's summary covers every kept pair, not only the handed-off history", async () => {
  const fake = fakeSummarizer();
  const { memory, deps } = setup(fake.fn);
  const lines = Array.from({ length: 14 }, (_, i) => `Turn number ${i + 1} about the jacket.`);
  const phone = await call(deps, "phone-long", lines);
  await memory.drain();
  assert.equal(fake.calls.length, 1, "periodic summary after 12 turns");
  const state = phone.session.threadInfo()!;
  assert.equal(state.covered, 14);
  const mac = await call({ ...deps, priorTurns: () => phone.session.historySnapshot(), priorThread: () => state }, "mac-long", ["On the Mac now."]);
  mac.session.close(); await memory.drain();
  const macRun = fake.calls.at(-1)!;
  assert.ok(macRun.turns.some((t) => /Turn number 13 /.test(t.user)), "turn 13 (not in the 8-pair history) is summarized");
  assert.equal(macRun.turns.length, 15);
  assert.equal((await memory.summaries("acct-a"))[0].turns, 15);
  const before = fake.calls.length;
  phone.session.close(); await memory.drain();
  assert.equal(fake.calls.length, before, "no stale summary run from the old device");
  assert.equal((await memory.summaries("acct-a"))[0].turns, 15, "the old device's 14-pair copy does not win");
});

test("live eval 11/3: if the Mac's summary fails, the iPhone's older half never stands in for the conversation", async () => {
  let fail = false;
  const calls: number[] = [];
  const summarize: Summarizer = async (turns) => { calls.push(turns.length); if (fail) throw new Error("vendor"); return cleanSummary(NOTES); };
  const { memory, deps } = setup(summarize);
  const phone = await call(deps, "phone-f", ["White or black top for dinner?"]);
  const mac = await call({ ...deps, priorTurns: () => phone.session.historySnapshot(), priorThread: () => phone.session.threadInfo() }, "mac-f", ["Black it is."]);
  fail = true; mac.session.close(); await memory.drain();
  fail = false; phone.session.close(); await memory.drain();
  assert.deepEqual(await memory.summaries("acct-a"), [], "no stale 'did you pick white or black?' notes");
  assert.deepEqual(calls, [2]);
});

test("summary safety: a verdict list of the wrong length drops only the lines without a verdict", async () => {
  const s = createSummarizer(async () => ({ ...NOTES, sensitive: false }) as never, async (lines) => lines.slice(0, 2).map(() => true));
  const out = await s([{ user: "x", assistant: "y" }]);
  assert.deepEqual(out?.topics, NOTES.topics);
  assert.deepEqual(out?.open_threads, NOTES.open_threads);
  assert.deepEqual(out?.promises, []);
});

test("server: hanging up (stop) and calling again is a return visit — a greeting with the last call's notes, not a silent continuation", { timeout: 20_000 }, async (t) => {
  const fake = fakeSummarizer();
  const { memory, deps, requests } = setup(fake.fn);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const open = () => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session`, { headers: { authorization: "Bearer test-token", "x-genita-user": "acct-a" } });
    let n = 0; let ok = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
    ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
  });
  const first = await open();
  first.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => first.replies() >= 1);
  first.ws.send(JSON.stringify({ type: "text", text: "I need a warm jacket for Saturday." }));
  await waitFor(() => first.replies() >= 2);
  first.ws.send(JSON.stringify({ type: "stop" }));
  await waitFor(() => logs.includes("session.close"));
  await waitFor(() => fake.calls.length === 1); await memory.drain();
  requests.length = 0;
  const back = await open();
  back.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => back.replies() >= 1);
  assert.ok(!logs.includes("history.seeded"), "not a handoff continuation");
  assert.ok(logs.includes("history.not_seeded"));
  assert.match(inst(requests[0]), /Your notes from your last calls/);
  assert.match(inst(requests[0]), /picking up where you left off/);
  back.ws.close();
});

test("server (Codex 11/3): a Mac → iPhone move that ends the Mac call with stop still hands the turns over", { timeout: 20_000 }, async (t) => {
  const { memory, deps, requests } = setup(fakeSummarizer().fn);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
  const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
    let n = 0; let ok = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
    ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
  });
  const mac = await open("mac");
  mac.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => mac.replies() >= 1);
  mac.ws.send(JSON.stringify({ type: "text", text: "The navy jacket, size medium." }));
  await waitFor(() => mac.replies() >= 2);
  // the iPhone takes the conversation; the Mac app then ends its call (MacCall.conversationLeft → end → stop)
  const claim = await fetch(`http://127.0.0.1:${addr.port}/v1/handoff/claim`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ device: "iphone", trigger: "button" }) });
  assert.equal(claim.status, 200);
  mac.ws.send(JSON.stringify({ type: "stop" }));
  await waitFor(() => logs.includes("session.close"));
  await memory.drain();
  assert.ok(!logs.includes("history.not_seeded"), "a move is not a hang-up");
  requests.length = 0;
  const phone = await open("iphone");
  phone.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(phone.ready);
  phone.ws.send(JSON.stringify({ type: "text", text: "Still with me on the phone?" }));
  await waitFor(() => requests.some((r) => /Still with me on the phone/.test(JSON.stringify(r.input))));
  assert.match(JSON.stringify(requests.find((r) => /Still with me on the phone/.test(JSON.stringify(r.input)))!.input), /navy jacket, size medium/);
  assert.ok(!logs.includes("call.reconnect_line"), "a move to the other device goes on silently");
  phone.ws.close();
});

/** WT-06 follow-up (11/4): a dropped call that comes back is met with one short line, not silence */
async function dropAndReturn(t: import("node:test").TestContext, o: { from: string; to: string; hangUp?: boolean; gapMs?: number }) {
  const { memory, deps } = setup(fakeSummarizer().fn);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
  const open = (device: string) => new Promise<{ ws: WebSocket; lines: string[]; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
    const lines: string[] = []; let ok = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") lines.push(String(m.text ?? "")); if (m.type === "ready") ok = true; });
    ws.once("open", () => resolve({ ws, lines, ready: () => ok })); ws.once("error", reject);
  });
  const first = await open(o.from);
  first.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => first.lines.length >= 1);
  first.ws.send(JSON.stringify({ type: "text", text: "The navy jacket, size medium." }));
  await waitFor(() => first.lines.length >= 2);
  if (o.hangUp) first.ws.send(JSON.stringify({ type: "stop" }));
  first.ws.close(); // no stop: the network dropped
  await waitFor(() => logs.includes("session.close"));
  await waitFor(() => logs.includes("history.cached"));
  await memory.drain();
  // the time the user was away (the server reads Date.now)
  if (o.gapMs) { const real = Date.now; const gap = o.gapMs; Date.now = () => real() + gap; t.after(() => { Date.now = real; }); }
  // the app on the other device takes the conversation when its call starts (like Move / Call here)
  if (o.to !== o.from) {
    const claim = await fetch(`http://127.0.0.1:${addr.port}/v1/handoff/claim`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ device: o.to, trigger: "button" }) });
    assert.equal(claim.status, 200);
  }
  const back = await open(o.to);
  back.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(back.ready);
  await new Promise((r) => setTimeout(r, 700)); // the switch's 250 ms lease, then the line
  back.ws.close();
  return { logs, lines: back.lines };
}

test("reconnect: the same device coming back after a drop says the short line (seeded, no full greeting)", { timeout: 20_000 }, async (t) => {
  const { logs, lines } = await dropAndReturn(t, { from: "iphone", to: "iphone" });
  assert.ok(logs.includes("history.seeded"), "the conversation goes on");
  assert.ok(logs.includes("call.reconnect_line"));
  assert.deepEqual(lines, [RECONNECT_LINE]);
});

test("reconnect: the other device more than 10 s after a drop says the short line", { timeout: 20_000 }, async (t) => {
  const { logs, lines } = await dropAndReturn(t, { from: "mac", to: "iphone", gapMs: 11_000 });
  assert.ok(logs.includes("history.seeded"));
  assert.deepEqual(lines, [RECONNECT_LINE]);
});

test("reconnect: the other device within 10 s of a drop, or after hanging up there, goes on silently (a move)", { timeout: 30_000 }, async (t) => {
  const quick = await dropAndReturn(t, { from: "mac", to: "iphone" });
  assert.ok(quick.logs.includes("history.seeded"));
  assert.ok(!quick.logs.includes("call.reconnect_line"));
  assert.deepEqual(quick.lines, []);
  const hungUp = await dropAndReturn(t, { from: "mac", to: "iphone", hangUp: true, gapMs: 11_000 });
  assert.ok(hungUp.logs.includes("history.seeded"));
  assert.ok(!hungUp.logs.includes("call.reconnect_line"));
});

test("server (Codex 11/3): the Mac's stop arriving BEFORE the iPhone's claim still hands over; a stale iPhone copy never replaces the Mac's fuller one", { timeout: 20_000 }, async (t) => {
  const { memory, deps, requests } = setup(fakeSummarizer().fn);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
  const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
    let n = 0; let ok = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
    ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
  });
  const closes = () => logs.filter((e) => e === "session.close").length;
  // 1) stop first, claim later: the next call on the OTHER device continues
  const mac = await open("mac");
  mac.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => mac.replies() >= 1);
  mac.ws.send(JSON.stringify({ type: "text", text: "The navy jacket, size medium." }));
  await waitFor(() => mac.replies() >= 2);
  mac.ws.send(JSON.stringify({ type: "stop" }));
  await waitFor(() => closes() === 1); await memory.drain();
  requests.length = 0;
  const phone = await open("iphone");
  phone.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(phone.ready);
  phone.ws.send(JSON.stringify({ type: "text", text: "Still with me on the phone?" }));
  await waitFor(() => requests.some((r) => /Still with me on the phone/.test(JSON.stringify(r.input))));
  assert.match(JSON.stringify(requests.find((r) => /Still with me on the phone/.test(JSON.stringify(r.input)))!.input), /navy jacket, size medium/);
  await waitFor(() => phone.replies() >= 1);
  phone.ws.send(JSON.stringify({ type: "text", text: "Black it is, final answer." }));
  await waitFor(() => phone.replies() >= 2);
  phone.ws.send(JSON.stringify({ type: "stop" }));
  await waitFor(() => closes() === 2); await memory.drain();
  // 2) back on the Mac (the other device): continues with the phone's fuller turns, decision included
  requests.length = 0;
  const mac2 = await open("mac");
  mac2.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(mac2.ready);
  mac2.ws.send(JSON.stringify({ type: "text", text: "And now the Mac again." }));
  await waitFor(() => requests.some((r) => /And now the Mac again/.test(JSON.stringify(r.input))));
  assert.match(JSON.stringify(requests.find((r) => /And now the Mac again/.test(JSON.stringify(r.input)))!.input), /Black it is, final answer/);
  mac2.ws.close();
});

test("server (Codex 11/3 r3): an ended call still closing its socket is not a live call to continue; the device that moved on wins", { timeout: 20_000 }, async (t) => {
  const { memory, deps, requests } = setup(fakeSummarizer().fn);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
  const sockets: WebSocket[] = [];
  t.after(() => sockets.forEach((w) => w.terminate()));
  const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
    sockets.push(ws);
    let n = 0; let ok = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
    ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
  });
  const mac = await open("mac");
  mac.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => mac.replies() >= 1);
  mac.ws.send(JSON.stringify({ type: "text", text: "White or black?" }));
  await waitFor(() => mac.replies() >= 2);
  const phone = await open("iphone");
  phone.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(phone.ready);
  phone.ws.send(JSON.stringify({ type: "text", text: "Black it is." }));
  await waitFor(() => phone.replies() >= 1);
  // the Mac handles stop but its close handshake stalls; the iPhone hangs up normally
  mac.ws.pause(); mac.ws.send(JSON.stringify({ type: "stop" }));
  await new Promise((r) => setTimeout(r, 100));
  phone.ws.send(JSON.stringify({ type: "stop" }));
  await waitFor(() => logs.filter((e) => e === "session.close").length >= 1); await memory.drain();
  requests.length = 0;
  const seededBefore = logs.filter((e) => e === "history.seeded").length;
  const back = await open("iphone");
  back.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => back.replies() >= 1);
  assert.equal(logs.filter((e) => e === "history.seeded").length, seededBefore, "not seeded from the stopped Mac call");
  assert.ok(logs.includes("history.not_seeded"), "a return visit on the iPhone that hung up");
  for (const w of sockets) w.terminate();
});

test("server (Codex 11/3 r4): the old Mac's late close never replaces a newer iPhone call's cache, even of another thread", { timeout: 20_000 }, async (t) => {
  const { memory, deps, requests } = setup(fakeSummarizer().fn);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
  const sockets: WebSocket[] = [];
  const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
    sockets.push(ws);
    let n = 0; let ok = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
    ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
  });
  const closes = () => logs.filter((e) => e === "session.close").length;
  const say = async (c: { ws: WebSocket; replies: () => number }, text: string) => { const n = c.replies(); c.ws.send(JSON.stringify({ type: "text", text })); await waitFor(() => c.replies() > n); };
  const start = (c: { ws: WebSocket }) => c.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  const mac = await open("mac"); start(mac); await waitFor(() => mac.replies() >= 1);
  await say(mac, "White or black for the party?");
  const phone = await open("iphone"); start(phone); await waitFor(phone.ready); // continues the Mac's thread
  await say(phone, "Black it is.");
  mac.ws.pause(); mac.ws.send(JSON.stringify({ type: "stop" })); // the Mac's close handshake stalls
  await new Promise((r) => setTimeout(r, 100));
  phone.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => closes() === 1);
  const again = await open("iphone"); start(again); await waitFor(() => again.replies() >= 1); // a return visit: new thread
  await say(again, "Dark brown shoes, decided.");
  again.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => closes() === 2); await memory.drain();
  mac.ws.resume(); await waitFor(() => closes() === 3); await memory.drain(); // the old Mac finally closes
  requests.length = 0;
  const onMac = await open("mac"); start(onMac); await waitFor(onMac.ready);
  await say(onMac, "Where were we?");
  const req = requests.find((r) => /Where were we/.test(JSON.stringify(r.input)))!;
  assert.match(JSON.stringify(req.input), /Dark brown shoes, decided/, "the newest call's turns, not the old Mac's");
  for (const w of sockets) w.terminate();
});

for (const which of ["stopped Mac still closing hands over", "late old-Mac close keeps the iPhone's hang-up"] as const) {
  test(`server (Codex 11/3 r6): ${which}`, { timeout: 20_000 }, async (t) => {
    const { memory, deps, requests } = setup(fakeSummarizer().fn);
    const logs: string[] = [];
    const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const addr = server.address(); assert.ok(addr && typeof addr === "object");
    const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
    const sockets: WebSocket[] = [];
    const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
      sockets.push(ws);
      let n = 0; let ok = false;
      ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
      ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
    });
    const closes = () => logs.filter((e) => e === "session.close").length;
    const start = (c: { ws: WebSocket }) => c.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
    const mac = await open("mac"); start(mac); await waitFor(() => mac.replies() >= 1);
    mac.ws.send(JSON.stringify({ type: "text", text: "Black it is, final answer." })); await waitFor(() => mac.replies() >= 2);
    if (which === "stopped Mac still closing hands over") {
      mac.ws.pause(); mac.ws.send(JSON.stringify({ type: "stop" })); // stop handled, close handshake stalls, nothing cached yet
      await new Promise((r) => setTimeout(r, 100));
      requests.length = 0;
      const phone = await open("iphone"); start(phone); await waitFor(phone.ready);
      phone.ws.send(JSON.stringify({ type: "text", text: "Still with me on the phone?" }));
      await waitFor(() => requests.some((r) => /Still with me on the phone/.test(JSON.stringify(r.input))));
      assert.match(JSON.stringify(requests.find((r) => /Still with me on the phone/.test(JSON.stringify(r.input)))!.input), /Black it is, final answer/);
    } else {
      const phone = await open("iphone"); start(phone); await waitFor(phone.ready); // inherits, says nothing
      mac.ws.pause(); mac.ws.send(JSON.stringify({ type: "stop" }));
      await new Promise((r) => setTimeout(r, 100));
      phone.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => closes() === 1); await memory.drain();
      mac.ws.resume(); await waitFor(() => closes() === 2); await memory.drain(); // the old Mac closes late, same progress
      const before = logs.filter((e) => e === "history.seeded").length;
      const back = await open("iphone"); start(back); await waitFor(() => back.replies() >= 1);
      assert.equal(logs.filter((e) => e === "history.seeded").length, before, "the iPhone that hung up gets a return-visit greeting");
      assert.ok(logs.includes("history.not_seeded"));
    }
    for (const w of sockets) w.terminate();
  });
}

for (const which of ["iPhone inherits, then hangs up after the Mac's close", "both stopped and closing, iPhone calls back"] as const) {
  test(`server (Codex 11/3 r7): ${which} → the iPhone's call back is a return visit`, { timeout: 20_000 }, async (t) => {
    const { memory, deps } = setup(fakeSummarizer().fn);
    const logs: string[] = [];
    const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const addr = server.address(); assert.ok(addr && typeof addr === "object");
    const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
    const sockets: WebSocket[] = [];
    const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
      sockets.push(ws);
      let n = 0; let ok = false;
      ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
      ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
    });
    const closes = () => logs.filter((e) => e === "session.close").length;
    const start = (c: { ws: WebSocket }) => c.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
    const mac = await open("mac"); start(mac); await waitFor(() => mac.replies() >= 1);
    mac.ws.send(JSON.stringify({ type: "text", text: "Black it is." })); await waitFor(() => mac.replies() >= 2);
    if (which === "iPhone inherits, then hangs up after the Mac's close") {
      const phone = await open("iphone"); start(phone); await waitFor(phone.ready); // inherits the live Mac call, says nothing
      mac.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => closes() === 1); await memory.drain();
      phone.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => closes() === 2); await memory.drain();
    } else {
      const phone = await open("iphone"); start(phone); await waitFor(phone.ready);
      mac.ws.pause(); phone.ws.pause();
      mac.ws.send(JSON.stringify({ type: "stop" })); phone.ws.send(JSON.stringify({ type: "stop" }));
      await new Promise((r) => setTimeout(r, 150));
    }
    const before = logs.filter((e) => e === "history.seeded").length;
    const back = await open("iphone"); start(back); await waitFor(() => back.replies() >= 1);
    assert.equal(logs.filter((e) => e === "history.seeded").length, before, "not continued: she hung up on this iPhone");
    assert.ok(logs.includes("history.not_seeded"));
    for (const w of sockets) w.terminate();
  });
}

test("server (Codex 11/3 r8): join order, not socket order — a Mac whose first memory read was slow inherits the iPhone and its own hang-up counts", { timeout: 20_000 }, async (t) => {
  const { memory, deps, repo } = setup(fakeSummarizer().fn);
  const logs: string[] = [];
  let slow = true; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const getState = repo.getState.bind(repo);
  repo.getState = async (u) => { if (slow) { slow = false; await gate; } return getState(u); };
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
  const sockets: WebSocket[] = [];
  const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
    sockets.push(ws);
    let n = 0; let ok = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
    ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
  });
  const closes = () => logs.filter((e) => e === "session.close").length;
  const start = (c: { ws: WebSocket }) => c.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  const mac = await open("mac"); start(mac); // its first memory read stalls (under the 1.5 s start budget)
  await new Promise((r) => setTimeout(r, 50));
  const phone = await open("iphone"); start(phone); await waitFor(phone.ready);
  const n = phone.replies(); phone.ws.send(JSON.stringify({ type: "text", text: "Black it is." })); await waitFor(() => phone.replies() > n);
  release(); await waitFor(mac.ready); // the Mac joins now and inherits the iPhone's live turns
  assert.ok(logs.includes("history.seeded"));
  phone.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => closes() === 1); await memory.drain();
  mac.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => closes() === 2); await memory.drain();
  const before = logs.filter((e) => e === "history.seeded").length;
  const back = await open("mac"); start(back); await waitFor(() => back.replies() >= 1);
  assert.equal(logs.filter((e) => e === "history.seeded").length, before, "she hung up on the Mac last: a return visit there");
  for (const w of sockets) w.terminate();
});

test("server (train review P2): iPhone → Mac, the Mac hangs up, the old iPhone closes late at the same progress → the Mac's call back is a return visit", { timeout: 20_000 }, async (t) => {
  const { memory, deps } = setup(fakeSummarizer().fn);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
  const sockets: WebSocket[] = [];
  const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
    sockets.push(ws);
    let n = 0; let ok = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
    ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
  });
  const closes = () => logs.filter((e) => e === "session.close").length;
  const start = (c: { ws: WebSocket }) => c.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  const phone = await open("iphone"); start(phone); await waitFor(() => phone.replies() >= 1);
  phone.ws.send(JSON.stringify({ type: "text", text: "Black it is." })); await waitFor(() => phone.replies() >= 2);
  const mac = await open("mac"); start(mac); await waitFor(mac.ready); // takes over, says nothing
  phone.ws.pause(); phone.ws.send(JSON.stringify({ type: "stop" })); // the old iPhone's close stalls
  await new Promise((r) => setTimeout(r, 100));
  mac.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => closes() === 1); await memory.drain();
  phone.ws.resume(); await waitFor(() => closes() === 2); await memory.drain();
  const before = logs.filter((e) => e === "history.seeded").length;
  const back = await open("mac"); start(back); await waitFor(() => back.replies() >= 1);
  assert.equal(logs.filter((e) => e === "history.seeded").length, before, "the Mac hung up last: a return visit there");
  for (const w of sockets) w.terminate();
});

test("QA 11/3 P2: a forget request never becomes a memory or a note (no 'you told me to forget X')", () => {
  for (const bad of ["User asked to forget the leather accessories thing", "Asked me not to remember the leather bag", "Wants the companion to erase what they said about leather", "Forget the leather accessories thing", "Please forget about it", "Don't remember that I said that", "Leather accessories, asked to be forgotten", "가죽 얘기는 잊어 달라고 함", "그 얘기 기억하지 마"]) {
    assert.equal(safeMemoryText(bad), false, bad);
  }
  // ordinary facts that happen to say "forget" stay (coordinator 11/3)
  for (const ok of ["I always forget my keys", "I forgot my umbrella at the cafe", "I tend to forget birthdays", "My favorite movie is Forgetting Sarah Marshall"]) {
    assert.equal(safeMemoryText(ok), true, ok);
  }
  const s = cleanSummary({ topics: ["Leather accessories (asked to forget)", "Jacket shopping"], mood: "relaxed", open_threads: ["User wants Jin to forget the leather thing"], promises: ["Forget the leather accessories"], asks: [] });
  assert.deepEqual(s, { topics: ["Jacket shopping"], mood: "relaxed", open_threads: [], promises: [], asks: [] });
});

test("Codex 11/3 (#443): an empty summary of a thread whose topic was asked to be forgotten clears that thread's old row", async () => {
  let next: Summarizer = async () => cleanSummary({ topics: ["Leather accessories"], mood: "", open_threads: [], promises: [], asks: [] });
  const { memory } = setup(async (t, p) => next(t, p));
  await memory.summarizeThread("acct-a", "t1", [{ user: "I love leather accessories.", assistant: "Nice." }], 0);
  assert.equal((await memory.summaries("acct-a")).length, 1);
  next = async () => null; // the model left everything out: "forget the leather thing"
  await memory.summarizeThread("acct-a", "t1", [{ user: "Forget the leather thing.", assistant: "Done." }], 0, 2);
  assert.deepEqual(await memory.summaries("acct-a"), [], "no stale 'Leather accessories' note for the next call");
  // a vendor failure (throw) keeps the old row
  next = async () => cleanSummary({ topics: ["Jacket shopping"], mood: "", open_threads: [], promises: [], asks: [] });
  await memory.summarizeThread("acct-a", "t2", [{ user: "Jacket?", assistant: "Sure." }], 0);
  next = async () => { throw new Error("vendor"); };
  await memory.summarizeThread("acct-a", "t2", [{ user: "x", assistant: "y" }], 0, 2).catch(() => null);
  assert.equal((await memory.summaries("acct-a")).length, 1);
});

test("Codex 11/3 (#443): recall keys never carry a forget request, and the recall tool returns only id + text", async () => {
  assert.deepEqual(cleanKeys(["forget the leather thing", "jacket", "navy", "잊어줘"]), ["jacket", "navy"]);
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [{ text: "I like navy jackets.", kind: "fact", sensitive: "none", follow_up: false, keys: ["forget the leather thing", "jacket"] }] });
  await memory.extract("u", "s", [{ user: "I like navy jackets.", assistant: "Nice." }], 0);
  assert.deepEqual((await memory.list("u"))[0].keys, ["jacket"]);
  const call = new MemoryCall(memory, "u", "s2"); await call.open(false);
  const out = await (call as unknown as { execute(c: { name: string; arguments: string; call_id: string; type: "function_call" }): Promise<{ memories: Record<string, unknown>[] }> }).execute({ type: "function_call", name: "recall", call_id: "c", arguments: JSON.stringify({ query: "navy jacket" }) });
  assert.deepEqual(Object.keys(out.memories[0]).sort(), ["id", "text"]);
  call.close(); await memory.drain();
});

test("P1 FILM 11/3: a quick call-back after a hang-up has the call that just ended even while its summary is still being written", { timeout: 20_000 }, async (t) => {
  const never: Summarizer = () => new Promise(() => {}); // the background summary is slow (Spark Open reasoning)
  const { deps, requests } = setup(never);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
  const sockets: WebSocket[] = [];
  const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
    sockets.push(ws);
    let n = 0;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; });
    ws.once("open", () => resolve({ ws, replies: () => n })); ws.once("error", reject);
  });
  const start = (c: { ws: WebSocket }) => c.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  const c1 = await open("iphone"); start(c1); await waitFor(() => c1.replies() >= 1);
  for (const line of ["White or black for the Halloween party?", "Black it is.", "Remind me to get dark brown shoes."]) {
    const n = c1.replies(); c1.ws.send(JSON.stringify({ type: "text", text: line })); await waitFor(() => c1.replies() > n);
  }
  c1.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => logs.includes("session.close"));
  requests.length = 0;
  const back = await open("iphone"); start(back); await waitFor(() => back.replies() >= 1);
  const inst = requests[0].instructions ?? "";
  assert.match(inst, /ended moments ago/);
  assert.match(inst, /Black it is/); assert.match(inst, /dark brown shoes/);
  // the next reply keeps it too (recall question), not just the greeting
  const n = back.replies(); back.ws.send(JSON.stringify({ type: "text", text: "What did I decide?" })); await waitFor(() => back.replies() > n);
  assert.match(requests.at(-1)!.instructions ?? "", /Black it is/);
  for (const w of sockets) w.terminate();
});

test("Codex 11/3 (#447): a hung-up call with a forget request in it sends no raw lines; a mid-call summary doesn't hide the later decision", async () => {
  const { memory } = setup();
  const c = new MemoryCall(memory, "acct-a", "back"); await c.open(false);
  c.setLastCall([{ role: "user", text: "I picked the leather jacket." }, { role: "assistant", text: "Nice." }, { role: "user", text: "Forget the leather thing." }], "t1", 2);
  assert.equal(c.lastCall, null, "nothing from that call rides along until its safe summary exists");
  c.setLastCall([{ role: "user", text: "White or black?" }, { role: "assistant", text: "Black." }, { role: "user", text: "Black it is, final." }], "t2", 13);
  c.summaries = [{ thread_id: "t2", turns: 12, created_at: 0, updated_at: 0, topics: ["Choosing white vs black"], mood: null, open_threads: ["White or black"], promises: [], asks: [] }];
  const reqs: SparkRequest[] = [];
  const src = async function* (req: SparkRequest) { reqs.push(req); yield { type: "text", delta: "ok" } as const; yield { type: "done", responseId: "r", text: "", status: "completed" } as const; };
  for await (const _ of c.stream({ input: "hi" }, new AbortController().signal, src as never, "hi", null)) { /* drain */ }
  assert.match(reqs[0].instructions ?? "", /Black it is, final/, "the 12-turn summary doesn't cover turn 13");
  c.close(); await memory.drain();
});

test("Codex 11/3 (#447 r2): a forget request early in the call (outside the last lines) still keeps all raw lines out of the call-back", { timeout: 20_000 }, async (t) => {
  const never: Summarizer = () => new Promise(() => {});
  const { deps, requests } = setup(never);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
  const sockets: WebSocket[] = [];
  const open = () => new Promise<{ ws: WebSocket; replies: () => number }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=iphone`, { headers });
    sockets.push(ws);
    let n = 0;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; });
    ws.once("open", () => resolve({ ws, replies: () => n })); ws.once("error", reject);
  });
  const start = (c: { ws: WebSocket }) => c.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  const c1 = await open(); start(c1); await waitFor(() => c1.replies() >= 1);
  for (const line of ["Don't remember anything from this call.", "I bought an amber pendant.", "It was on sale.", "The chain is gold.", "I wore it today."]) {
    const n = c1.replies(); c1.ws.send(JSON.stringify({ type: "text", text: line })); await waitFor(() => c1.replies() > n);
  }
  c1.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => logs.includes("session.close"));
  requests.length = 0;
  const back = await open(); start(back); await waitFor(() => back.replies() >= 1);
  assert.doesNotMatch(requests[0].instructions ?? "", /amber pendant|ended moments ago/);
  for (const w of sockets) w.terminate();
});

test("Codex 11/3 (#447 r3): a forget request travels with the conversation to the other device", { timeout: 20_000 }, async (t) => {
  const never: Summarizer = () => new Promise(() => {});
  const { deps, requests } = setup(never);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
  const sockets: WebSocket[] = [];
  const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
    sockets.push(ws);
    let n = 0; let ok = false;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
    ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
  });
  const start = (c: { ws: WebSocket }) => c.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  const say = async (c: { ws: WebSocket; replies: () => number }, text: string) => { const n = c.replies(); c.ws.send(JSON.stringify({ type: "text", text })); await waitFor(() => c.replies() > n); };
  const phone = await open("iphone"); start(phone); await waitFor(() => phone.replies() >= 1);
  await say(phone, "Don't remember anything from this call.");
  for (let i = 0; i < 8; i++) await say(phone, i === 7 ? "I bought an amber pendant." : `Small talk line ${i}.`);
  const mac = await open("mac"); start(mac); await waitFor(mac.ready); // inherits; the request is outside its kept lines
  await say(mac, "On the Mac now.");
  phone.ws.send(JSON.stringify({ type: "stop" }));
  mac.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => logs.filter((e) => e === "session.close").length >= 2);
  requests.length = 0;
  const back = await open("mac"); start(back); await waitFor(() => back.replies() >= 1);
  assert.doesNotMatch(requests[0].instructions ?? "", /amber pendant|ended moments ago/);
  for (const w of sockets) w.terminate();
});

test("Codex 11/4 (hotfix merge): a 'forget that …' said in the call-back clears the matching line of the call that just ended", async () => {
  const { memory } = setup();
  const c = new MemoryCall(memory, "acct-a", "back"); await c.open(false);
  c.setLastCall([{ role: "user", text: "I like leather accessories." }, { role: "assistant", text: "Leather suits you." }, { role: "user", text: "Black it is." }], "t1", 2);
  c.setAvoid([{ text: "I like leather accessories", forget: true }]);
  const reqs: SparkRequest[] = [];
  const src = async function* (req: SparkRequest) { reqs.push(req); yield { type: "text", delta: "ok" } as const; yield { type: "done", responseId: "r", text: "", status: "completed" } as const; };
  for await (const _ of c.stream({ input: "What should I wear?" }, new AbortController().signal, src as never, "What should I wear?", undefined)) { /* drain */ }
  const inst = reqs[0].instructions ?? "";
  assert.doesNotMatch(inst, /leather/i);
  assert.match(inst, /Black it is/, "the rest of the last call stays");
  c.close(); await memory.drain();
});

test("Codex #502 P1 r3: a crisis line travels with the conversation to the other device (no take nudge after the move)", { timeout: 30_000 }, async (t) => {
  for (const first of ["I want to kill myself.", "Long day."]) {
    const { deps, requests } = setup();
    const logs: string[] = [];
    const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const addr = server.address(); assert.ok(addr && typeof addr === "object");
    const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-a" };
    const sockets: WebSocket[] = [];
    const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number; ready: () => boolean }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
      sockets.push(ws);
      let n = 0; let ok = false;
      ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
      ws.once("open", () => resolve({ ws, replies: () => n, ready: () => ok })); ws.once("error", reject);
    });
    const start = (c: { ws: WebSocket }) => c.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
    const say = async (c: { ws: WebSocket; replies: () => number }, text: string) => { const n = c.replies(); c.ws.send(JSON.stringify({ type: "text", text })); await waitFor(() => c.replies() > n); };
    const phone = await open("iphone"); start(phone); await waitFor(() => phone.replies() >= 1);
    await say(phone, first);
    for (let i = 0; i < 8; i++) await say(phone, "ok"); // the first line is now outside the kept 16
    const mac = await open("mac"); start(mac); await waitFor(mac.ready);
    requests.length = 0;
    // an ordinary line on the Mac (#533 made "I'm about to swallow all these pills" a crisis line itself, so the
    // control's nudge was blocked too): only the moved conversation's early line may decide
    await say(mac, "anyway what should I eat tonight");
    const inst = requests.map((r) => r.instructions ?? "").join("\n");
    if (first === "Long day.") assert.match(inst, /own take/, "control: no crisis in the conversation, the nudge fires");
    else assert.doesNotMatch(inst, /own take/);
    for (const w of sockets) w.terminate();
  }
});

test("Codex #502 P1 r5: with memory on, a client-claimed handoff history of 20 keeps its early crisis line's flag", { timeout: 30_000 }, async (t) => {
  const { deps, requests } = setup();
  const server = await startServer({ ...config, sessionToken: "test-token" }, () => {}, { ...deps, log: () => {} }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=mac`, { headers: { authorization: "Bearer test-token", "x-genita-user": "acct-r5" } });
  let n = 0; let ok = false;
  ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; if (m.type === "ready") ok = true; });
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const history = [{ role: "user", text: "I want to kill myself." }, { role: "assistant", text: "Please call 988 right now." },
    ...Array.from({ length: 18 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: i % 2 ? "Okay." : "ok" }))];
  ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false, handoff: true, history }));
  await waitFor(() => ok);
  requests.length = 0;
  const before = n; ws.send(JSON.stringify({ type: "text", text: "Yes, I have the pills beside me" })); await waitFor(() => n > before);
  assert.doesNotMatch(requests.map((r) => r.instructions ?? "").join("\n"), /own take/);
  ws.terminate();
});

test("AU-42: a Mac start without a name uses the name the account's iPhone sent (greeting + name guards work on the Mac)", { timeout: 30_000 }, async (t) => {
  const never: Summarizer = () => new Promise(() => {});
  const { deps, requests } = setup(never);
  const logs: string[] = [];
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, { ...deps, log: (e) => { logs.push(e); } }, {}, null);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const headers = { authorization: "Bearer test-token", "x-genita-user": "acct-au42" };
  const sockets: WebSocket[] = [];
  const open = (device: string) => new Promise<{ ws: WebSocket; replies: () => number }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session?device=${device}`, { headers });
    sockets.push(ws); let n = 0;
    ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") n++; });
    ws.once("open", () => resolve({ ws, replies: () => n })); ws.once("error", reject);
  });
  const phone = await open("iphone");
  phone.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false, user: { name: "Summer" } }));
  await waitFor(() => phone.replies() >= 1);
  phone.ws.send(JSON.stringify({ type: "stop" })); await waitFor(() => logs.includes("session.close"));
  requests.length = 0;
  const mac = await open("mac");
  mac.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  // (right after the iPhone call the Mac may continue it without a greeting: ask something instead)
  await pause(300); const n = mac.replies(); mac.ws.send(JSON.stringify({ type: "text", text: "what should I eat" }));
  try {
    await waitFor(() => mac.replies() > n);
    assert.match(requests.at(-1)!.instructions ?? "", /The user's name is Summer/);
  } finally { for (const w of sockets) w.terminate(); }
});
