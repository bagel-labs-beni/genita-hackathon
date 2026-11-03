/**
 * Server voice from the Meta voice service (D3, Seamless on Modal): audio + timing frames as
 * in server TTS mode, the voice is a Seamless speaker per companion kind, sentences carry their
 * language (interpretation: kor/eng), and a failing voice service hands the rest of the reply to
 * the app's own voice (`say`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, deviceSpeechEstimateMs, type ClientSink } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import { checkServerEvent } from "../src/protocol.ts";
import type { AsrEvent } from "../src/meta/transcribe.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";

const config: Config = {
  metaKey: "x",
  serverTts: false,
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
};

class FakeAsr extends EventEmitter {
  isOpen = false;
  async connect() {
    this.isOpen = true;
  }
  sendAudio() {}
  end() {
    this.isOpen = false;
  }
  fire(e: AsrEvent) {
    this.emit("event", e);
  }
}

class FakeClient implements ClientSink {
  json: Record<string, unknown>[] = [];
  bin: Buffer[] = [];
  sendJson(m: Record<string, unknown>) {
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
  waitFor(pred: (m: Record<string, unknown>) => boolean, ms = 3000): Promise<Record<string, unknown>> {
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
const persona = { name: "Companion", kind: "animal", traits: ["warm"] };
const voice = { url: "https://v", token: "t", speakers: { human: 3, animal: 5, character: 9 }, speed: 1, timeoutMs: 500, model: "seamless" as const };

type TtsReq = { voiceId: string; text: string; lang?: string; signal?: AbortSignal };

type Timing = NonNullable<TtsChunk["timing"]>;

function setup(opts: { sparkText?: string; failAt?: number; chunkDelayMs?: number; timing?: (text: string) => Timing | null; timingDelayMs?: number; companionVoiceId?: () => Promise<string | null | undefined> } = {}) {
  const asr = new FakeAsr();
  const client = new FakeClient();
  const calls: TtsReq[] = [];
  const prefetched: number[] = [];
  const session = new Session("v1", client, {
    config: { ...config, serverTts: true, voice },
    openAsr: () => asr,
    async *spark(_req, { signal }): AsyncGenerator<SparkStreamEvent> {
      const text = opts.sparkText ?? "<happy> Oh wow, you're back! How was it?";
      for (const piece of text.match(/.{1,6}/gs) ?? []) {
        if (signal?.aborted) return;
        await sleep(1);
        yield { type: "text", delta: piece };
      }
      yield { type: "done", responseId: "r1", text, status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      const i = calls.push(req) - 1;
      if (opts.failAt !== undefined && i >= opts.failAt) throw new Error("voice 503: down");
      await sleep(opts.chunkDelayMs ?? 1);
      if (req.signal?.aborted) return;
      yield { audio: Buffer.alloc(4800), alignment: { chars: [...req.text], startsSec: [...req.text].map((_, k) => k * 0.02), endsSec: [...req.text].map((_, k) => k * 0.02 + 0.02) }, model: "seamless-m4t-v2" };
      const timing = opts.timing?.(req.text);
      if (timing) {
        await sleep(opts.timingDelayMs ?? 0);
        if (req.signal?.aborted) return;
        yield { audio: Buffer.alloc(0), alignment: null, model: "seamless-m4t-v2", timing };
      }
    },
    voicePrefetch: (s) => prefetched.push(s),
    companionVoiceId: opts.companionVoiceId,
  });
  return { asr, client, session, calls, prefetched };
}

test("voice service: ready.tts server, voice = the kind's Seamless speaker, fillers prefetched", async () => {
  const { client, session, prefetched } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  const ready = client.of("ready")[0];
  assert.equal(ready.tts, "server");
  assert.equal(ready.voiceId, "seamless:5", "animal default");
  assert.deepEqual(prefetched, [5]);
  session.close();
});

test("voice service: start.voiceId seamless:<n> picks that speaker; unrecognized voice ids map to the kind default", async () => {
  const a = setup();
  await a.session.onClientText(JSON.stringify({ type: "start", persona, voiceId: "seamless:42", mic: false }));
  assert.equal(a.client.of("ready")[0].voiceId, "seamless:42");
  a.session.close();
  const b = setup();
  await b.session.onClientText(JSON.stringify({ type: "start", persona: { ...persona, kind: "human", voice: { id: "legacy-voice" } }, mic: false }));
  assert.equal(b.client.of("ready")[0].voiceId, "seamless:3");
  b.session.close();
});

test("voice service: first clause is cut at its comma; audio frames + words timing; no say", async () => {
  const { client, session, calls } = setup();
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "back" }));
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(calls.map((c) => c.text), ["Oh wow,", "you're back!", "How was it?"]);
  assert.ok(calls.every((c) => c.voiceId === "seamless:5" && c.lang === "en-US"));
  const audio = client.of("audio");
  assert.equal(audio.length, 3);
  assert.equal(client.bin.length, 3);
  assert.deepEqual(audio.map((a) => a.offsetMs), [0, 100, 200], "each clause continues the reply timeline");
  assert.ok((audio[0].words as unknown[]).length > 0, "word timing for the mouth engine");
  assert.equal(client.of("say").length, 0);
  assert.equal(client.of("turn.metrics")[0].ttsModel, "seamless-m4t-v2");
  session.close();
});

test("voice service: Korean (interpretation) sentences carry ko-KR so the service speaks kor", async () => {
  const { client, session, calls } = setup({ sparkText: "<neutral> 네, 바로 저 모퉁이 돌면 있어요." });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "where?" }));
  await client.waitFor((m) => m.type === "reply");
  assert.ok(calls.length >= 1 && calls.every((c) => c.lang === "ko-KR"), JSON.stringify(calls.map((c) => c.lang)));
  session.close();
});

test("voice service down mid-reply: tts_unavailable once, the rest goes to the app as say, nothing lost", async () => {
  const { client, session, calls } = setup({ failAt: 1 });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "back" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Oh wow, you're back! How was it?");
  assert.equal(client.of("audio").length, 1, "first clause was voiced");
  assert.equal(client.of("error").filter((e) => e.code === "tts_unavailable").length, 1);
  assert.deepEqual(client.of("say").map((s) => s.text), ["you're back!", "How was it?"]);
  assert.equal(calls.length, 2, "no more service calls after the failure in this reply");
  assert.equal(client.of("turn.metrics")[0].ttsModel, "seamless-m4t-v2+device");
  session.close();
});

test("voice service down from the start: every sentence becomes say, first_audio fires on the first", async () => {
  const { client, session } = setup({ failAt: 0 });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "back" }));
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(client.of("say").map((s) => s.text), ["Oh wow,", "you're back!", "How was it?"]);
  assert.ok(client.json.some((m) => m.type === "state" && m.state === "speaking"));
  assert.equal(client.of("turn.metrics")[0].ttsModel, "device");
  session.close();
});

test("greeting logs call.greeted and tts.first_audio exactly once", async () => {
  const { client, session } = setup();
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  (session as unknown as { deps: { log: (event: string, data: Record<string, unknown>) => void } }).deps.log = (event, data) => logs.push({ event, data });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  (session as unknown as { greeting: unknown }).greeting = { item: null };
  await session.onClientText(JSON.stringify({ type: "text", text: "The call just connected. Greet the user." }));
  await client.waitFor((m) => m.type === "reply");
  assert.equal(logs.filter((x) => x.event === "tts.first_audio").length, 1);
  assert.equal(logs.filter((x) => x.event === "call.greeted").length, 1);
  assert.equal(logs.find((x) => x.event === "call.greeted")?.data.sessionId, "v1");
  session.close();
});

test("voice service: barge-in stops the stream; no audio frame after utterance.cancelled", async () => {
  const { client, session, calls } = setup({ chunkDelayMs: 40, sparkText: "<happy> Oh wow, that is a long story. Tell me everything. Start from the top." });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "story" }));
  await client.waitFor((m) => m.type === "audio");
  await session.onClientText(JSON.stringify({ type: "barge_in" }));
  const cancelled = await client.waitFor((m) => m.type === "utterance.cancelled");
  const binBefore = client.bin.length;
  await sleep(200);
  const after = client.json.slice(client.json.indexOf(cancelled));
  assert.equal(after.filter((m) => m.type === "audio" || m.type === "say").length, 0);
  assert.equal(client.bin.length, binBefore, "no binary after cancel");
  assert.ok(calls.some((c) => c.signal?.aborted), "the in-flight voice request was aborted");
  session.close();
});

test("voice service: when the opener guard drops a whole first clause ('Oh,'), the next clause starts with a capital", async () => {
  const { client, session } = setup({ sparkText: "<happy> Oh, perfect cozy night! Want a comedy?" });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false, history: [{ role: "assistant", text: "Oh, hi there." }] }));
  await session.onClientText(JSON.stringify({ type: "text", text: "movie?" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Perfect cozy night! Want a comedy?");
  session.close();
});

test("voice service fails mid-sentence: the unspoken words of that sentence go to say", async () => {
  const asr = new FakeAsr();
  const client = new FakeClient();
  const session = new Session("v2", client, {
    config: { ...config, serverTts: true, voice },
    openAsr: () => asr,
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      yield { type: "text", delta: "<happy> We should totally get noodles tonight. Okay?" };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      if (req.text.startsWith("Okay")) throw new Error("voice 503");
      const said = "We should totally ";
      yield { audio: Buffer.alloc(4800), alignment: { chars: [...said], startsSec: [...said].map((_, k) => k * 0.02), endsSec: [...said].map((_, k) => k * 0.02 + 0.02) }, model: "seamless-m4t-v2" };
      throw new Error("voice network: reset");
    },
  });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "dinner?" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "We should totally get noodles tonight. Okay?");
  assert.deepEqual(client.of("say").map((s) => s.text), ["get noodles tonight.", "Okay?"]);
  session.close();
});

function midFail(text: string, voiced: string | null) {
  const client = new FakeClient();
  const session = new Session("v3", client, {
    config: { ...config, serverTts: true, voice },
    openAsr: () => new FakeAsr(),
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      yield { type: "text", delta: text };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts(): AsyncGenerator<TtsChunk> {
      const a = voiced === null ? null : { chars: [...voiced], startsSec: [...voiced].map(() => 0), endsSec: [...voiced].map(() => 0) };
      yield { audio: Buffer.alloc(4800), alignment: a, model: "seamless-m4t-v2" };
      throw new Error("voice network: reset");
    },
  });
  return { client, session };
}

test("mid-sentence failure counts voiced words in the spoken form ('$123' = 4 words), so nothing is lost", async () => {
  const { client, session } = midFail("<neutral> Pay $123 now and leave.", "Pay one hundred twenty-three dollars ");
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "x" }));
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(client.of("say").map((s) => s.text), ["now and leave."]);
  session.close();
});

test("mid-sentence failure without timing (MMS backup) says the whole sentence again rather than drop it", async () => {
  const { client, session } = midFail("<neutral> We should get noodles tonight.", null);
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "x" }));
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(client.of("say").map((s) => s.text), ["We should get noodles tonight."]);
  session.close();
});

// ---------- word + phoneme timing follow-up (MMS forced aligner) ----------
const timingFor = (text: string): Timing => ({
  words: text.split(" ").map((w, k) => ({ w, s: 10 + k * 30, e: 35 + k * 30 })),
  phonemes: [{ p: "OW", s: 10, e: 20 }, { p: "W", s: 20, e: 35 }],
});

test("voice timing: each clause's audio.timing follows its audio, keyed to its seq, ms on the reply timeline", async () => {
  const { client, session } = setup({ timing: timingFor });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "back" }));
  await client.waitFor((m) => m.type === "reply");
  const audio = client.of("audio");
  const timing = client.of("audio.timing");
  assert.equal(timing.length, 3);
  for (const [k, t] of timing.entries()) {
    assert.equal(t.utteranceId, audio[k].utteranceId);
    assert.equal(t.sentence, audio[k].sentence);
    assert.equal(t.seq, audio[k].seq, "keyed to the clause's first audio chunk");
    assert.ok(client.json.indexOf(t) > client.json.indexOf(audio[k]), "after its audio, never before");
  }
  // clause 2 starts at 100 ms on the reply timeline: its times are shifted by that
  assert.deepEqual((timing[1].words as { s: number }[])[0], { w: "you're", s: 110, e: 135 });
  assert.deepEqual(timing[1].phonemes, [{ p: "OW", s: 110, e: 120 }, { p: "W", s: 120, e: 135 }]);
  // the audio events are unchanged: words still come with the audio
  assert.ok((audio[0].words as unknown[]).length > 0);
  session.close();
});

test("voice timing: the first audio frame is not held for the timing", async () => {
  const { client, session } = setup({ timing: timingFor, timingDelayMs: 150 });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "back" }));
  await client.waitFor((m) => m.type === "audio");
  assert.equal(client.bin.length, 1, "first frame already out");
  assert.equal(client.of("audio.timing").length, 0, "timing still pending");
  await client.waitFor((m) => m.type === "reply", 3000);
  assert.equal(client.of("audio.timing").length, 3);
  session.close();
});

test("voice timing: no timing from the service → no audio.timing (the app falls back to loudness + text)", async () => {
  const { client, session } = setup({ timing: (t) => (t.startsWith("you") ? null : timingFor(t)) });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "back" }));
  await client.waitFor((m) => m.type === "reply");
  assert.deepEqual(client.of("audio.timing").map((t) => t.sentence), [0, 2]);
  session.close();
});

test("voice timing: nothing for a cancelled utterance", async () => {
  const { client, session } = setup({ timing: timingFor, timingDelayMs: 80, chunkDelayMs: 40, sparkText: "<happy> Oh wow, that is a long story. Tell me everything. Start from the top." });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "story" }));
  await client.waitFor((m) => m.type === "audio");
  await session.onClientText(JSON.stringify({ type: "barge_in" }));
  const cancelled = await client.waitFor((m) => m.type === "utterance.cancelled");
  await sleep(250);
  const after = client.json.slice(client.json.indexOf(cancelled));
  assert.equal(after.filter((m) => m.type === "audio.timing" && m.utteranceId === cancelled.utteranceId).length, 0);
  session.close();
});

test("same presence: the account's saved companion voice wins over each device's start, so iPhone and Mac match", async () => {
  // the iPhone sends its persona card (stale voice), the Mac sends start.voiceId; both end on the saved voice 17
  const phone = setup({ companionVoiceId: async () => "17" });
  await phone.session.onClientText(JSON.stringify({ type: "start", persona: { ...persona, kind: "human", voice: { id: "4" } }, mic: false }));
  const mac = setup({ companionVoiceId: async () => "17" });
  await mac.session.onClientText(JSON.stringify({ type: "start", persona: { ...persona, kind: "human" }, voiceId: "seamless:9", mic: false }));
  assert.equal(phone.client.of("ready")[0].voiceId, "seamless:17");
  assert.equal(mac.client.of("ready")[0].voiceId, "seamless:17");
  assert.deepEqual(mac.prefetched, [17]);
  phone.session.close(); mac.session.close();
  // first audio of a reply uses that voice too
  const s = setup({ companionVoiceId: async () => "17" });
  await s.session.onClientText(JSON.stringify({ type: "start", persona, voiceId: "seamless:2", mic: false }));
  await s.session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  await s.client.waitFor((m) => m.type === "reply");
  assert.ok(s.calls.length > 0 && s.calls.every((c) => c.voiceId === "seamless:17"), JSON.stringify(s.calls.map((c) => c.voiceId)));
  s.session.close();
});

test("same presence: no companion, a store error or a slow store keeps the client's voice", async () => {
  for (const companionVoiceId of [async () => null, async () => { throw new Error("db down"); }, () => new Promise<string>((r) => setTimeout(() => r("17"), 5_000))]) {
    const a = setup({ companionVoiceId });
    const t0 = Date.now();
    await a.session.onClientText(JSON.stringify({ type: "start", persona, voiceId: "seamless:42", mic: false }));
    assert.equal(a.client.of("ready")[0].voiceId, "seamless:42");
    assert.ok(Date.now() - t0 < 2_500, "ready is never held past the wait");
    a.session.close();
  }
});

test("same presence: a turn that starts while the voice lookup is still out keeps one voice for the whole reply (Codex P2)", async () => {
  // the lookup is slower than the user's first line: that reply and the call keep the client's voice
  const s = setup({ companionVoiceId: () => new Promise((r) => setTimeout(() => r("17"), 200)), sparkText: "<happy> One. Two. Three." });
  const started = s.session.onClientText(JSON.stringify({ type: "start", persona, voiceId: "seamless:2", mic: false }));
  await s.session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  await started;
  await s.client.waitFor((m) => m.type === "reply");
  const voices = new Set(s.calls.map((c) => c.voiceId));
  assert.deepEqual([...voices], ["seamless:2"], "never two voices in one reply");
  s.session.close();
  // looked up as the session opens: a start sent a moment later doesn't wait for it
  const q = setup({ companionVoiceId: () => new Promise((r) => setTimeout(() => r("17"), 150)) });
  await sleep(200);
  const t0 = Date.now();
  await q.session.onClientText(JSON.stringify({ type: "start", persona, voiceId: "seamless:2", mic: false }));
  assert.ok(Date.now() - t0 < 100);
  assert.equal(q.client.of("ready")[0].voiceId, "seamless:17");
  q.session.close();
});

// ---------- expression layer (11/3): one face per clause, timed on the reply's audio timeline ----------
test("expression: Spark's [smile] → one event for that clause, the tag never reaches TTS or captions; neutral clauses send nothing", async () => {
  const { client, session, calls } = setup({ timing: timingFor, sparkText: "<curious> [smile] That sounds lovely, tell me more. What did you cook?" });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "dinner" }));
  await client.waitFor((m) => m.type === "reply");
  assert.ok(calls.every((c) => !/\[|\]/.test(c.text)), `no tag in TTS: ${calls.map((c) => c.text).join(" | ")}`);
  assert.ok(!/smile/.test(String(client.of("reply")[0].text)), "no tag in the reply text");
  const ex = client.of("expression");
  assert.equal(ex.length, 1, JSON.stringify(ex));
  const audio0 = client.of("audio").find((a) => a.sentence === 0)!;
  assert.deepEqual(ex[0], { type: "expression", utteranceId: audio0.utteranceId, sentence: 0, tag: "smile", intensity: process.env.GENITA_CONVO_V1 === "0" ? 0.7 : 0.5 /* v1: a curious reply gets a soft smile (DESIGN §7.2) */, startMs: 10, endMs: 35 + 30 * (calls[0].text.split(" ").length - 1) });
  assert.ok(client.json.indexOf(ex[0]) > client.json.indexOf(audio0), "after the clause's audio");
  session.close();
});

test("expression: without aligner timing the clause's audio span is used; laugh words → laugh at 1.0", async () => {
  const { client, session } = setup({ sparkText: "<neutral> Okay then. Haha, that's so you!" });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "joke" }));
  await client.waitFor((m) => m.type === "reply");
  const ex = client.of("expression");
  assert.equal(ex.length, 1, JSON.stringify(ex));
  const audio = client.of("audio").filter((a) => a.sentence === ex[0].sentence);
  assert.equal(ex[0].tag, "laugh");
  assert.equal(ex[0].intensity, 1);
  assert.equal(ex[0].startMs, audio[0].offsetMs);
  assert.equal(ex[0].endMs, (audio.at(-1)!.offsetMs as number) + (audio.at(-1)!.durationMs as number));
  session.close();
});

test("expression: GENITA_EXPRESSION=0 (voice.expressions false) sends none; the tag is still stripped", async () => {
  const asr = new FakeAsr();
  const client = new FakeClient();
  const calls: string[] = [];
  const session = new Session("v1", client, {
    config: { ...config, serverTts: true, voice: { ...voice, expressions: false } },
    openAsr: () => asr,
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      yield { type: "text", delta: "<happy> [laugh] Ha, nice one." };
      yield { type: "done", responseId: "r1", text: "", status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      calls.push(req.text);
      yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" };
    },
  });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "joke" }));
  await client.waitFor((m) => m.type === "reply");
  assert.equal(client.of("expression").length, 0);
  assert.deepEqual(calls, ["Ha,", "nice one."]);
  session.close();
});

test("expression: a clause voiced in several service requests keeps the whole clause's word span (Codex P2)", async () => {
  const client = new FakeClient();
  const session = new Session("v1", client, {
    config: { ...config, serverTts: true, voice },
    openAsr: () => new FakeAsr(),
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      yield { type: "text", delta: "<neutral> [smile] That is a very long thought." };
      yield { type: "done", responseId: "r1", text: "", status: "completed" };
    },
    async *tts(): AsyncGenerator<TtsChunk> {
      // two pieces of one clause, each followed by its own aligner timing (ms from the clause's audio start)
      yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" };
      yield { audio: Buffer.alloc(0), alignment: null, model: "seamless-m4t-v2", timing: { words: [{ w: "That", s: 10, e: 60 }], phonemes: [] } };
      yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" };
      yield { audio: Buffer.alloc(0), alignment: null, model: "seamless-m4t-v2", timing: { words: [{ w: "thought.", s: 110, e: 180 }], phonemes: [] } };
    },
  });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "go" }));
  await client.waitFor((m) => m.type === "reply");
  const ex = client.of("expression");
  assert.equal(ex.length, 1);
  assert.deepEqual([ex[0].tag, ex[0].startMs, ex[0].endMs], ["smile", 10, 180]);
  session.close();
});
