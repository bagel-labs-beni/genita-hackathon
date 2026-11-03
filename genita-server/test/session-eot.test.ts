/**
 * CA-14 (11/4, scorecard proxy on build 7): the user says 14 words, pauses 1.5 s to think, and goes on. Muse
 * Transcribe finalized the first half ~0.7 s into the pause ("…and then he started."), the Session answered it, and
 * the reply was cut off when the user went on (5/5); the backchannel cue never played (0/5). Now a final that looks
 * unfinished is held: the cue plays inside the hold, a resumed turn is joined, and only silence commits it. A finished
 * turn is still answered at once. GENITA_EOT_HOLD=0 restores the old policy. Interpretation is untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import { loadConfig } from "../src/config.ts";
import { EOT } from "../src/convo/endOfTurn.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";

class FakeAsr extends EventEmitter {
  isOpen = false;
  async connect() { this.isOpen = true; }
  sendAudio() {}
  end() { this.isOpen = false; }
  fire(e: AsrEvent) { this.emit("event", e); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const voice = { url: "https://v", token: "t", speakers: { human: 0, animal: 0, character: 0 }, speed: 1, timeoutMs: 2000, model: "seamless" as const };

const A_PARTIAL = "So today at work my manager pulled me into this meeting and then he started";
const A_FINAL = "So today at work my manager pulled me into this meeting and then he started.";
const B_FINAL = "yelling at me about the deck in front of everyone.";

function setup(opts: { speculate?: boolean } = {}) {
  const asr = new FakeAsr();
  let clock = 10_000;
  const sent: { m: Record<string, unknown>; at: number }[] = [];
  const bins: number[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const sparkCalls: SparkRequest[] = [];
  const t0 = Date.now();
  const sink: ClientSink = {
    sendJson: (m) => sent.push({ m, at: Date.now() - t0 }),
    sendBinary: () => bins.push(Date.now() - t0),
    close() {},
  };
  const deps: SessionDeps = {
    config: { ...loadConfig({ MODEL_API_KEY: "k" }), webSearch: false, speculate: opts.speculate ?? false, sparkHedge: 1, serverTts: true, voice },
    openAsr: () => asr,
    now: () => clock + (Date.now() - t0),
    log: (event, data) => logs.push({ event, data }),
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      sparkCalls.push(req);
      await sleep(20);
      yield { type: "text", delta: "<warm> Oh no, that sounds rough." };
      yield { type: "done", responseId: null, text: "", status: "completed" };
    },
    async *tts(): AsyncGenerator<TtsChunk> {
      yield { audio: Buffer.alloc(960), alignment: null, model: "seamless-m4t-v2" };
    },
  };
  const session = new Session("eot", sink, deps);
  const types = () => sent.map((s) => (s.m.type === "state" ? `state:${s.m.state}` : String(s.m.type)));
  const at = (pred: (m: Record<string, unknown>) => boolean) => sent.filter((s) => pred(s.m)).map((s) => s.at);
  return { asr, session, sent, bins, logs, sparkCalls, types, at, advance: (ms: number) => { clock += ms; } };
}

/** part A spoken over 4 s (past the cue's 3 s floor), then Transcribe's endpoint */
async function partA(h: ReturnType<typeof setup>) {
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  await sleep(30); // the greeting (none here) and start effects settle
  h.asr.fire({ type: "speechStart", turnId: 0 });
  h.advance(4000);
  h.asr.fire({ type: "partial", text: A_PARTIAL });
  h.asr.fire({ type: "speechEnd", turnId: 0 });
  h.asr.fire({ type: "speechComplete", turnId: 0, text: A_FINAL });
}
const thinking = (m: Record<string, unknown>) => m.type === "state" && m.state === "thinking";

test("CA-14 red→green: a 1.5 s thinking pause gets the cue, no reply; the resumed turn is answered once, joined", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  const pausedAt = Date.now();
  await sleep(EOT.cueAfterMs + 150);
  assert.equal(h.sent.filter((s) => s.m.type === "backchannel").length, 1, `the cue plays in the pause: ${h.types().join(",")}`);
  // the user goes on 1.5 s after the voice stopped ≈ 0.8 s after the final (+0.45 s for Transcribe to notice)
  await sleep(Math.max(0, 1250 - (Date.now() - pausedAt)));
  assert.equal(h.at(thinking).length, 0, "no reply started during the pause");
  assert.equal(h.sparkCalls.length, 0);
  h.asr.fire({ type: "speechStart", turnId: 1 });
  h.asr.fire({ type: "partial", text: "yelling at me" });
  const bubble = h.sent.filter((s) => s.m.type === "transcript" && s.m.final === false).at(-1)!.m;
  assert.equal(bubble.text, "So today at work my manager pulled me into this meeting and then he started yelling at me", "the bubble shows the whole turn");
  await sleep(EOT.incompleteMs); // longer than the hold: a resumed turn never commits while the user talks
  assert.equal(h.at(thinking).length, 0, "no commit while the user is talking");
  h.asr.fire({ type: "speechEnd", turnId: 1 });
  h.asr.fire({ type: "speechComplete", turnId: 1, text: B_FINAL });
  await sleep(150);
  assert.equal(h.at(thinking).length, 1, h.types().join(","));
  assert.equal(h.sent.filter((s) => s.m.type === "utterance.cancelled").length, 0, "nothing was cut off");
  const finals = h.sent.filter((s) => s.m.type === "transcript" && s.m.final === true).map((s) => s.m.text);
  assert.deepEqual(finals, ["So today at work my manager pulled me into this meeting and then he started yelling at me about the deck in front of everyone."]);
  assert.equal(h.sparkCalls.length, 1);
  assert.match(JSON.stringify(h.sparkCalls[0].input), /he started yelling at me about the deck/);
  assert.equal(h.sent.filter((s) => s.m.type === "backchannel").length, 1, "one cue for the turn");
});

test("CA-14: the user resumes before the cue would fire (1.0 s pause) → no cue after they resumed, no reply until the end", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  await sleep(EOT.cueAfterMs - 150);
  h.asr.fire({ type: "speechStart", turnId: 1 });
  await sleep(600);
  assert.equal(h.sent.filter((s) => s.m.type === "backchannel").length, 0);
  assert.equal(h.at(thinking).length, 0);
  h.asr.fire({ type: "speechEnd", turnId: 1 });
  h.asr.fire({ type: "speechComplete", turnId: 1, text: B_FINAL });
  await sleep(150);
  assert.equal(h.at(thinking).length, 1);
  assert.equal(h.sent.filter((s) => s.m.type === "utterance.cancelled").length, 0);
});

test("CA-14: a held turn the user does not go on with is answered after the hold (silence commits it)", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  const heldAt = Date.now();
  await sleep(EOT.incompleteMs - 200);
  assert.equal(h.at(thinking).length, 0, "still holding");
  await sleep(400);
  assert.equal(h.at(thinking).length, 1, "committed once the hold ran out");
  const final = h.sent.find((s) => s.m.type === "transcript" && s.m.final === true)!;
  assert.equal(final.m.text, A_FINAL);
  assert.ok(Date.now() - heldAt >= EOT.incompleteMs);
  assert.ok(h.logs.some((l) => l.event === "turn.commit" && l.data.reason === "silence"));
});

test("a finished turn is still answered at once: no hold, same first-sound path as before", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  await sleep(30);
  h.asr.fire({ type: "speechStart", turnId: 0 });
  h.asr.fire({ type: "speechEnd", turnId: 0 });
  const firedAt = Date.now();
  h.asr.fire({ type: "speechComplete", turnId: 0, text: "My manager yelled at me in front of everyone." });
  assert.equal(h.at(thinking).length, 1, "thinking in the same tick as the final");
  await sleep(150);
  assert.ok(h.bins.length > 0, "the reply played");
  assert.ok(Date.now() - firedAt < 400);
  assert.ok(!h.logs.some((l) => l.event === "turn.hold"));
});

test("GENITA_EOT_HOLD=0 (rollback): the old policy — the unfinished final is answered at once", async (t) => {
  process.env.GENITA_EOT_HOLD = "0";
  const h = setup();
  t.after(() => { delete process.env.GENITA_EOT_HOLD; h.session.close(); });
  await partA(h);
  assert.equal(h.at(thinking).length, 1);
});

test("CA-14: speculation runs during the hold and is reused when the held turn commits (no added Spark wait)", async (t) => {
  const h = setup({ speculate: true });
  t.after(() => h.session.close());
  await partA(h);
  await sleep(50);
  assert.equal(h.sparkCalls.length, 1, "Spark started on the held text");
  assert.equal(h.at(thinking).length, 0, "but nothing is said before the commit");
  assert.equal(h.bins.length, 0);
  await sleep(EOT.incompleteMs + 100);
  assert.equal(h.at(thinking).length, 1);
  assert.equal(h.sparkCalls.length, 1, "the guess was used, not asked again");
  const answered = h.logs.find((l) => l.event === "turn.answered" || l.event === "turn.metrics");
  if (answered && "speculative" in answered.data) assert.equal(answered.data.speculative, "hit");
});

test("CA-14: speculation on the held text is dropped when the user resumes (0 audio frames after the resume)", async (t) => {
  const h = setup({ speculate: true });
  t.after(() => h.session.close());
  await partA(h);
  await sleep(300);
  h.asr.fire({ type: "speechStart", turnId: 1 });
  h.asr.fire({ type: "partial", text: "yelling at me" });
  await sleep(EOT.incompleteMs);
  assert.equal(h.bins.length, 0, "no audio frame before or after the resume");
  h.asr.fire({ type: "speechEnd", turnId: 1 });
  h.asr.fire({ type: "speechComplete", turnId: 1, text: B_FINAL });
  await sleep(200);
  assert.equal(h.at(thinking).length, 1);
  assert.match(JSON.stringify(h.sparkCalls.at(-1)!.input), /he started yelling at me about the deck/);
  assert.equal(h.sent.filter((s) => s.m.type === "utterance.cancelled").length, 0);
});

test("CA-14: typing during a held turn ends it as before (its reply starts and the typed line takes over)", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  await sleep(100);
  await h.session.onClientText(JSON.stringify({ type: "text", text: "Sorry, typing instead." }));
  await sleep(150);
  const finals = h.sent.filter((s) => s.m.type === "transcript" && s.m.final === true).map((s) => s.m.text);
  assert.deepEqual(finals, [A_FINAL, "Sorry, typing instead."]);
  await sleep(EOT.incompleteMs);
  assert.equal(h.sent.filter((s) => s.m.type === "reply").length, 1, "one reply (the typed line), no late held one");
});

test("CA-14: muting during a held turn answers it now", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  await sleep(100);
  await h.session.onClientText(JSON.stringify({ type: "audio_stop" }));
  assert.equal(h.at(thinking).length, 1);
});

test("CA-14: the hold never applies over a short 'yeah' while the companion talks (barge-in rule unchanged)", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, bargeIn: { minMs: 400 } }));
  await sleep(30);
  await h.session.onClientText(JSON.stringify({ type: "text", text: "Tell me something." }));
  await sleep(60); // the reply is out
  h.asr.fire({ type: "speechStart", turnId: 0 });
  h.asr.fire({ type: "speechEnd", turnId: 0 });
  h.asr.fire({ type: "speechComplete", turnId: 0, text: "and" });
  await sleep(EOT.incompleteMs + 100);
  assert.equal(h.sent.filter((s) => s.m.type === "utterance.cancelled").length, 0);
  assert.ok(!h.logs.some((l) => l.event === "turn.hold"), "a backchannel over the reply is dropped, never held");
  assert.equal(h.sent.filter((s) => s.m.type === "reply").length, 1);
});

test("CA-14: interpretation is untouched — an unfinished-looking line is relayed at once", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, mode: "interpret", interpret: { other: "Korean" } }));
  await sleep(30);
  h.asr.fire({ type: "speechStart", turnId: 0 });
  h.asr.fire({ type: "speechEnd", turnId: 0 });
  h.asr.fire({ type: "speechComplete", turnId: 0, text: "I made soup today and" });
  await sleep(100);
  assert.ok(h.sparkCalls.length >= 1, "translated right away");
  assert.ok(!h.logs.some((l) => l.event === "turn.hold"));
  assert.ok(!h.sent.some((s) => s.m.type === "backchannel"));
});

test("Codex P1: a late watch-echo verdict never restarts the commit clock while the user is talking again", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  // watch together starts sharing; its echo check is slow
  let release!: (echo: boolean) => void;
  (h.session as unknown as { watch: unknown }).watch = { isSharing: true, isEcho: () => new Promise<boolean>((r) => (release = r)), questionContext: () => null, close() {} };
  h.asr.fire({ type: "speechStart", turnId: 1 });
  h.asr.fire({ type: "speechEnd", turnId: 1 });
  h.asr.fire({ type: "speechComplete", turnId: 1, text: "Not tonight love" }); // the video's line
  await sleep(10); // the check is running
  h.asr.fire({ type: "speechStart", turnId: 2 }); // the user goes on while the check runs
  release(true);
  await sleep(EOT.incompleteMs + 200);
  assert.equal(h.at(thinking).length, 0, "no commit while the user talks");
  (h.session as unknown as { watch: unknown }).watch = null;
  h.asr.fire({ type: "speechEnd", turnId: 2 });
  h.asr.fire({ type: "speechComplete", turnId: 2, text: B_FINAL });
  await sleep(150);
  assert.equal(h.at(thinking).length, 1);
  assert.match(JSON.stringify(h.sparkCalls.at(-1)!.input), /he started yelling at me about the deck/);
});

test("Codex P2: muting after the user resumed a held turn → one joined turn once their final lands, not two", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  await sleep(100);
  h.asr.fire({ type: "speechStart", turnId: 1 });
  await h.session.onClientText(JSON.stringify({ type: "audio_stop" }));
  assert.equal(h.at(thinking).length, 0, "not yet: the resumed words are still coming");
  h.asr.fire({ type: "speechEnd", turnId: 1 });
  h.asr.fire({ type: "speechComplete", turnId: 1, text: B_FINAL });
  assert.equal(h.at(thinking).length, 1, "committed at once with the mic off");
  await sleep(100);
  const finals = h.sent.filter((s) => s.m.type === "transcript" && s.m.final === true).map((s) => s.m.text);
  assert.equal(finals.length, 1);
  assert.match(String(finals[0]), /he started yelling at me/);
  assert.equal(h.sent.filter((s) => s.m.type === "utterance.cancelled").length, 0);
});

test("Codex P2: frames typed with a line go with that line, not with the held voice turn it ends", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  await sleep(100);
  const img = `data:image/jpeg;base64,${Buffer.from("x").toString("base64")}`;
  await h.session.onClientText(JSON.stringify({ type: "text", text: "What am I wearing?", frames: [img] }));
  await sleep(200);
  const withImage = h.sparkCalls.filter((c) => JSON.stringify(c.input).includes("data:image/jpeg"));
  assert.equal(withImage.length, 1);
  assert.match(JSON.stringify(withImage[0].input), /What am I wearing/);
});

test("Codex r2: a held turn whose echo check finished after an empty later final still commits (never stuck)", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  let release!: (echo: boolean) => void;
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  await sleep(30);
  (h.session as unknown as { watch: unknown }).watch = { isSharing: true, isEcho: () => new Promise<boolean>((r) => (release = r)), questionContext: () => null, close() {} };
  h.asr.fire({ type: "speechStart", turnId: 0 });
  h.advance(4000);
  h.asr.fire({ type: "speechEnd", turnId: 0 });
  h.asr.fire({ type: "speechComplete", turnId: 0, text: A_FINAL }); // the check runs
  await sleep(10);
  h.asr.fire({ type: "speechStart", turnId: 1 });
  h.asr.fire({ type: "speechEnd", turnId: 1 });
  h.asr.fire({ type: "speechComplete", turnId: 1, text: "" }); // noise: an empty final while A's check runs
  release(false); // A is the user
  await sleep(EOT.incompleteMs + 400);
  assert.equal(h.at(thinking).length, 1, h.types().join(","));
  const finals = h.sent.filter((s) => s.m.type === "transcript" && s.m.final === true).map((s) => s.m.text);
  assert.ok(finals.includes(A_FINAL), JSON.stringify(finals));
});

test("Codex r2: resume → their speechEnd → mute → their final: still one joined turn", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  await sleep(100);
  h.asr.fire({ type: "speechStart", turnId: 1 });
  h.asr.fire({ type: "speechEnd", turnId: 1 });
  await h.session.onClientText(JSON.stringify({ type: "audio_stop" }));
  assert.equal(h.at(thinking).length, 0, "their final is still coming");
  h.asr.fire({ type: "speechComplete", turnId: 1, text: B_FINAL });
  assert.equal(h.at(thinking).length, 1);
  await sleep(100);
  const finals = h.sent.filter((s) => s.m.type === "transcript" && s.m.final === true).map((s) => s.m.text);
  assert.equal(finals.length, 1);
  assert.match(String(finals[0]), /he started yelling at me/);
  assert.equal(h.sent.filter((s) => s.m.type === "utterance.cancelled").length, 0);
});

test("CA-14 watchdog: a resumed segment whose final never comes (ASR dropped) does not hold the turn forever", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  await sleep(100);
  h.asr.fire({ type: "speechStart", turnId: 1 }); // …and the stream dies: no final
  await sleep(EOT.incompleteMs + 100);
  assert.equal(h.at(thinking).length, 0, "waiting for their final");
  h.advance(6000); // > HOLD_WATCHDOG_MS of ASR silence
  await sleep(400);
  assert.equal(h.at(thinking).length, 1, "committed by the watchdog");
});

test("Codex r3: a final that turns up after the watchdog answered is dropped — one reply, the partial kept", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  await sleep(100);
  h.asr.fire({ type: "speechStart", turnId: 1 });
  h.asr.fire({ type: "partial", text: "yelling at me" });
  h.asr.fire({ type: "speechEnd", turnId: 1 });
  await sleep(EOT.incompleteMs + 100);
  h.advance(6000); // the final is >5 s late
  await sleep(400);
  assert.equal(h.at(thinking).length, 1, "committed by the watchdog");
  assert.match(JSON.stringify(h.sparkCalls.at(-1)!.input), /he started yelling at me/, "the resumed words went with it");
  h.asr.fire({ type: "speechComplete", turnId: 1, text: "yelling at me about the deck." });
  await sleep(150);
  assert.equal(h.at(thinking).length, 1, "no second reply");
  assert.equal(h.sent.filter((s) => s.m.type === "utterance.cancelled").length, 0);
  assert.equal(h.sparkCalls.length, 1);
});

test("handover b9-6 P2: a proximity handoff drops a held turn — the device that lost the sound never answers it later", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await partA(h);
  await sleep(100);
  h.session.stopForHandoff();
  await sleep(EOT.incompleteMs + 300);
  assert.equal(h.at(thinking).length, 0, h.types().join(","));
  assert.equal(h.sparkCalls.length, 0, "no Spark call for the dropped turn");
  assert.equal(h.sent.filter((s) => s.m.type === "backchannel").length, 0, "no cue after the move");
  assert.ok(!h.sent.some((s) => s.m.type === "transcript" && s.m.final === true), "no late final for the held line");
});

test("handover b9-6 P2: a cued turn dropped as watch echo does not strip the next turn's real 'mm-hm'", async (t) => {
  const h = setup();
  t.after(() => h.session.close());
  await h.session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" } }));
  await sleep(30);
  const s = h.session as unknown as { watch: unknown; cuedTurn: boolean };
  s.watch = { isSharing: true, isEcho: async () => true, questionContext: () => null, close() {} };
  s.cuedTurn = true; // a cue played in this turn
  h.asr.fire({ type: "speechStart", turnId: 0 });
  h.asr.fire({ type: "speechEnd", turnId: 0 });
  h.asr.fire({ type: "speechComplete", turnId: 0, text: "Not tonight love." }); // the video's line → dropped
  await sleep(30);
  s.watch = null;
  h.asr.fire({ type: "speechStart", turnId: 1 });
  h.asr.fire({ type: "speechEnd", turnId: 1 });
  h.asr.fire({ type: "speechComplete", turnId: 1, text: "Mm-hm." });
  await sleep(100);
  const finals = h.sent.filter((x) => x.m.type === "transcript" && x.m.final === true).map((x) => x.m.text);
  assert.deepEqual(finals, ["Mm-hm."]);
  assert.equal(h.at(thinking).length, 1, "the user's own 'Mm-hm.' is answered");
});
