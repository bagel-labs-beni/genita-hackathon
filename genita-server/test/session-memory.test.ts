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
import { Session, type SessionDeps, type ClientSink } from "../src/session/session.ts";
import type { ServerEvent } from "../src/protocol.ts";
import type { SparkRequest } from "../src/meta/spark.ts";
import { InMemoryMemoryRepository, mergeSummary } from "../src/memory/repository.ts";
import { PgMemoryRepository } from "../src/memory/pgRepository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { safeMemoryText, type Turn } from "../src/memory/extract.ts";
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
  const server = await startServer({ ...config, sessionToken: "test-token" }, (e) => { logs.push(e); }, deps, {}, null);
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
  assert.ok(logs.includes("history.not_cached"));
  requests.length = 0;
  const back = await open();
  back.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  await waitFor(() => back.replies() >= 1);
  assert.ok(!logs.includes("history.seeded"), "not a handoff continuation");
  assert.match(inst(requests[0]), /Your notes from your last calls/);
  assert.match(inst(requests[0]), /picking up where you left off/);
  back.ws.close();
});
