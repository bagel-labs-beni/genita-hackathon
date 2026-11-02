import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import { checkServerEvent, encodeFrameHeader, CLIENT_FRAME_KIND_CALL, CLIENT_FRAME_KIND_MIC } from "../src/protocol.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";
import { containment, detectLanguage, interpretCommand } from "../src/interpret/language.ts";
import { buildTranslateInstructions } from "../src/interpret/prompt.ts";

const config: Config = {
  metaKey: "x",
  host: "127.0.0.1",
  port: 0,
  sessionToken: null,
  defaultVoiceId: "voice",
  webSearch: false,
  asrLanguages: ["English", "Korean"],
  bargeInMinMs: 400,
  bargeInMinWords: 2,
  maxSessions: 4,
  maxSessionMs: 60_000,
  sparkFirstTokenTimeoutMs: 8000,
  sparkHedge: 1,
  speculate: false,
  speculateStableMs: 250,
  // #157: these interpretation tests exercise server-voice frames
  serverTts: true,
};

class FakeAsr extends EventEmitter {
  isOpen = false;
  chunks: Buffer[] = [];
  async connect() {
    this.isOpen = true;
  }
  sendAudio(pcm: Buffer) {
    this.chunks.push(pcm);
  }
  end() {
    this.isOpen = false;
  }
  fire(e: AsrEvent) {
    this.emit("event", e);
  }
  turn(text: string) {
    this.fire({ type: "speechStart", turnId: 1 });
    this.fire({ type: "partial", text });
    this.fire({ type: "speechEnd", turnId: 1 });
    this.fire({ type: "speechComplete", turnId: 1, text });
  }
}

type Json = Record<string, unknown>;

class FakeClient implements ClientSink {
  json: Json[] = [];
  bin: Buffer[] = [];
  sendJson(m: Json) {
    assert.deepEqual(checkServerEvent(m), [], JSON.stringify(m));
    this.json.push(m);
  }
  sendBinary(b: Buffer) {
    this.bin.push(b);
  }
  close() {}
  of(type: string) {
    return this.json.filter((m) => m.type === type);
  }
  bubbles(status?: string) {
    return this.of("interpret.bubble").filter((b) => !status || b.status === status);
  }
  waitFor(pred: (m: Json) => boolean, ms = 2000): Promise<Json> {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const hit = this.json.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return reject(new Error(`timeout; got ${this.json.map((m) => m.type).join(",")}`));
        setTimeout(tick, 2);
      };
      tick();
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TRANSLATIONS: Record<string, string> = {
  "혹시 이 근처에 약국 있어요?": "Is there a pharmacy near here?",
  "Yes, two blocks down, next to the bakery.": "네, 두 블록 내려가면 빵집 옆에 있어요.",
  "이거 얼마예요?": "How much is this?",
  "다음 주 화요일 회의 괜찮으세요?": "Does next Tuesday's meeting work for you?",
  "Tuesday works. Can we do 3 pm?": "화요일 좋아요. 오후 3시 괜찮을까요?",
};

function setup(opts: { speculate?: boolean; sparkDelayMs?: number } = {}) {
  const asrs: FakeAsr[] = [];
  const client = new FakeClient();
  const sparkCalls: SparkRequest[] = [];
  const ttsCalls: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const deps: SessionDeps = {
    config: { ...config, speculate: opts.speculate ?? false },
    openAsr: () => {
      const a = new FakeAsr();
      asrs.push(a);
      return a;
    },
    async *spark(req, { signal }): AsyncGenerator<SparkStreamEvent> {
      sparkCalls.push(req);
      const input = String(req.input);
      const text = TRANSLATIONS[input] ?? `T(${input})`;
      await sleep(opts.sparkDelayMs ?? 1);
      for (const piece of text.match(/.{1,6}/gsu) ?? []) {
        if (signal?.aborted) return;
        await sleep(1);
        yield { type: "text", delta: piece };
      }
      yield { type: "done", responseId: "r", text, status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      ttsCalls.push(req.text);
      for (let i = 0; i < 2; i++) {
        await sleep(1);
        if (req.signal?.aborted) return;
        yield { audio: Buffer.alloc(960), alignment: { chars: ["a"], startsSec: [0], endsSec: [0.01] }, model: req.model };
      }
    },
    log: (event, data) => logs.push({ event, data }),
  };
  const session = new Session("s", client, deps);
  return { asrs, client, session, sparkCalls, ttsCalls, logs, mic: () => asrs[0], call: () => asrs[1] };
}

const persona = { name: "Jin", kind: "human" };
const startInterpret = (s: Session, extra: Json = {}) => s.onClientText(JSON.stringify({ type: "start", persona, mode: "interpret", ...extra }));

// ───────────────────────── pure parts ─────────────────────────

test("detectLanguage: script decides, mixed Korean still Korean, too little text is unclear", () => {
  assert.equal(detectLanguage("혹시 이 근처에 약국 있어요?"), "Korean");
  assert.equal(detectLanguage("음 그거 good idea 같아"), "Korean");
  assert.equal(detectLanguage("Is there a pharmacy near here?"), "English");
  assert.equal(detectLanguage("I had 김치 for lunch today with my friends"), "English");
  assert.equal(detectLanguage("これはいくらですか"), "Japanese");
  assert.equal(detectLanguage("这个多少钱"), "Chinese");
  assert.equal(detectLanguage("…"), null);
  assert.equal(detectLanguage("15,000"), null);
  assert.equal(detectLanguage("a"), null);
});

test("containment catches Genita's own line coming back through the mic, not a new sentence", () => {
  assert.ok(containment("Is there a pharmacy near here", "Is there a pharmacy near here?") > 0.9);
  assert.ok(containment("네 두블록 내려가면 빵집 옆에 있어요", "네, 두 블록 내려가면 빵집 옆에 있어요.") > 0.9);
  assert.ok(containment("이거 얼마예요?", "네, 두 블록 내려가면 빵집 옆에 있어요.") < 0.3);
});

test("interpretCommand: start and stop phrases only", () => {
  assert.equal(interpretCommand("Can you interpret for me?"), "start");
  assert.equal(interpretCommand("Could you translate this conversation?"), "start");
  assert.equal(interpretCommand("Start interpreting"), "start");
  assert.equal(interpretCommand("Stop interpreting."), "stop");
  assert.equal(interpretCommand("I want to learn how to interpret dreams."), null);
  assert.equal(interpretCommand("What does this word translate to?"), null);
});

test("translate instructions: only the translation, Korean target stays polite", () => {
  const ko = buildTranslateInstructions("English", "Korean");
  assert.match(ko, /from English into natural spoken Korean/);
  assert.match(ko, /Never answer, explain, advise/);
  assert.match(ko, /존댓말/);
  assert.doesNotMatch(buildTranslateInstructions("Korean", "English"), /존댓말/);
});

// ───────────────────────── face to face ─────────────────────────

test("INT-1→3: the first other language sets the pair; their Korean becomes an English bubble spoken aloud", async () => {
  const { client, session, mic, sparkCalls } = setup();
  await startInterpret(session);
  assert.equal(client.json[0].type, "ready");
  assert.deepEqual(client.of("interpret.pair")[0], { type: "interpret.pair", user: "English", other: null, source: "face", by: "auto" });
  mic().turn("혹시 이 근처에 약국 있어요?");
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(client.of("interpret.pair")[1], { type: "interpret.pair", user: "English", other: "Korean", source: "face", by: "auto" });
  assert.equal(reply.text, "Is there a pharmacy near here?");
  assert.equal(reply.interpret, true);
  assert.match(String(sparkCalls[0].instructions), /from Korean into natural spoken English/);
  assert.equal(sparkCalls[0].tools, undefined);
  const hearing = client.bubbles("hearing")[0];
  assert.equal(hearing.speaker, "them");
  const done = client.bubbles("done")[0];
  assert.deepEqual(done.original, { lang: "Korean", text: "혹시 이 근처에 약국 있어요?" });
  assert.deepEqual(done.translation, { lang: "English", text: "Is there a pharmacy near here?" });
  assert.equal(done.speaker, "them");
  assert.equal(done.utteranceId, reply.utteranceId);
  assert.ok(client.bubbles("speaking").length >= 1);
  assert.ok(client.bin.length >= 2, "translation audio was sent");
  assert.ok(client.of("chat").length === 0);
  session.close();
});

test("INT-5: my English after the pair is set goes out in polite Korean; before it, nothing is relayed", async () => {
  const { client, session, mic, sparkCalls, ttsCalls } = setup();
  await startInterpret(session);
  mic().turn("Yes, two blocks down, next to the bakery.");
  await sleep(20);
  const skipped = client.bubbles("skipped")[0];
  assert.equal(skipped.reason, "no_other_language");
  assert.equal(skipped.speaker, "me");
  assert.equal(sparkCalls.length, 0);
  assert.equal(ttsCalls.length, 0);

  mic().turn("이거 얼마예요?");
  await client.waitFor((m) => m.type === "reply");
  mic().turn("Yes, two blocks down, next to the bakery.");
  await client.waitFor((m) => m.type === "reply" && m.text === "네, 두 블록 내려가면 빵집 옆에 있어요.");
  const mine = client.bubbles("done").find((b) => b.speaker === "me")!;
  assert.deepEqual(mine.translation, { lang: "Korean", text: "네, 두 블록 내려가면 빵집 옆에 있어요." });
  assert.match(String(sparkCalls.at(-1)!.instructions), /into natural spoken Korean[\s\S]*존댓말/);
  session.close();
});

test("INT-6: language unclear → bubble marked unknown, no translation, no sound", async () => {
  const { client, session, mic, sparkCalls } = setup();
  await startInterpret(session);
  mic().turn("…");
  mic().turn("15,000");
  await sleep(20);
  const unknown = client.bubbles("unknown");
  assert.equal(unknown.length, 2);
  assert.equal(unknown[0].reason, "language_unclear");
  assert.equal(unknown[0].translation, undefined);
  assert.equal(sparkCalls.length, 0);
  assert.equal(client.bin.length, 0);
  session.close();
});

test("speech never cancels a translation: two quick turns are both relayed, in order", async () => {
  const { client, session, mic } = setup({ sparkDelayMs: 15 });
  await startInterpret(session);
  mic().turn("혹시 이 근처에 약국 있어요?");
  mic().turn("이거 얼마예요?");
  await client.waitFor((m) => m.type === "reply" && m.text === "How much is this?");
  assert.equal(client.of("utterance.cancelled").length, 0);
  const replies = client.of("reply").map((r) => r.text);
  assert.deepEqual(replies, ["Is there a pharmacy near here?", "How much is this?"]);
  // audio of the first utterance is all sent before the second one's
  const audioUtts = client.of("audio").map((a) => a.utteranceId as number);
  assert.deepEqual(audioUtts, [...audioUtts].sort((a, b) => a - b));
  session.close();
});

test("echo guard: Genita's own translation heard back through the mic is dropped", async () => {
  const { client, session, mic, sparkCalls } = setup();
  await startInterpret(session);
  mic().turn("혹시 이 근처에 약국 있어요?");
  await client.waitFor((m) => m.type === "reply");
  mic().turn("Is there a pharmacy near here");
  await sleep(20);
  assert.equal(sparkCalls.length, 1);
  // no bubble ever shows the echo (partials are filtered too)
  assert.ok(!client.bubbles().some((b) => (b.original as Json).text === "Is there a pharmacy near here"));
  session.close();
});

test("INT-4 hold to talk: a held turn is mine even if it is not clearly English", async () => {
  const { client, session, mic } = setup();
  await startInterpret(session, { interpret: { other: "Korean" } });
  assert.equal(client.of("interpret.pair")[0].by, "client");
  await session.onClientText(JSON.stringify({ type: "hold", on: true }));
  mic().fire({ type: "partial", text: "Yes two blocks" });
  await session.onClientText(JSON.stringify({ type: "hold", on: false }));
  mic().fire({ type: "speechComplete", turnId: 2, text: "Yes, two blocks down, next to the bakery." });
  await client.waitFor((m) => m.type === "reply");
  const b = client.bubbles("done")[0];
  assert.equal(b.speaker, "me");
  assert.equal(b.via, "hold");
  assert.equal(client.bubbles("hearing")[0].via, "hold");
  // the hold is over: the next English turn is by language again
  mic().turn("혹시 이 근처에 약국 있어요?");
  await client.waitFor((m) => m.type === "reply" && m.text === "Is there a pharmacy near here?");
  assert.equal(client.bubbles("done").at(-1)!.speaker, "them");
  session.close();
});

test("a hold with nothing said does not make the next utterance mine", async () => {
  const { client, session, mic } = setup();
  await startInterpret(session, { interpret: { other: "Korean" } });
  await session.onClientText(JSON.stringify({ type: "hold", on: true }));
  await session.onClientText(JSON.stringify({ type: "hold", on: false }));
  mic().turn("이거 얼마예요?");
  await client.waitFor((m) => m.type === "reply");
  const b = client.bubbles("done")[0];
  assert.equal(b.speaker, "them");
  assert.equal(b.via, "voice");
  session.close();
});

test("typed text while interpreting is mine and goes out in the other language", async () => {
  const { client, session } = setup();
  await startInterpret(session, { interpret: { other: "Korean" } });
  await session.onClientText(JSON.stringify({ type: "text", text: "Tuesday works. Can we do 3 pm?" }));
  await client.waitFor((m) => m.type === "reply");
  const b = client.bubbles("done")[0];
  assert.equal(b.via, "text");
  assert.equal((b.translation as Json).text, "화요일 좋아요. 오후 3시 괜찮을까요?");
  session.close();
});

test("barge_in tap cancels the translation playing and the ones queued", async () => {
  const { client, session, mic } = setup({ sparkDelayMs: 30 });
  await startInterpret(session);
  mic().turn("혹시 이 근처에 약국 있어요?");
  mic().turn("이거 얼마예요?");
  await sleep(5);
  await session.onClientText(JSON.stringify({ type: "barge_in" }));
  await sleep(80);
  assert.equal(client.of("utterance.cancelled").length, 2);
  assert.equal(client.of("reply").length, 0);
  assert.equal(client.bubbles("cancelled").length, 2);
  assert.ok(client.of("state").some((s) => s.state === "interrupted"));
  session.close();
});

test("speculation: a punctuated partial starts the translation; the matching final reuses it and logs a reportable interpret turn", async () => {
  const { client, session, mic, sparkCalls, logs } = setup({ speculate: true });
  await startInterpret(session);
  mic().fire({ type: "speechStart", turnId: 1 });
  mic().fire({ type: "partial", text: "혹시 이 근처에 약국 있어요?" });
  await sleep(5);
  assert.equal(sparkCalls.length, 1);
  mic().fire({ type: "speechEnd", turnId: 1 });
  mic().fire({ type: "speechComplete", turnId: 1, text: "혹시 이 근처에 약국 있어요?" });
  await client.waitFor((m) => m.type === "turn.metrics");
  assert.equal(sparkCalls.length, 1);
  assert.equal(client.of("turn.metrics")[0].speculative, "hit");
  const answered = logs.find((x) => x.event === "turn.answered");
  assert.deepEqual(answered?.data.mode, "interpret");
  assert.equal(typeof answered?.data.first_audio_ms, "number");
  assert.equal(typeof answered?.data.stt_ms, "number");
  assert.equal(typeof answered?.data.llm_ms, "number");
  assert.equal(typeof answered?.data.tts_ms, "number");
  assert.equal(typeof answered?.data.utteranceId, "number");
  session.close();
});

// ───────────────────────── voice switch ─────────────────────────

test("voice: \"Can you interpret for me?\" switches to interpret and Jin confirms; \"Stop interpreting\" switches back", async () => {
  const { client, session, mic, ttsCalls, sparkCalls } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  mic().turn("Can you interpret for me?");
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(client.of("mode.changed")[0], { type: "mode.changed", mode: "interpret", by: "model" });
  assert.equal(client.of("interpret.pair").length, 1);
  assert.deepEqual(ttsCalls, ["Sure, I'll pass on what I hear."]);
  assert.equal(sparkCalls.length, 0);
  mic().turn("Stop interpreting.");
  await sleep(10);
  assert.deepEqual(client.of("mode.changed")[1], { type: "mode.changed", mode: "chat", by: "model" });
  assert.equal(sparkCalls.length, 0);
  session.close();
});

test("mode message: chat → interpret cuts a chat reply in progress", async () => {
  const { client, session, mic } = setup({ sparkDelayMs: 50 });
  await session.onClientText(JSON.stringify({ type: "start", persona }));
  mic().turn("Tell me a long story about dragons.");
  await sleep(5);
  await session.onClientText(JSON.stringify({ type: "mode", mode: "interpret" }));
  assert.equal(client.of("utterance.cancelled")[0].reason, "client");
  assert.equal(client.of("mode.changed")[0].mode, "interpret");
  session.close();
});

// ───────────────────────── Mac call ─────────────────────────

test("INT-M1/M2 call mode: call sound is 'them' on its own ASR; the mic only passes while held and is 'me'", async () => {
  const { client, session, mic, call } = setup();
  await startInterpret(session, { interpret: { source: "call", app: "FaceTime" } });
  assert.deepEqual(client.of("interpret.pair")[0], { type: "interpret.pair", user: "English", other: null, source: "call", by: "auto", app: "FaceTime" });
  assert.ok(call(), "a second ASR stream was opened for the call sound");
  const pcm = Buffer.alloc(3840, 7);
  session.onClientAudio(Buffer.concat([encodeFrameHeader(CLIENT_FRAME_KIND_CALL, 0), pcm]));
  session.onClientAudio(Buffer.concat([encodeFrameHeader(CLIENT_FRAME_KIND_MIC, 0), pcm]));
  assert.equal(call().chunks.length, 1);
  assert.equal(call().chunks[0][0], 7);
  assert.ok(mic().chunks.at(-1)!.every((b) => b === 0), "mic is silence while not holding");

  call().turn("다음 주 화요일 회의 괜찮으세요?");
  await client.waitFor((m) => m.type === "reply");
  const them = client.bubbles("done")[0];
  assert.equal(them.speaker, "them");
  assert.equal(them.via, "call");
  assert.equal(client.of("interpret.pair").at(-1)!.other, "Korean");

  await session.onClientText(JSON.stringify({ type: "hold", on: true }));
  session.onClientAudio(Buffer.concat([encodeFrameHeader(CLIENT_FRAME_KIND_MIC, 0), pcm]));
  assert.equal(mic().chunks.at(-1)![0], 7, "held mic audio passes");
  mic().turn("Tuesday works. Can we do 3 pm?");
  await session.onClientText(JSON.stringify({ type: "hold", on: false }));
  await client.waitFor((m) => m.type === "reply" && m.text === "화요일 좋아요. 오후 3시 괜찮을까요?");
  const me = client.bubbles("done").at(-1)!;
  assert.equal(me.speaker, "me");
  assert.equal(me.via, "hold");
  // English on the call needs no translation
  call().turn("Sounds good.");
  await sleep(10);
  assert.equal(client.bubbles("skipped").at(-1)!.reason, "same_language");
  session.close();
});

test("call frames are ignored outside call mode; leaving interpret closes the call ASR", async () => {
  const { session, call, asrs } = setup();
  await startInterpret(session, { interpret: { source: "call" } });
  await session.onClientText(JSON.stringify({ type: "mode", mode: "chat" }));
  assert.equal(call().isOpen, false);
  session.onClientAudio(Buffer.concat([encodeFrameHeader(CLIENT_FRAME_KIND_CALL, 0), Buffer.alloc(320)]));
  assert.equal(asrs.length, 2, "no new call ASR in chat mode");
  session.close();
});
