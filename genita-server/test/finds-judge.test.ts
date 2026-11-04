/**
 * Chelsea 11/4: the find trigger decides from what was said AND what the camera / screen shows. Keyword intents stay
 * the fast path; an "open" line goes to the judge beside the spoken reply (stubbed here; live numbers in
 * scripts/find-judge-eval.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import { assessLine } from "../src/finds/general.ts";
import { parseJudge, judgeWithin, type Judge, type JudgeInput, type JudgeResult } from "../src/finds/judge.ts";
import type { FindsVendors, OutputItem } from "../src/finds/vendors.ts";
import type { ServerEvent } from "../src/protocol.ts";
import { STAYS_SPOKEN } from "./helpers/general-lines.ts";

const FRAME = "data:image/jpeg;base64,AAAA";
const searchItem = (urls: string[]): OutputItem => ({ type: "web_search_call", status: "completed", action: { type: "search", sources: urls.map((url) => ({ type: "url", url })) } }) as OutputItem;
function vendors(seen: string[] = []): FindsVendors {
  return {
    async spark(req) {
      seen.push(JSON.stringify(req.input).slice(0, 400));
      return { text: JSON.stringify({ title: "Ramen near Hongdae", results: [{ title: "Hongdae ramen guide", why: "Six shops.", url: "https://www.timeout.com/seoul/hongdae-ramen" }] }), output: [searchItem(["https://www.timeout.com/seoul/hongdae-ramen"])] };
    },
    async *sparkStream() {},
    async sam() { return []; },
    async image() { return Buffer.from(""); },
  };
}
function runnerWith(judge: Judge, opts: { timeoutMs?: number; seen?: string[] } = {}) {
  const events: ServerEvent[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const said: string[] = [];
  const r = new FindsRunner(
    { vendors: vendors(opts.seen), store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds", judge, judgeTimeoutMs: opts.timeoutMs ?? 200 },
    { emit: (e) => events.push(e), announce: (t) => said.push(t), log: (e, d) => logs.push([e, d]), now: () => performance.now() },
  );
  return { r, events, logs, said };
}
const settleJudge = () => new Promise((r) => setTimeout(r, 30));
const turn = (text: string, frames: string[] = [], recent: string[] = []) => ({ text, frames, utteranceId: 7, replyText: Promise.resolve("Sure."), recent });

test("judge: an open line the keywords miss is judged with the context; a general pick starts the sheet at once with the judge's query", async () => {
  const inputs: JudgeInput[] = [];
  const seen: string[] = [];
  const { r, events, said } = runnerWith(async (i) => { inputs.push(i); return { kind: "general", query: "ramen shops near Hongdae Seoul", reason: "place info" }; }, { seen });
  const line = "Any ideas for something fun to do tonight?";
  assert.equal(assessLine(line), "open", "no rule either way");
  const started = r.onTurn(turn(line, [], ["User: I'm craving ramen.", "You: Ooh, nice."]));
  assert.equal(started, null, "the spoken reply runs as usual (no fixed line)");
  await settleJudge();
  assert.deepEqual(inputs[0].recent, ["User: I'm craving ramen.", "You: Ooh, nice."]);
  const s = events.find((e) => e.type === "find.started") as Extract<ServerEvent, { type: "find.started" }>;
  assert.equal(s?.kind, "answer");
  await r.settle();
  assert.ok(events.some((e) => e.type === "find.created" && e.card.kind === "answer"));
  assert.match(seen.at(-1)!, /ramen shops near Hongdae Seoul/, "the search uses the judge's filled-in query");
  assert.deepEqual(said, ["Here are a few spots, with photos and a map."], "a place search says what its card shows, never \"links\"");
  // the reply's own web search adds no second card for the same turn
  assert.equal(r.webAnswer({ utteranceId: 7, question: line, said: "Try Menya.", searches: [{ query: "q", urls: ["https://a.com/x"] }] }), null);
});

test("judge: a thing in view with a request ('where can I get these?') goes to the judge with the frame; a product pick starts the search", async () => {
  const inputs: JudgeInput[] = [];
  const { r, events } = runnerWith(async (i) => { inputs.push(i); return { kind: "product", query: "white leather low-top sneakers", reason: "wants to buy" }; });
  const line = "Where could I get these?";
  r.onTurn(turn(line, [FRAME]));
  await settleJudge();
  assert.equal(inputs[0]?.frame, FRAME, "the latest camera frame goes with it");
  assert.ok(events.some((e) => e.type === "find.started" && e.kind === "product"));
  r.close();
});

test("judge: camera kinds need a picture; identify with the camera on draws only the outline (no second spoken line)", async () => {
  const { r, events } = runnerWith(async () => ({ kind: "identify", reason: "what is it" }));
  r.onTurn(turn("Any idea what kind exactly?"));
  await settleJudge();
  assert.equal(events.length, 0, "no picture, no identify");
  r.close();
});

test("judge: a slow judge times out to none (no card); the deadline helper says so", async () => {
  const { r, events, logs } = runnerWith(() => new Promise<JudgeResult>(() => {}), { timeoutMs: 20 });
  r.onTurn(turn("Any ideas for something fun to do tonight?"));
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(events.length, 0);
  const judged = logs.find(([e]) => e === "finds.judge");
  assert.equal(judged?.[1].kind, "none");
  assert.equal(judged?.[1].reason, "timeout");
  const t0 = performance.now();
  const res = await judgeWithin(() => new Promise<JudgeResult>(() => {}), { text: "x", recent: [] }, 25);
  assert.equal(res.kind, "none");
  assert.ok(performance.now() - t0 < 200);
});

test("judge: GENITA_FIND_JUDGE=0 turns it off (default on)", async () => {
  let calls = 0;
  const { r, events } = runnerWith(async () => { calls++; return { kind: "general", reason: "x" }; });
  process.env.GENITA_FIND_JUDGE = "0";
  try {
    r.onTurn(turn("Any ideas for something fun to do tonight?"));
    await settleJudge();
  } finally {
    delete process.env.GENITA_FIND_JUDGE;
  }
  assert.equal(calls, 0);
  assert.equal(events.length, 0);
  r.onTurn(turn("Any ideas for something fun to do tonight?"));
  await settleJudge();
  assert.equal(calls, 1, "on by default");
  r.close();
});

test("judge: spoken-only lines (greetings, feelings, opinions about what's shown, demo lines) are never judged into a card", async () => {
  let calls = 0;
  const { r, logs } = runnerWith(async () => { calls++; return { kind: "product", query: "anything", reason: "stub always buys" }; });
  for (const line of STAYS_SPOKEN) {
    for (const frames of [[], [FRAME]]) {
      r.onTurn(turn(line, frames));
      await settleJudge();
      assert.ok(!logs.some(([e, d]) => e === "finds.judge" && d.started), `${line} (camera ${frames.length ? "on" : "off"})`);
    }
  }
  assert.equal(calls, 0, "the judge is not even asked");
  r.close();
});

test("judge: a newer turn stops the older judge; parse keeps only known kinds", async () => {
  let release: (r: JudgeResult) => void = () => {};
  const { r, events } = runnerWith(() => new Promise<JudgeResult>((res) => (release = res)), { timeoutMs: 500 });
  r.onTurn(turn("Any ideas for something fun to do tonight?"));
  r.onTurn({ ...turn("How are you?"), utteranceId: 8 });
  release({ kind: "general", reason: "late" });
  await settleJudge();
  assert.equal(events.length, 0, "the old turn's pick is dropped");
  assert.deepEqual(parseJudge('{"kind":"weather","reason":"x"}'), { kind: "none", reason: "unparsed" });
  assert.deepEqual(parseJudge('{"kind":"general","query":"best ramen","reason":"info"}'), { kind: "general", query: "best ramen", reason: "info" });
  assert.deepEqual(parseJudge('{"kind":"none","query":"x","reason":"chat"}'), { kind: "none", reason: "chat" });
  r.close();
});

test("judge (Codex r1): a cancelled turn, a Forget, or a card the reply already put up → the late pick starts nothing", async () => {
  const late = () => { let release: (r: JudgeResult) => void = () => {}; const p = new Promise<JudgeResult>((res) => (release = res)); return { p, release: (r: JudgeResult) => release(r) }; };
  // barge-in: the turn's reply resolves null
  let j = late();
  let run = runnerWith(() => j.p, { timeoutMs: 500 });
  run.r.onTurn({ ...turn("Any ideas for something fun to do tonight?"), replyText: Promise.resolve(null) });
  await settleJudge();
  j.release({ kind: "general", reason: "late" });
  await settleJudge();
  assert.equal(run.events.length, 0, "cancelled turn");
  run.r.close();
  // Forget all of this
  j = late();
  run = runnerWith(() => j.p, { timeoutMs: 500 });
  run.r.onTurn(turn("Any ideas for something fun to do tonight?"));
  run.r.forgetTaste();
  j.release({ kind: "general", reason: "late" });
  await settleJudge();
  assert.equal(run.events.length, 0, "forgotten");
  run.r.close();
  // the reply's own web search landed first
  j = late();
  run = runnerWith(() => j.p, { timeoutMs: 500 });
  run.r.onTurn(turn("Any ideas for something fun to do tonight?"));
  assert.ok(run.r.webAnswer({ utteranceId: 7, question: "q", said: "Try Menya.", searches: [{ query: "q", urls: ["https://www.timeout.com/x"] }] }));
  j.release({ kind: "general", reason: "late" });
  await settleJudge();
  assert.equal(run.events.filter((e) => e.type === "find.started").length, 1, "one card per turn");
  run.r.close();
});

test("judge (Codex r1): 'on the screen' sends the shared frame (and the card keeps it); screen only still allows recipe/outfit", async () => {
  const SCREEN = "data:image/jpeg;base64,SCREEN";
  const inputs: JudgeInput[] = [];
  const { r, events } = runnerWith(async (i) => { inputs.push(i); return { kind: "product", query: "that lamp", reason: "buy" }; });
  r.onTurn({ ...turn("Where could I get these on the screen?", [FRAME]), screen: SCREEN });
  await settleJudge();
  assert.equal(inputs[0].frame, SCREEN);
  assert.equal(inputs[0].screen, true);
  assert.ok(events.some((e) => e.type === "find.started" && e.kind === "product"));
  r.close();
  const { judgedIntent } = await import("../src/finds/runner.ts");
  assert.deepEqual(judgedIntent({ kind: "recipe", reason: "x" }, { text: "What can I make with these?", frames: [], screen: SCREEN }), { kind: "recipe" });
  assert.equal(judgedIntent({ kind: "outfit", reason: "x" }, { text: "x", frames: [] }), null);
});

test("judge (Codex r2): cut off while playing (the turn's signal) → nothing; a reply search with no usable card doesn't block the judge", async () => {
  let release: (r: JudgeResult) => void = () => {};
  let run = runnerWith(() => new Promise<JudgeResult>((res) => (release = res)), { timeoutMs: 500 });
  const turnAbort = new AbortController();
  run.r.onTurn({ ...turn("Any ideas for something fun to do tonight?"), signal: turnAbort.signal });
  turnAbort.abort();
  release({ kind: "general", reason: "late" });
  await settleJudge();
  assert.equal(run.events.length, 0);
  run.r.close();
  run = runnerWith(() => new Promise<JudgeResult>((res) => (release = res)), { timeoutMs: 500 });
  run.r.onTurn(turn("Any ideas for something fun to do tonight?"));
  assert.equal(run.r.webAnswer({ utteranceId: 7, question: "q", said: "Hm.", searches: [{ query: "q", urls: ["https://evil-casino.top/a"] }] }), null);
  release({ kind: "general", reason: "late" });
  await settleJudge();
  assert.ok(run.events.some((e) => e.type === "find.started" && e.kind === "answer"));
  run.r.close();
});

test("judge: describe / observe and dinner-idea lines never become an outfit or recipe card (finds lane rule 11/4)", async () => {
  const { judgedIntent } = await import("../src/finds/runner.ts");
  for (const text of ["What am I wearing?", "Recommend a dinner menu", "Any dinner ideas?", "Do you like my shirt?"]) {
    assert.equal(judgedIntent({ kind: "outfit", reason: "x" }, { text, frames: [FRAME] }), null, text);
    assert.equal(judgedIntent({ kind: "recipe", reason: "x" }, { text, frames: [FRAME] }), null, text);
  }
  assert.deepEqual(judgedIntent({ kind: "outfit", reason: "x" }, { text: "Which one should I go with tonight?", frames: [FRAME] }), { kind: "outfit" });
  assert.deepEqual(judgedIntent({ kind: "recipe", reason: "x" }, { text: "What can I make with what's here?", frames: [FRAME] }), { kind: "recipe" });
  assert.deepEqual(judgedIntent({ kind: "general", reason: "x" }, { text: "Any dinner ideas?", frames: [] }), { kind: "answer" }, "a menu idea sheet is fine");
});
