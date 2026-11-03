/**
 * Meta voice service (D3, SeamlessM4T v2 on Modal): config, text → spoken form, clause sizing,
 * the HTTP client (NDJSON, filler cache, fail-fast after a failure).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type VoiceConfig } from "../src/config.ts";
import { normalizeEnglish, normalizeKorean, numberToWords, pauseAfterMs, sinoKorean } from "../src/voice/normalize.ts";
import { SentenceSplitter } from "../src/text/sentences.ts";
import { createSeamless, resolveSpeaker, seamlessLang, speedFor } from "../src/tts/seamless.ts";
import { defaultDeps } from "../src/server.ts";

// ---------- config ----------
test("config: no GENITA_VOICE_URL → no voice, device mode (judges run with only a Meta key)", () => {
  const c = loadConfig({ MODEL_API_KEY: "k" });
  assert.equal(c.voice, null);
  assert.equal(c.serverTts, false);
});

test("config: GENITA_VOICE_URL + token → server voice on, Meta voice enabled", () => {
  const c = loadConfig({
    MODEL_API_KEY: "k",
    GENITA_VOICE_URL: "https://voice.example/",
    GENITA_VOICE_TOKEN: "t",
    GENITA_VOICE_SPEAKERS: "human:12, animal:7,character:300,bogus:1",
  });
  assert.equal(c.serverTts, true);
  assert.equal(c.voice?.url, "https://voice.example");
  assert.deepEqual(c.voice?.speakers, { human: 12, animal: 7, character: 0 }, "out-of-range id keeps the default");
  assert.equal(c.voice?.model, "seamless");
  assert.equal(c.voice?.timeoutMs, 4000);
});

test("config: GENITA_VOICE_URL without a token throws (misconfigured deploy fails its health check)", () => {
  assert.throws(() => loadConfig({ MODEL_API_KEY: "k", GENITA_VOICE_URL: "https://v" }), /GENITA_VOICE_TOKEN/);
});

test("server deps: with a voice service, the TTS dep calls it and exposes prefetch", async () => {
  const c = loadConfig({ MODEL_API_KEY: "k", GENITA_VOICE_URL: "http://127.0.0.1:9", GENITA_VOICE_TOKEN: "t", GENITA_VOICE_TIMEOUT_MS: "300" });
  const deps = defaultDeps(c, () => {});
  assert.equal(typeof deps.voicePrefetch, "function");
  await assert.rejects(async () => {
    for await (const _ of deps.tts({ voiceId: "seamless:0", text: "Hello there.", emotion: null, model: "x" })) void _;
  }, /voice/);
});

// ---------- normalisation ----------
test("normalize (en): numbers, money, percent, times, ordinals, years", () => {
  assert.equal(numberToWords(1234), "one thousand two hundred thirty-four");
  assert.equal(normalizeEnglish("It's $12.50 for 2 people."), "It's twelve dollars fifty for two people.");
  assert.equal(normalizeEnglish("Meet at 3:30pm or 7 PM."), "Meet at three thirty P.M. or seven P.M.");
  assert.equal(normalizeEnglish("About 40% off, the 3rd one."), "About forty percent off, the third one.");
  assert.equal(normalizeEnglish("Since 1998, and 2024."), "Since nineteen ninety-eight, and twenty twenty-four.");
  assert.equal(normalizeEnglish("Takes 15 mins at 10:05."), "Takes fifteen minutes at ten oh five.");
});

test("normalize (en): drops markdown, emojis, URLs, tags; parentheses become pauses", () => {
  assert.equal(normalizeEnglish("<happy> **Yes!** 😂 see https://x.com/a (the blue one)."), "Yes! see, the blue one.");
  assert.equal(normalizeEnglish("- milk\n- eggs"), "milk, eggs");
  assert.equal(normalizeEnglish("Dr. Kim vs. me — e.g. tonight"), "Doctor Kim versus me, for example tonight");
});

test("normalize (ko): Sino-Korean numbers, native before counters, times", () => {
  assert.equal(sinoKorean(15000), "만 오천");
  assert.equal(normalizeKorean("사과 3개랑 2명이요"), "사과 세 개랑 두 명이요");
  assert.equal(normalizeKorean("15,000원이에요"), "만 오천원이에요");
  assert.equal(normalizeKorean("3:30에 만나요"), "세시 삼십분에 만나요");
  assert.equal(normalizeKorean("20살"), "스무 살");
});

test("pauses: longer after ? and ..., short after a comma", () => {
  assert.ok(pauseAfterMs("Really?") > pauseAfterMs("Okay."));
  assert.ok(pauseAfterMs("Okay.") > pauseAfterMs("Oh wow,"));
  assert.ok(pauseAfterMs("Well...") > pauseAfterMs("Really?"));
});

// ---------- clause sizing ----------
test("splitter (eagerFirstClause): the first clause goes at its first comma, after a tag", () => {
  const s = new SentenceSplitter({ eagerFirstClause: true });
  assert.deepEqual(s.push("<happy> Oh wow"), []);
  assert.deepEqual(s.push(", you're back"), ["<happy> Oh wow,"]);
  assert.deepEqual(s.push(" already, huh? How"), ["you're back already, huh?"], "only the first piece is cut at a comma");
  assert.deepEqual(s.flush(), ["How"]);
});

test("splitter (eagerFirstClause): a sentence end before any comma wins; decimals don't cut", () => {
  const s = new SentenceSplitter({ eagerFirstClause: true });
  assert.deepEqual(s.push("Hi. Oh, wow"), ["Hi."]);
  const d = new SentenceSplitter({ eagerFirstClause: true });
  assert.deepEqual(d.push("It costs 3,000 won"), []);
});

test("splitter (clauseMaxChars): a long later sentence is cut at a comma before the limit", () => {
  const s = new SentenceSplitter({ clauseMaxChars: 60 });
  s.push("Sure. ");
  const long = "So I was thinking we could grab the green onions first, then swing by the market for the tofu and kimchi tonight";
  assert.deepEqual(s.push(long), ["So I was thinking we could grab the green onions first,"]);
});

// ---------- client ----------
const cfg: VoiceConfig = { url: "https://voice.test", token: "secret", speakers: { human: 3, animal: 5, character: 9 }, speed: 1, timeoutMs: 500, model: "seamless" };

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l) + "\n").join(""), { status: 200 });
}
const pcm = (n: number) => Buffer.alloc(n * 2, 1).toString("base64");

test("client: sends spoken text, lang, speaker, pause; yields PCM + character alignment", async () => {
  const calls: { url: string; auth: string; body: Record<string, unknown> }[] = [];
  const v = createSeamless(cfg, {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) });
      return ndjson([
        { audio_base64: pcm(2400), alignment: { characters: ["H", "i"], character_start_times_seconds: [0, 0.05], character_end_times_seconds: [0.05, 0.1] } },
        { audio_base64: pcm(1200), alignment: null },
        { done: true, gen_ms: 70 },
      ]);
    }) as typeof fetch,
  });
  const chunks = [];
  for await (const c of v.speak({ voiceId: "seamless:3", text: "<happy> It's $5, okay?", emotion: "happy", model: "x", lang: "en-US" })) chunks.push(c);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://voice.test/v1/tts");
  assert.equal(calls[0].auth, "Bearer secret");
  assert.deepEqual(calls[0].body, { text: "It's five dollars, okay?", lang: "eng", speaker: 3, speed: 1.05, tail_ms: 200, model: "seamless" });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].audio.length, 4800);
  assert.deepEqual(chunks[0].alignment, { chars: ["H", "i"], startsSec: [0, 0.05], endsSec: [0.05, 0.1] });
  assert.equal(chunks[0].model, "seamless-m4t-v2");
});

test("client: Korean sentences go out as kor (interpretation uses the same service)", async () => {
  let body: Record<string, unknown> = {};
  const v = createSeamless(cfg, { fetch: (async (_u: string, init: RequestInit) => ((body = JSON.parse(String(init.body))), ndjson([{ audio_base64: pcm(10) }, { done: true }]))) as typeof fetch });
  for await (const _ of v.speak({ voiceId: "seamless:3", text: "사과 2개 있어요.", emotion: null, model: "x", lang: "ko-KR" })) void _;
  assert.equal(body.lang, "kor");
  assert.equal(body.text, "사과 두 개 있어요.");
  assert.equal(seamlessLang(undefined, "안녕하세요 hi"), "kor");
  assert.equal(seamlessLang("en-US", "hello"), "eng");
});

test("client: short clauses are cached per speaker (second 'Hmm,' makes no request)", async () => {
  let n = 0;
  const v = createSeamless(cfg, { fetch: (async () => (n++, ndjson([{ audio_base64: pcm(100) }, { done: true }]))) as typeof fetch });
  const say = async (voiceId: string) => {
    const out = [];
    for await (const c of v.speak({ voiceId, text: "Hmm,", emotion: null, model: "x" })) out.push(c);
    return out;
  };
  assert.equal((await say("seamless:3")).length, 1);
  assert.equal((await say("seamless:3")).length, 1);
  assert.equal(n, 1, "cached");
  await say("seamless:4");
  assert.equal(n, 2, "other speaker = other voice");
});

test("client: after a failure it fails fast for 30 s without calling the service, then retries", async () => {
  let n = 0;
  let t = 1000;
  const v = createSeamless(cfg, { now: () => t, fetch: (async () => (n++, new Response("boom", { status: 503 }))) as typeof fetch });
  const run = async () => {
    for await (const _ of v.speak({ voiceId: "seamless:3", text: "Hello there, friend.", emotion: null, model: "x" })) void _;
  };
  await assert.rejects(run, /voice 503/);
  assert.equal(v.isDown(), true);
  await assert.rejects(run, /voice_down/);
  assert.equal(n, 1, "no request while down");
  t += 30_001;
  await assert.rejects(run, /voice 503/);
  assert.equal(n, 2);
});

test("client: a stalled service times out (no first byte within timeoutMs)", async () => {
  const v = createSeamless({ ...cfg, timeoutMs: 50 }, {
    fetch: ((_u: string, init: RequestInit) =>
      new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch,
  });
  const t0 = Date.now();
  await assert.rejects(async () => {
    for await (const _ of v.speak({ voiceId: "seamless:3", text: "Hello there.", emotion: null, model: "x" })) void _;
  }, /voice/);
  assert.ok(Date.now() - t0 < 1000);
});

test("client: emoji-only text makes no request", async () => {
  let n = 0;
  const v = createSeamless(cfg, { fetch: (async () => (n++, ndjson([{ done: true }]))) as typeof fetch });
  for await (const _ of v.speak({ voiceId: "seamless:3", text: "😂😂", emotion: null, model: "x" })) void _;
  assert.equal(n, 0);
});

test("speaker: seamless:<n> or <n> picks that speaker; anything else → the kind's default", () => {
  assert.equal(resolveSpeaker("seamless:42", "human", cfg), 42);
  assert.equal(resolveSpeaker("17", "human", cfg), 17);
  assert.equal(resolveSpeaker("legacy-voice", "animal", cfg), 5);
  assert.equal(resolveSpeaker(undefined, "character", cfg), 9);
  assert.equal(resolveSpeaker("seamless:250", "human", cfg), 3);
});

test("client: a body that stalls after the headers still times out (idle timeout per chunk)", async () => {
  const v = createSeamless({ ...cfg, timeoutMs: 60 }, {
    fetch: (async (_u: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify({ audio_base64: pcm(10), alignment: null }) + "\n"));
          init.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch,
  });
  const t0 = Date.now();
  await assert.rejects(async () => {
    for await (const _ of v.speak({ voiceId: "seamless:3", text: "Hello there.", emotion: null, model: "x" })) void _;
  }, /voice/);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.equal(v.isDown(), true);
});

test("client: a 400 (bad input) fails that sentence but does not take the voice down for everyone", async () => {
  let n = 0;
  const v = createSeamless(cfg, { fetch: (async () => (n++, new Response('{"error":"bad_request"}', { status: 400 }))) as typeof fetch });
  const run = async () => {
    for await (const _ of v.speak({ voiceId: "seamless:3", text: "Hello there, friend.", emotion: null, model: "x" })) void _;
  };
  await assert.rejects(run, /voice 400/);
  assert.equal(v.isDown(), false);
  await assert.rejects(run, /voice 400/);
  assert.equal(n, 2);
});

test("client: text that grows past the service limit after normalisation is sent in pieces, pause only on the last", async () => {
  const bodies: Record<string, unknown>[] = [];
  const v = createSeamless(cfg, { fetch: (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), ndjson([{ audio_base64: pcm(10) }, { done: true }]))) as typeof fetch });
  const text = "Prices: 1234567, 2345678, 3456789, 4567890, 5678901, 6789012, 7890123 and 8901234 dollars.";
  for await (const _ of v.speak({ voiceId: "seamless:3", text, emotion: null, model: "x" })) void _;
  assert.ok(bodies.length >= 2, `pieces: ${bodies.length}`);
  assert.ok(bodies.every((b) => String(b.text).length <= 380));
  assert.deepEqual(bodies.map((b) => b.tail_ms).slice(0, -1).every((t) => t === 0), true);
  assert.equal(bodies.at(-1)!.tail_ms, 170);
});

// ---------- word + phoneme timing (MMS forced aligner on the voice GPU) ----------
const TIMING = { words: [{ w: "Hi", s: 40, e: 180 }], phonemes: [{ p: "HH", s: 40, e: 90 }, { p: "IH", s: 90, e: 180 }] };

test("config: GENITA_VOICE_ALIGN=1 turns timing on; off by default", () => {
  const base = { MODEL_API_KEY: "k", GENITA_VOICE_URL: "https://v", GENITA_VOICE_TOKEN: "t" };
  assert.equal(loadConfig(base).voice?.align, false);
  assert.equal(loadConfig({ ...base, GENITA_VOICE_ALIGN: "1" }).voice?.align, true);
});

test("client (align on): asks for align, the timing line becomes a timing-only chunk after the audio", async () => {
  let body: Record<string, unknown> = {};
  const v = createSeamless({ ...cfg, align: true }, {
    fetch: (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return ndjson([{ audio_base64: pcm(2400), alignment: null }, { timing: TIMING }, { done: true, align_ms: 14 }]);
    }) as typeof fetch,
  });
  const chunks = [];
  for await (const c of v.speak({ voiceId: "seamless:3", text: "Hi.", emotion: null, model: "x" })) chunks.push(c);
  assert.equal(body.align, true);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].timing, undefined);
  assert.equal(chunks[1].audio.length, 0);
  assert.equal(chunks[1].alignment, null);
  assert.deepEqual(chunks[1].timing, TIMING);
});

test("client (align off): no align field in the request (old body, byte for byte)", async () => {
  let body: Record<string, unknown> = {};
  const v = createSeamless(cfg, { fetch: (async (_u: string, init: RequestInit) => ((body = JSON.parse(String(init.body))), ndjson([{ audio_base64: pcm(10) }, { done: true }]))) as typeof fetch });
  for await (const _ of v.speak({ voiceId: "seamless:3", text: "Hi.", emotion: null, model: "x" })) void _;
  assert.equal("align" in body, false);
});

test("client: a malformed timing line is dropped (the app falls back), the audio still plays", async () => {
  const bad = [
    { timing: { words: "x", phonemes: [] } },
    { timing: { words: [{ w: "Hi", s: "a", e: 3 }], phonemes: [] } },
    { timing: { words: [], phonemes: [{ p: 7, s: 0, e: 3 }] } },
    { timing: { words: [{ w: "Hi", s: 50, e: 40 }], phonemes: [] } },
    { timing: null },
  ];
  for (const line of bad) {
    const v = createSeamless({ ...cfg, align: true }, { fetch: (async () => ndjson([{ audio_base64: pcm(10) }, line, { done: true }])) as typeof fetch });
    const chunks = [];
    for await (const c of v.speak({ voiceId: "seamless:3", text: "Hi.", emotion: null, model: "x" })) chunks.push(c);
    assert.equal(chunks.length, 1, JSON.stringify(line));
    assert.equal(chunks[0].timing, undefined);
  }
});

test("client: timing of a later piece is shifted onto the sentence's timeline", async () => {
  let n = 0;
  const v = createSeamless({ ...cfg, align: true }, {
    fetch: (async () => (n++, ndjson([{ audio_base64: pcm(24000) }, { timing: TIMING }, { done: true }]))) as typeof fetch,
  });
  const text = "Prices: 1234567, 2345678, 3456789, 4567890, 5678901, 6789012, 7890123 and 8901234 dollars.";
  const timings = [];
  for await (const c of v.speak({ voiceId: "seamless:3", text, emotion: null, model: "x" })) if (c.timing) timings.push(c.timing);
  assert.ok(n >= 2);
  assert.deepEqual(timings[0], TIMING);
  assert.equal(timings[1].words[0].s, 1040, "second piece starts after the first piece's 1 s of audio");
  assert.equal(timings[1].phonemes[1].e, 1180);
});

// 11/3 tone pass: texting slang is said as words (Seamless spelled "ngl" / "rn"), captions keep the written form
test("normalize: texting slang is spoken as words; RN / FR in caps and words containing them are left alone", () => {
  assert.equal(normalizeEnglish("Haha okay, ngl the cat leaving is the best part."), "Haha okay, not gonna lie the cat leaving is the best part.");
  assert.equal(normalizeEnglish("tbh you deserve it, go rn"), "to be honest you deserve it, go right now");
  assert.equal(normalizeEnglish("lol idk, fr"), "haha I don't know, for real");
  assert.equal(normalizeEnglish("omg btw imo that's iconic"), "oh my god by the way in my opinion that's iconic");
  assert.equal(normalizeEnglish("She's an RN in FR."), "She's an RN in FR.");
  assert.equal(normalizeEnglish("Turn left at the frontier, then burn it."), "Turn left at the frontier, then burn it.");
});

test("pauses: casual gaps — a comma barely stops, a sentence end is shorter than before, '...' still the longest", () => {
  assert.ok(pauseAfterMs("Wait,") <= 60);
  assert.ok(pauseAfterMs("No way.") <= 180);
  assert.ok(pauseAfterMs("Hmm...") > pauseAfterMs("Really?"));
  assert.ok(pauseAfterMs("Really?") > pauseAfterMs("Okay."));
});

test("speedFor: the reply's emotion sets the rate (excited quicker, sad slower); short filler clauses keep the base rate", () => {
  const long = "you actually made the soup?";
  assert.equal(speedFor(1, "excited", long), 1.1);
  assert.equal(speedFor(1, "sad", long), 0.94);
  assert.equal(speedFor(1, "warm", long), 1);
  assert.equal(speedFor(1, null, long), 1);
  assert.equal(speedFor(1, "excited", "Oh wow,"), 1, "≤ 14 chars: the prefetched filler cache still hits");
  assert.equal(speedFor(1.3, "excited", long), 1.3, "clamped to the config's range");
});

test("client: an excited clause is requested at the faster rate and cached apart from the base rate", async () => {
  const bodies: Record<string, unknown>[] = [];
  const v = createSeamless(cfg, {
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return ndjson([{ audio_base64: pcm(240), alignment: null }, { done: true }]);
    }) as typeof fetch,
  });
  for (const emotion of ["excited", "sad"]) for await (const _ of v.speak({ voiceId: "seamless:3", text: "you actually made the soup?", emotion, model: "x", lang: "en" })) void _;
  assert.deepEqual(bodies.map((b) => b.speed), [1.1, 0.94]);
});
