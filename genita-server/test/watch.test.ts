import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import { checkServerEvent, checkWatchEvent, type WatchServerEvent } from "../src/protocol.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";
import { initialTurnState, reduceTurn } from "../src/session/turnMachine.ts";
import { isVideoEcho, pickFrames, reactionAllowed, reactionScript, speakerChipEnabled, type ReactGate } from "../src/watch/rules.ts";
import { buildMemoRequest, buildQuestionContext, parseMemoVerdict } from "../src/watch/memo.ts";
import { WatchController, type WatchDeps, type WatchHost, type WatchSink } from "../src/watch/watch.ts";

// ───────────────────────── rules ─────────────────────────

const gate = (o: Partial<ReactGate> = {}): ReactGate => ({
  now: 100_000,
  sharing: true,
  blank: false,
  sharingSince: 0,
  lastReactionAt: null,
  conversationQuiet: true,
  dialogueActive: false,
  lastDialogueEndAt: null,
  verdictAt: 98_000,
  ...o,
});

test("reaction gate: only while sharing, ≥30 s apart, never over dialogue or talk", () => {
  assert.deepEqual(reactionAllowed(gate()), { ok: true });
  assert.equal(reactionAllowed(gate({ sharing: false })).ok, false);
  assert.deepEqual(reactionAllowed(gate({ lastReactionAt: 75_000 })), { ok: false, why: "gap" });
  assert.deepEqual(reactionAllowed(gate({ lastReactionAt: 70_000 })), { ok: true });
  assert.deepEqual(reactionAllowed(gate({ conversationQuiet: false })), { ok: false, why: "conversation" });
  assert.deepEqual(reactionAllowed(gate({ dialogueActive: true })), { ok: false, why: "dialogue" });
  assert.deepEqual(reactionAllowed(gate({ lastDialogueEndAt: 99_600 })), { ok: false, why: "dialogue" });
  assert.deepEqual(reactionAllowed(gate({ blank: true })), { ok: false, why: "blank" });
  assert.deepEqual(reactionAllowed(gate({ sharingSince: 97_000 })), { ok: false, why: "just_started" });
  assert.deepEqual(reactionAllowed(gate({ verdictAt: 80_000 })), { ok: false, why: "stale" });
});

test("reaction script: funny laughs, tags from Spark are stripped, none says nothing", () => {
  assert.equal(reactionScript("funny", "He fed the ceiling!"), "<laugh> [laughs] He fed the ceiling!");
  assert.equal(reactionScript("surprising", "<happy> [gasps] No way"), "<surprised> No way");
  assert.equal(reactionScript("sweet", "aww look at them"), "<warm> aww look at them");
  assert.equal(reactionScript("none", "anything"), null);
  assert.equal(reactionScript("funny", "  "), null);
});

test("echo guard: the video's line in the mic is not the user's turn", () => {
  const lines = ["Did you just feed the ceiling again?", "It was hungry."];
  assert.equal(isVideoEcho("did you just feed the ceiling again", lines), true);
  assert.equal(isVideoEcho("It was hungry", lines), true);
  assert.equal(isVideoEcho("what did she just say about the ceiling?", lines), false);
  assert.equal(isVideoEcho("haha", lines), false);
});

test("speaker chip needs two voices in the last 2 minutes", () => {
  assert.equal(speakerChipEnabled([{ label: "A", at: 0 }, { label: "A", at: 5 }], 10), false);
  assert.equal(speakerChipEnabled([{ label: "A", at: 0 }, { label: "B", at: 5 }], 10), true);
  assert.equal(speakerChipEnabled([{ label: "A", at: 0 }, { label: "B", at: 5 }], 200_000), false);
});

test("pickFrames: newest plus older ones spaced apart, oldest first", () => {
  const f = [0, 500, 1000, 2000, 3000, 4000, 5000, 6000].map((at) => ({ at }));
  assert.deepEqual(pickFrames(f, 3, 2500).map((x) => x.at), [500, 3000, 6000]);
  assert.deepEqual(pickFrames(f, 1, 2500).map((x) => x.at), [6000]);
  assert.deepEqual(pickFrames([], 3, 2500), []);
});

// ───────────────────────── memo ─────────────────────────

test("memo request: frames as images, labelled lines, strict JSON schema; parse tolerates junk", () => {
  const req = buildMemoRequest({
    companion: { name: "Jin", traits: ["dry humor"] },
    source: "Safari",
    memo: [{ at: 0, text: "A cooking show." }],
    lines: [{ at: 1, label: "A", text: "Did you feed the ceiling?" }],
    names: new Map([["A", "the woman"]]),
    frames: ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"],
    blank: false,
  });
  const content = (req.input as { content: { type: string; text?: string }[] }[])[0].content;
  assert.equal(content.filter((c) => c.type === "input_image").length, 2);
  assert.match(content[0].text!, /the woman \(voice A\): "Did you feed the ceiling\?"/);
  assert.match(content[0].text!, /Memo so far:\n- A cooking show\./);
  assert.equal((req.text as { format: { strict: boolean } }).format.strict, true);
  assert.equal(req.effort, "minimal");

  const blank = buildMemoRequest({ companion: { name: "Jin", traits: [] }, source: null, memo: [], lines: [], names: new Map(), frames: ["x"], blank: true });
  const bc = (blank.input as { content: { type: string }[] }[])[0].content;
  assert.equal(bc.filter((c) => c.type === "input_image").length, 0);

  assert.deepEqual(parseMemoVerdict('```json\n{"memo":"Pancake hits the ceiling.","moment":"funny","reaction":"He fed the ceiling!","speakers":[{"label":"voice A","name":"the woman"}]}\n```'), {
    memo: "Pancake hits the ceiling.",
    moment: "funny",
    reaction: "He fed the ceiling!",
    speakers: [{ label: "A", name: "the woman" }],
  });
  assert.equal(parseMemoVerdict("no json"), null);
  assert.equal(parseMemoVerdict('{"memo":"x","moment":"lol","reaction":"","speakers":[]}')!.moment, "none");
});

test("question context: black screen sends no frames and says it can't see", () => {
  const base = { source: "Netflix", memo: [], lines: [], names: new Map<string, string>(), frames: ["f1"] };
  const black = buildQuestionContext({ ...base, blank: true });
  assert.deepEqual(black.images, []);
  assert.match(black.instructions, /black.*can't see it/s);
  const ok = buildQuestionContext({ ...base, blank: false });
  assert.deepEqual(ok.images, ["f1"]);
  assert.match(ok.instructions, /\(Netflix\)/);
});

// ───────────────────────── controller ─────────────────────────

class FakeAsr extends EventEmitter {
  isOpen = false;
  mode: string | undefined;
  audio = 0;
  async connect() {
    this.isOpen = true;
  }
  sendAudio(pcm: Buffer) {
    this.audio += pcm.length;
  }
  end() {
    this.isOpen = false;
  }
  fire(e: AsrEvent) {
    this.emit("event", e);
  }
}

class FakeSink implements WatchSink {
  events: WatchServerEvent[] = [];
  closed: [number, string] | null = null;
  send(ev: WatchServerEvent) {
    assert.deepEqual(checkWatchEvent(ev as unknown as Record<string, unknown>), [], JSON.stringify(ev));
    this.events.push(ev);
  }
  close(code: number, reason: string) {
    this.closed = [code, reason];
  }
}

function controller(verdicts: string[], hostOpts: { quiet?: boolean } = {}, extra: Partial<WatchDeps> = {}) {
  let t = 0;
  const asr = new FakeAsr();
  const sparkCalls: SparkRequest[] = [];
  const reacted: string[] = [];
  const host: WatchHost = {
    companion: () => ({ name: "Jin", traits: ["warm"] }),
    conversationQuiet: () => hostOpts.quiet ?? true,
    react: (script) => {
      reacted.push(script);
      return reacted.length;
    },
  };
  const c = new WatchController(host, {
    now: () => t,
    openAsr: (mode) => {
      asr.mode = mode;
      return asr;
    },
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      sparkCalls.push(req);
      const text = verdicts.shift() ?? '{"memo":"","moment":"none","reaction":"","speakers":[]}';
      yield { type: "text", delta: text };
      yield { type: "done", responseId: null, text, status: "completed" };
    },
    manualTick: true,
    ...extra,
  });
  const sink = new FakeSink();
  c.attach(sink);
  return { c, asr, sink, sparkCalls, reacted, at: (ms: number) => (t = ms) };
}

const frame = "data:image/jpeg;base64,/9j/AAAA";

test("watch: start opens a DIARIZATION transcriber; audio only flows while sharing", () => {
  const { c, asr, sink } = controller([]);
  c.onAudio(Buffer.alloc(100));
  assert.equal(asr.audio, 0);
  c.onMessage({ type: "start", source: "Safari" });
  assert.equal(asr.mode, "DIARIZATION");
  c.onAudio(Buffer.alloc(100));
  assert.equal(asr.audio, 100);
  assert.deepEqual(sink.events.at(-1), { type: "state", sharing: true, blank: false, source: "Safari" });
});

test("watch: memo after a line → funny moment → one reaction, then the 30 s gap holds", async () => {
  const funny = '{"memo":"Pancake stuck to the ceiling.","moment":"funny","reaction":"He fed the ceiling!","speakers":[{"label":"A","name":"the woman"}]}';
  const { c, asr, sink, reacted, sparkCalls, at } = controller([funny, funny]);
  c.onMessage({ type: "start", source: "YouTube" });
  at(7_000);
  c.onMessage({ type: "frame", image: frame });
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "speaker", label: "A" });
  asr.fire({ type: "speechEnd", turnId: 0 });
  at(8_000);
  asr.fire({ type: "speechComplete", turnId: 0, text: "Did you just feed the ceiling again?" });
  at(9_000);
  c.tick(); // line + 2 s since start ≥ memoAfterLine? (start at 0 → 9 s) → memo
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sparkCalls.length, 1);
  assert.deepEqual(reacted, ["<laugh> [laughs] He fed the ceiling!"]);
  assert.deepEqual(sink.events.find((e) => e.type === "reaction"), { type: "reaction", utteranceId: 1, moment: "funny" });
  // the question context now carries the memo, the named line and the frame
  const q = c.questionContext()!;
  assert.match(q.instructions, /Pancake stuck to the ceiling/);
  assert.match(q.instructions, /the woman \(voice A\): "Did you just feed the ceiling again\?"/);
  assert.deepEqual(q.images, [frame]);
  // 10 s later another funny verdict: blocked by the 30 s gap
  at(21_000);
  c.onMessage({ type: "frame", image: frame + "B" });
  c.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sparkCalls.length, 2);
  assert.equal(reacted.length, 1);
  assert.equal(c.stats.blocked.gap, 1);
});

test("watch: no reaction while the user or companion is talking", async () => {
  const funny = '{"memo":"x","moment":"funny","reaction":"ha","speakers":[]}';
  const { c, reacted, at } = controller([funny], { quiet: false });
  c.onMessage({ type: "start" });
  at(13_000);
  c.onMessage({ type: "frame", image: frame });
  c.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(reacted, []);
  assert.equal(c.stats.blocked.conversation, 1);
});

test("watch: black screen → state blank, spoken once, no frames to Spark", async () => {
  const { c, sink, reacted, at } = controller([]);
  c.onMessage({ type: "start", source: "Netflix" });
  at(1000);
  c.onMessage({ type: "frame", image: frame, blank: true });
  assert.deepEqual(sink.events.at(-1), { type: "state", sharing: true, blank: true, source: "Netflix" });
  c.tick();
  c.tick();
  assert.equal(reacted.length, 1);
  assert.match(reacted[0], /shows up black to me/);
  const q = c.questionContext()!;
  assert.deepEqual(q.images, []);
  assert.match(q.instructions, /can't see it/);
});

test("watch: speaker chip only once two voices alternate; off after 3 s of quiet", async () => {
  const { c, asr, sink } = controller([]);
  c.onMessage({ type: "start" });
  const line = (label: string, text: string) => {
    asr.fire({ type: "speechStart", turnId: 0 });
    asr.fire({ type: "speaker", label });
    asr.fire({ type: "speechEnd", turnId: 0 });
    asr.fire({ type: "speechComplete", turnId: 0, text });
  };
  line("A", "Checkmate, finally.");
  assert.equal(sink.events.filter((e) => e.type === "speaker").length, 0);
  line("B", "Best of three then.");
  assert.deepEqual(sink.events.at(-1), { type: "speaker", on: true, label: "B", name: "Voice B" });
  await new Promise((r) => setTimeout(r, 3100));
  assert.deepEqual(sink.events.at(-1), { type: "speaker", on: false });
});

test("watch D40: reactions off → a funny verdict speaks nothing; speaker chip off → no chip with two voices", async () => {
  const funny = '{"memo":"Pancake stuck to the ceiling.","moment":"funny","reaction":"He fed the ceiling!","speakers":[]}';
  const { c, asr, sink, reacted, sparkCalls, at } = controller([funny], {}, { reactions: false, speakerChip: false });
  c.onMessage({ type: "start", source: "YouTube" });
  const line = (label: string, text: string) => {
    asr.fire({ type: "speechStart", turnId: 0 });
    asr.fire({ type: "speaker", label });
    asr.fire({ type: "speechEnd", turnId: 0 });
    asr.fire({ type: "speechComplete", turnId: 0, text });
  };
  line("A", "Checkmate, finally.");
  line("B", "Best of three then.");
  at(9_000);
  c.onMessage({ type: "frame", image: frame });
  c.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sparkCalls.length, 1, "the memo still runs, so a question can use it");
  assert.deepEqual(reacted, []);
  assert.equal(sink.events.filter((e) => e.type === "reaction" || e.type === "speaker").length, 0);
  assert.match(c.questionContext()!.instructions, /Pancake stuck to the ceiling/);
});

test("watch: echo check waits for the video's open line, then compares", async () => {
  const { c, asr } = controller([]);
  c.onMessage({ type: "start" });
  asr.fire({ type: "speechStart", turnId: 0 });
  const pending = c.isEcho("Not tonight love");
  setTimeout(() => asr.fire({ type: "speechComplete", turnId: 0, text: "Not tonight, love." }), 20);
  assert.equal(await pending, true);
  assert.equal(await c.isEcho("what bus number was that"), false);
});

test("watch: stop drops frames, closes the transcriber and keeps only the memo", async () => {
  const { c, asr, at } = controller(['{"memo":"A chess game in a park.","moment":"none","reaction":"","speakers":[]}']);
  c.onMessage({ type: "start" });
  at(13_000);
  c.onMessage({ type: "frame", image: frame });
  c.tick();
  await new Promise((r) => setTimeout(r, 5));
  c.onMessage({ type: "stop" });
  assert.equal(asr.isOpen, false);
  const q = c.questionContext()!;
  assert.deepEqual(q.images, []);
  assert.match(q.instructions, /chess game/);
});

// ───────────────────────── turn machine + session ─────────────────────────

test("turn machine: a watch reaction (self_speak) starts a scripted reply only when idle", () => {
  const cfg = { bargeInMinMs: 400, bargeInMinWords: 2 };
  const idle = initialTurnState();
  const r = reduceTurn(idle, { type: "self_speak", text: "<laugh> ha", origin: "watch" }, cfg);
  assert.deepEqual(r.effects[0], { type: "start_reply", text: "<laugh> ha", utteranceId: 1, self: "watch" });
  assert.equal(reduceTurn({ ...idle, userSpeaking: true }, { type: "self_speak", text: "x", origin: "watch" }, cfg).effects.length, 0);
  assert.equal(reduceTurn({ ...idle, phase: "speaking" }, { type: "self_speak", text: "x", origin: "watch" }, cfg).effects.length, 0);
});

const config: Config = {
  metaKey: "x",
  host: "127.0.0.1",
  port: 0,
  sessionToken: null,
  defaultVoiceId: "voice",
  webSearch: false,
  asrLanguages: ["English"],
  bargeInMinMs: 400,
  bargeInMinWords: 2,
  maxSessions: 4,
  maxSessionMs: 60_000,
  sparkFirstTokenTimeoutMs: 8000,
  sparkHedge: 1,
  speculate: false,
  speculateStableMs: 250,  // #157: these session tests exercise server-voice frames
  serverTts: true,
};

class Client implements ClientSink {
  json: Record<string, unknown>[] = [];
  sendJson(m: Record<string, unknown>) {
    assert.deepEqual(checkServerEvent(m), [], JSON.stringify(m));
    this.json.push(m);
  }
  sendBinary() {}
  close() {}
}

function session() {
  const asrs: FakeAsr[] = [];
  const sparkCalls: SparkRequest[] = [];
  const tts: { text: string; emotion: string | null | undefined }[] = [];
  const deps: SessionDeps = {
    config,
    openAsr: (_l, mode) => {
      const a = new FakeAsr();
      a.mode = mode;
      asrs.push(a);
      return a;
    },
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      sparkCalls.push(req);
      yield { type: "text", delta: "<neutral> It's yellow." };
      yield { type: "done", responseId: null, text: "", status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      tts.push({ text: req.text, emotion: req.emotion });
      yield { audio: Buffer.alloc(960), alignment: null, model: req.model };
    },
  };
  const client = new Client();
  const s = new Session("s1", client, deps);
  return { s, client, asrs, sparkCalls, tts };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("session: a question while sharing carries the watch context and frames; a reaction speaks with emotion laugh", async () => {
  const { s, client, asrs, sparkCalls, tts } = session();
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" } }));
  const sink = new FakeSink();
  const watch = s.attachWatch(sink)!;
  watch.onMessage({ type: "start", source: "YouTube" });
  assert.equal(asrs[1].mode, "DIARIZATION");
  watch.onMessage({ type: "frame", image: frame });
  asrs[0].fire({ type: "speechStart", turnId: 0 });
  asrs[0].fire({ type: "speechEnd", turnId: 0 });
  asrs[0].fire({ type: "speechComplete", turnId: 0, text: "What color is his apron?" });
  await wait(30);
  assert.equal(sparkCalls.length, 1);
  assert.match(sparkCalls[0].instructions!, /watching their shared screen together \(YouTube\)/);
  const content = (sparkCalls[0].input as { role: string; content: unknown }[]).at(-1)!.content as { type: string }[];
  assert.equal(content.filter((c) => c.type === "input_image").length, 1);
  await s.onClientText(JSON.stringify({ type: "playback_done", utteranceId: 1 }));
  await wait(5);

  // scripted reaction: no Spark call, TTS gets the [laughs] tag, app gets speaking.emotion laugh
  const host = (watch as unknown as { host: WatchHost }).host;
  const id = host.react("<laugh> [laughs] He fed the ceiling!");
  assert.equal(id, 2);
  await wait(30);
  assert.equal(sparkCalls.length, 1);
  assert.deepEqual(tts.at(-1), { text: "[laughs] He fed the ceiling!", emotion: "laugh" });
  assert.ok(client.json.some((m) => m.type === "speaking" && m.on === true && m.emotion === "laugh" && m.utteranceId === 2));
  const reply = client.json.find((m) => m.type === "reply" && m.utteranceId === 2)!;
  assert.equal(reply.text, "He fed the ceiling!");
  s.close();
});

test("session: by default first reactions are on and the speaker chip is off (D40 + Chelsea 11/2 21:10)", async () => {
  const prev = [process.env.GENITA_WATCH_REACTIONS, process.env.GENITA_WATCH_SPEAKER];
  delete process.env.GENITA_WATCH_REACTIONS; delete process.env.GENITA_WATCH_SPEAKER;
  try {
    const { s } = session();
    await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" } }));
    const watch = s.attachWatch(new FakeSink())!;
    const deps = (watch as unknown as { deps: WatchDeps }).deps;
    assert.equal(deps.reactions, true);
    assert.equal(deps.speakerChip, false);
    s.close();
  } finally {
    if (prev[0] !== undefined) process.env.GENITA_WATCH_REACTIONS = prev[0];
    if (prev[1] !== undefined) process.env.GENITA_WATCH_SPEAKER = prev[1];
  }
});

test("session: the video's line leaking into the mic is dropped, not answered", async () => {
  const { s, asrs, sparkCalls } = session();
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" } }));
  const watch = s.attachWatch(new FakeSink())!;
  watch.onMessage({ type: "start" });
  const video = asrs[1];
  const mic = asrs[0];
  video.fire({ type: "speechStart", turnId: 0 });
  mic.fire({ type: "speechStart", turnId: 0 });
  mic.fire({ type: "speechEnd", turnId: 0 });
  mic.fire({ type: "speechComplete", turnId: 0, text: "Extra spicy as requested good luck" });
  setTimeout(() => video.fire({ type: "speechComplete", turnId: 0, text: "Extra spicy, as requested. Good luck." }), 10);
  await wait(60);
  assert.equal(sparkCalls.length, 0);
  // a real question still goes through
  mic.fire({ type: "speechStart", turnId: 1 });
  mic.fire({ type: "speechComplete", turnId: 1, text: "Who ordered the taco?" });
  await wait(30);
  assert.equal(sparkCalls.length, 1);
  s.close();
});

test("session: watch socket before start is refused; session close closes the watch", async () => {
  const { s } = session();
  assert.equal(s.attachWatch(new FakeSink()), null);
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" } }));
  const sink = new FakeSink();
  s.attachWatch(sink)!.onMessage({ type: "start" });
  s.close();
  assert.deepEqual(sink.closed, [1000, "session closed"]);
});

test("session: while sharing, one final transcript per utterance — the interpret command wins over the echo filter, echoes send none", async () => {
  const { s, client, asrs, sparkCalls } = session();
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" } }));
  const watch = s.attachWatch(new FakeSink())!;
  watch.onMessage({ type: "start" });
  const mic = asrs[0];
  const finals = () => client.json.filter((m) => m.type === "transcript" && m.final === true);

  // a real question: one transcript, one Spark call
  mic.fire({ type: "speechStart", turnId: 0 });
  mic.fire({ type: "speechComplete", turnId: 0, text: "Who ordered the taco?" });
  await wait(30);
  assert.equal(finals().length, 1);
  assert.equal(sparkCalls.length, 1);

  // the voice command while sharing: checked before the echo filter, one transcript, no chat turn
  mic.fire({ type: "speechStart", turnId: 1 });
  mic.fire({ type: "speechComplete", turnId: 1, text: "Can you interpret for me?" });
  await wait(30);
  assert.equal(finals().length, 2, "exactly one more final transcript");
  assert.ok(client.json.some((m) => m.type === "mode.changed" && m.mode === "interpret" && m.by === "model"));
  assert.equal(sparkCalls.filter((r) => JSON.stringify(r.input).includes("interpret for me")).length, 0, "not answered as a chat turn");
  s.close();
});

test("session: a question waiting on the echo check is dropped if interpretation starts meanwhile; questions keep their order", async () => {
  const { s, client, asrs, sparkCalls } = session();
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" } }));
  const watch = s.attachWatch(new FakeSink())!;
  watch.onMessage({ type: "start" });
  const video = asrs[1];
  const mic = asrs[0];
  // the video is talking: echo checks wait for its line
  video.fire({ type: "speechStart", turnId: 0 });
  mic.fire({ type: "speechStart", turnId: 0 });
  mic.fire({ type: "speechComplete", turnId: 0, text: "Who ordered the taco?" });
  mic.fire({ type: "speechStart", turnId: 1 });
  mic.fire({ type: "speechComplete", turnId: 1, text: "And the burrito?" });
  setTimeout(() => video.fire({ type: "speechComplete", turnId: 0, text: "Two tacos for table nine." }), 20);
  await wait(80);
  const finals = client.json.filter((m) => m.type === "transcript" && m.final === true).map((m) => m.text);
  assert.deepEqual(finals, ["Who ordered the taco?", "And the burrito?"], "in the order they were said");

  // now: a question waits on the echo check, then the interpret command arrives
  const before = sparkCalls.length;
  video.fire({ type: "speechStart", turnId: 1 });
  mic.fire({ type: "speechStart", turnId: 2 });
  mic.fire({ type: "speechComplete", turnId: 2, text: "What did she just say?" });
  mic.fire({ type: "speechStart", turnId: 3 });
  mic.fire({ type: "speechComplete", turnId: 3, text: "Can you interpret for me?" });
  setTimeout(() => video.fire({ type: "speechComplete", turnId: 1, text: "Nothing at all." }), 20);
  await wait(80);
  assert.ok(!sparkCalls.slice(before).some((r) => JSON.stringify(r.input).includes("What did she just say")), "no chat reply after interpretation started");
  s.close();
});

test("session: self speech (watch reaction / card line) never feeds memory extraction", async () => {
  const { InMemoryMemoryRepository } = await import("../src/memory/repository.ts");
  const { MemoryService } = await import("../src/memory/service.ts");
  const repo = new InMemoryMemoryRepository();
  const seen: { user: string; assistant: string }[] = [];
  const memory = new MemoryService({ repository: repo, state: repo, extract: async (turns) => { seen.push(...turns); return []; } });
  const { s, tts } = session();
  (s as unknown as { deps: SessionDeps }).deps.memory = memory;
  (s as unknown as { deps: SessionDeps }).deps.userId = "u1";
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mic: false }));
  for (let i = 0; i < 4; i++) {
    (s as unknown as { announce(t: string): void }).announce(`Found card ${i}.`);
    await wait(400); // each line plays out (20 ms of audio + the server's 250 ms playback slack)
  }
  assert.ok(tts.filter((x) => x.text.startsWith("Found card")).length >= 4, "the card lines were spoken");
  s.close();
  await memory.drain();
  assert.ok(!seen.some((t) => t.user.startsWith("Found card")), "a card line is not something the user said");
});

// ───────────────────────── realtime screen answers (11/3) ─────────────────────────

test("realtime: echoNow decides from the video's partial line without waiting when it can", async () => {
  const { echoNow } = await import("../src/watch/rules.ts");
  assert.equal(echoNow("Oh, it's Karina!", "and the night is young we dance until the morning"), "user");
  assert.equal(echoNow("dance until the morning", "and the night is young we dance until the morning"), "echo");
  assert.equal(echoNow("Oh, it's Karina!", "and"), "wait", "a partial too short to tell still waits");
  assert.equal(echoNow("Oh, it's Karina!", ""), "wait");
  assert.equal(echoNow("wow", "anything at all here"), "user");
});

test("realtime: a user line over the video's singing is answered without the 1.5 s echo wait", async () => {
  const { c, asr } = controller([]);
  c.onMessage({ type: "start", source: "YouTube" });
  asr.fire({ type: "speechStart", turnId: 0 });
  asr.fire({ type: "partial", text: "and the night is young we dance until the morning comes" });
  const t0 = performance.now();
  assert.equal(await c.isEcho("Oh, it's Karina!"), false);
  assert.ok(performance.now() - t0 < 100, "no wait for the video's line to finish");
  // the video's own words in the mic are still dropped, also at once
  assert.equal(await c.isEcho("we dance until the morning"), true);
});

test("realtime: a turn gets the newest frame last plus one ~2 s older, and the naming rule", () => {
  const { c, at } = controller([]);
  c.onMessage({ type: "start", source: "YouTube" });
  for (let s = 1; s <= 10; s++) {
    at(s * 1000);
    c.onMessage({ type: "frame", image: `data:image/jpeg;base64,f${s}` });
  }
  const q = c.questionContext()!;
  assert.deepEqual(q.images, ["data:image/jpeg;base64,f8", "data:image/jpeg;base64,f10"], "2 frames, the screen right now last");
  assert.match(q.instructions, /the last one is the screen right now/);
  assert.match(q.instructions, /use the name they gave/);
  assert.match(q.instructions, /Never say who anyone is from their face/);
  assert.match(q.instructions, /what they're wearing/);
});

test("realtime: the scene memo refreshes every 5 s while the screen changes (was 12 s)", async () => {
  const { c, at, sparkCalls } = controller([]);
  c.onMessage({ type: "start", source: "YouTube" });
  at(4_000);
  c.onMessage({ type: "frame", image: frame });
  c.tick();
  assert.equal(sparkCalls.length, 0);
  at(5_000);
  c.tick();
  await wait(5);
  assert.equal(sparkCalls.length, 1);
  at(8_000);
  c.onMessage({ type: "frame", image: frame });
  c.tick();
  await wait(5);
  assert.equal(sparkCalls.length, 1, "not before 5 s since the last memo");
  at(10_000);
  c.tick();
  await wait(5);
  assert.equal(sparkCalls.length, 2);
});

test("realtime: black screen keeps no naming rule and no frames", () => {
  const black = buildQuestionContext({ source: "Netflix", memo: [], lines: [], names: new Map(), frames: ["f1"], blank: true });
  assert.doesNotMatch(black.instructions, /name they gave/);
  assert.deepEqual(black.images, []);
});
