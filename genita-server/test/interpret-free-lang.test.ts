import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Interpreter, type InterpretHost } from "../src/interpret/interpreter.ts";
import { languageAnswer, languageCommand, mixedLanguages } from "../src/interpret/language.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import type { InterpretSource, ServerEvent } from "../src/protocol.ts";
import { checkServerEvent } from "../src/protocol.ts";
import { loadConfig } from "../src/config.ts";
import { Session, type ClientSink } from "../src/session/session.ts";

// Chelsea 11/4 (iPhone, face to face): "When I switch to Japanese mid-way it stays fixed to English/Korean. Let me
// switch languages freely. If it's unclear which language to translate into, ask."

type Bubble = Extract<ServerEvent, { type: "interpret.bubble" }>;
type Pair = Extract<ServerEvent, { type: "interpret.pair" }>;

async function* text(out: string, signal: AbortSignal): AsyncGenerator<SparkStreamEvent> {
  await new Promise((r) => setTimeout(r, 2));
  if (signal.aborted) return;
  yield { type: "text", delta: out };
  yield { type: "done", responseId: "r", text: out, status: "completed" };
}

/** Mocked mic → Interpreter; a translation comes back as "<to>(<input>)". */
function harness(opts: { user?: string; freeLang?: boolean; source?: InterpretSource; other?: string } = {}) {
  const sent: ServerEvent[] = [];
  const requests: SparkRequest[] = [];
  const spoken: string[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  let seq = 0;
  let utt = 0;
  const host: InterpretHost = {
    now: () => Date.now(),
    admitTurn: () => true,
    send: (e) => {
      assert.deepEqual(checkServerEvent(e as Record<string, unknown>), [], JSON.stringify(e));
      sent.push(e);
    },
    sendAudio: () => {},
    nextSeq: () => ++seq,
    nextUtteranceId: () => ++utt,
    translate: (req, signal) => {
      requests.push(req);
      const to = String(req.instructions).match(/into natural spoken (\w+)/)![1];
      return text(`${to}(${String(req.input)})`, signal);
    },
    tts: async function* () {},
    useDeviceVoice: () => true,
    say: (_u, _s, t) => spoken.push(t),
    timing: () => ({ words: [] }),
    log: (event, data) => logs.push({ event, data }),
  };
  const interp = new Interpreter(host, { userLanguage: opts.user ?? "Korean", source: opts.source ?? "face", other: opts.other, speculate: false, freeLang: opts.freeLang ?? true });
  interp.begin();
  const idle = () => !(interp as unknown as { running: unknown }).running && !(interp as unknown as { queue: unknown[] }).queue.length;
  const settle = async () => {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    while (!idle()) {
      if (Date.now() - t0 > 3000) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  /** one mic utterance, waited until everything queued has gone out */
  const say = async (t: string) => {
    interp.partial("mic", t);
    interp.speechEnd("mic");
    interp.final("mic", t);
    await settle();
  };
  const bubbles = (status?: string) => sent.filter((e): e is Bubble => e.type === "interpret.bubble" && (!status || e.status === status));
  const lastDone = () => bubbles("done").at(-1)!;
  const pairs = () => sent.filter((e): e is Pair => e.type === "interpret.pair").map((p) => `${p.user}↔${p.other}`);
  const asks = () => bubbles("done").filter((b) => b.reason === "ask_language");
  const fromTo = () => requests.map((r) => String(r.instructions).match(/from (\w+) into natural spoken (\w+)/)!.slice(1).join("→"));
  return { interp, say, sent, requests, spoken, logs, bubbles, lastDone, pairs, asks, fromTo };
}

// ───────────────────────── 1. Japanese mid-way ─────────────────────────

test("Japanese mid-way: the pair follows to Japanese, and my Korean then goes out in Japanese", async () => {
  const h = harness({ user: "Korean" });
  await h.say("Is there a pharmacy near here?");
  assert.deepEqual(h.lastDone().translation, { lang: "Korean", text: "Korean(Is there a pharmacy near here?)" }, "first line translates at once");
  await h.say("두 블록 내려가시면 있어요.");
  assert.equal(h.lastDone().translation!.lang, "English");
  await h.say("すみません、駅はどこですか。");
  assert.deepEqual(h.lastDone().original, { lang: "Japanese", text: "すみません、駅はどこですか。" });
  assert.equal(h.lastDone().translation!.lang, "Korean");
  await h.say("이쪽으로 쭉 가세요.");
  assert.deepEqual(h.lastDone().translation, { lang: "Japanese", text: "Japanese(이쪽으로 쭉 가세요.)" });
  // Han only ("電車") counts as Japanese once the pair has Japanese
  await h.say("大丈夫です");
  await h.say("電車");
  assert.equal(h.lastDone().original.lang, "Japanese");
  assert.equal(h.lastDone().translation!.lang, "Korean");
  // and back to English when English is heard again
  await h.say("Thank you so much!");
  await h.say("천만에요.");
  assert.equal(h.lastDone().translation!.lang, "English");
  assert.deepEqual(h.pairs(), ["Korean↔null", "Korean↔English", "Korean↔Japanese", "Korean↔English"], "the app's bar gets every pair change");
  assert.deepEqual(h.fromTo(), ["English→Korean", "Korean→English", "Japanese→Korean", "Korean→Japanese", "Japanese→Korean", "Japanese→Korean", "English→Korean", "Korean→English"]);
  assert.equal(h.asks().length, 0, "nothing was unclear, so no question");
});

test("kill switch (freeLang off): the old fixed pair — Japanese mid-way does not move it", async () => {
  const h = harness({ user: "Korean", freeLang: false });
  await h.say("Is there a pharmacy near here?");
  await h.say("すみません、駅はどこですか。");
  await h.say("이쪽으로 쭉 가세요.");
  assert.equal(h.lastDone().translation!.lang, "English", "fixed to the first other language heard");
  assert.deepEqual(h.pairs(), ["Korean↔null", "Korean↔English"]);
});

// ───────────────────────── 2. voice switch ─────────────────────────

test("voice switch: \"일본어로 해줘\" sets Japanese at once, no Spark call for the command, a short spoken OK", async () => {
  const h = harness({ user: "English" });
  await h.say("이거 얼마예요?");
  assert.deepEqual(h.pairs().at(-1), "English↔Korean");
  const calls = h.requests.length;
  await h.say("일본어로 해줘");
  assert.equal(h.requests.length, calls, "the command is not translated");
  assert.deepEqual(h.pairs().at(-1), "Korean↔Japanese", "said in Korean, so Korean is my side now");
  assert.equal(h.bubbles("skipped").at(-1)!.reason, "language_switch");
  assert.deepEqual(h.spoken.at(-1), "좋아요, 이제 일본어로 통역할게요.");
  await h.say("물 한 병 주세요.");
  assert.deepEqual(h.lastDone().translation, { lang: "Japanese", text: "Japanese(물 한 병 주세요.)" });
  await h.say("千円です。");
  assert.equal(h.lastDone().translation!.lang, "Korean");
});

test("voice switch in English and Japanese; a question that only mentions a language is still translated", async () => {
  const en = harness({ user: "English" });
  await en.say("translate to Japanese");
  assert.deepEqual(en.pairs().at(-1), "English↔Japanese");
  assert.deepEqual(en.spoken.at(-1), "Okay, translating into Japanese now.");
  await en.say("Where is the station?");
  assert.deepEqual(en.lastDone().translation, { lang: "Japanese", text: "Japanese(Where is the station?)" });

  const ja = harness({ user: "Korean" });
  await ja.say("안녕하세요");
  await ja.say("日本語で");
  assert.deepEqual(ja.pairs().at(-1), "Korean↔Japanese", "said in Japanese for Japanese: my side stays my language");
  await ja.say("日本語で話してもいいですか");
  assert.equal(ja.lastDone().original.text, "日本語で話してもいいですか");
  assert.equal(ja.lastDone().translation!.lang, "Korean");

  for (const t of ["translate to Japanese", "Switch to Korean, please.", "일본어로 통역해 주세요", "일본어로 바꿔줘", "日本語でお願いします", "英語に通訳して", "翻译成日语"]) assert.ok(languageCommand(t), t);
  for (const t of ["Can you speak Japanese?", "I studied Japanese in college", "일본어 공부했어요", "영어 잘하세요?", "日本語で話してもいいですか"]) assert.equal(languageCommand(t), null, t);
});

// ───────────────────────── 3. ask when unclear ─────────────────────────

test("my own language before anyone else spoke: one question in my language, then the answer's language gets the line", async () => {
  const h = harness({ user: "Korean" });
  await h.say("안녕하세요, 만나서 반갑습니다.");
  assert.equal(h.requests.length, 0, "no guess: nothing was translated");
  const ask = h.asks()[0];
  assert.ok(ask);
  assert.deepEqual(ask.original, { lang: "Korean", text: "안녕하세요, 만나서 반갑습니다." });
  assert.deepEqual(ask.translation, { lang: "Korean", text: "어떤 언어로 통역할까요?" });
  assert.deepEqual(h.spoken, ["어떤 언어로 통역할까요?"], "spoken through the normal interpreter voice path");
  await h.say("일본어요");
  assert.deepEqual(h.pairs().at(-1), "Korean↔Japanese");
  assert.deepEqual(h.fromTo(), ["Korean→Japanese"]);
  assert.deepEqual(h.lastDone().translation, { lang: "Japanese", text: "Japanese(안녕하세요, 만나서 반갑습니다.)" });
  assert.equal(h.spoken.length, 2, "the answer is not confirmed separately: the waiting line is the confirmation");
  assert.ok(h.logs.some((l) => l.event === "interpret.switch" && l.data.by === "answer"));
});

test("a line mixing in a language outside the pair asks once; the answer applies", async () => {
  const h = harness({ user: "English" });
  await h.say("혹시 이 근처에 약국 있어요?");
  await h.say("これは good idea だと思う");
  assert.equal(h.asks().length, 1);
  assert.deepEqual(h.asks()[0].translation, { lang: "English", text: "Which language should I translate into?" });
  await h.say("Japanese");
  assert.deepEqual(h.pairs().at(-1), "English↔Japanese");
  assert.deepEqual(h.fromTo().at(-1), "Japanese→English", "a Japanese line with the target Japanese goes the other way, never into itself");
  // Korean with English words inside the known pair is not unclear
  const k = harness({ user: "English" });
  await k.say("혹시 이 근처에 약국 있어요?");
  await k.say("음 그거 good idea 같아");
  assert.equal(k.asks().length, 0);
  assert.deepEqual(mixedLanguages("음 그거 good idea 같아"), ["Korean", "English"]);
});

test("an unreadable script before anything was heard asks instead of dropping it silently", async () => {
  const h = harness({ user: "English" });
  await h.say("Привет, как дела?");
  assert.equal(h.asks().length, 1);
  assert.ok(h.logs.some((l) => l.event === "interpret.ask" && l.data.why === "unclear"));
  // numbers / a single letter stay INT-6 (nothing to ask about)
  const n = harness({ user: "English" });
  await n.say("15,000");
  assert.equal(n.asks().length, 0);
  assert.equal(n.bubbles("unknown").at(-1)!.reason, "language_unclear");
});

// ───────────────────────── 4. no repeat questions ─────────────────────────

test("no repeat questions: an unanswered question is not asked again for the same pair", async () => {
  const h = harness({ user: "Korean" });
  await h.say("안녕하세요.");
  await h.say("오늘 날씨 좋네요."); // not an answer: the old English↔Korean guess, no second question
  await h.say("어디 가세요?");
  assert.equal(h.asks().length, 1);
  assert.deepEqual(h.fromTo(), ["Korean→English", "Korean→English"]);
  assert.ok(h.logs.some((l) => l.event === "interpret.ask_unanswered"));
  // a real pair change (Japanese heard) may ask once more, for a mixed line outside it — still only once
  await h.say("すみません、駅はどこですか。");
  await h.say("Hello 안녕 good morning 반가워");
  await h.say("Hello 안녕 good morning 반가워");
  assert.equal(h.asks().length, 2);
});

test("a Mac call never asks out loud (the question would go to the other person), and the app-fixed pair keeps the old rules", async () => {
  const h = harness({ user: "English", source: "call" });
  await h.say("Tuesday works.");
  assert.equal(h.asks().length, 0);
  assert.deepEqual(h.fromTo(), ["English→Korean"]);
  const fixed = harness({ user: "English", other: "Korean" });
  await fixed.say("すみません、駅はどこですか。");
  assert.deepEqual(fixed.pairs(), ["English↔Korean"]);
});

// ───────────────────────── #750 rules under the free switch ─────────────────────────

test("#750 kept: first other-language line at once, never translated into itself, profanity rule in the instructions", async () => {
  const h = harness({ user: "English" });
  await h.say("너 게이냐? 씨발놈아?");
  assert.equal(h.asks().length, 0);
  assert.deepEqual(h.fromTo(), ["Korean→English"]);
  assert.match(String(h.requests[0].instructions), /profane speech is still translated faithfully/);
  await h.say("translate to Japanese");
  await h.say("すみません");
  await h.say("Okay, see you.");
  await h.say("일본어로 해줘");
  await h.say("감사합니다");
  for (const ft of h.fromTo()) assert.notEqual(ft.split("→")[0], ft.split("→")[1], ft);
  for (const b of h.bubbles("done")) if (b.reason !== "ask_language" && b.translation) assert.notEqual(b.original.lang, b.translation.lang);
  assert.ok(languageAnswer("음 일본어요") === "Japanese" && languageAnswer("Japanese, please.") === "Japanese" && languageAnswer("일본어 공부했어요") === null);
});

// ───────────────────────── wiring ─────────────────────────

test("GENITA_INTERPRET_FREE_LANG: on by default in prod config, 0 turns it off; the session passes it to the interpreter", async () => {
  assert.equal(loadConfig({ MODEL_API_KEY: "x" }).interpretFreeLang, true);
  assert.equal(loadConfig({ MODEL_API_KEY: "x", GENITA_INTERPRET_FREE_LANG: "0" }).interpretFreeLang, false);

  class FakeAsr extends EventEmitter {
    isOpen = false;
    async connect() { this.isOpen = true; this.emit("status", "connected"); }
    sendAudio() {}
    end() { this.isOpen = false; }
  }
  const asrs: FakeAsr[] = [];
  const json: Record<string, unknown>[] = [];
  const client: ClientSink = { sendJson: (m) => json.push(m), sendBinary() {}, close() {} };
  const session = new Session("free-lang", client, {
    config: loadConfig({ MODEL_API_KEY: "fake", GENITA_SPECULATE: "0", GENITA_INTERPRET_ASR_CORRECT: "0" }),
    openAsr() { const a = new FakeAsr(); asrs.push(a); return a; },
    async *spark(req) { const t = `T(${String(req.input)})`; yield { type: "text", delta: t }; yield { type: "done", responseId: "t", text: t, status: "completed" }; },
    async *tts() {},
  });
  try {
    await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin" }, mode: "interpret", language: "Korean", greeting: false }));
    await new Promise((r) => setTimeout(r, 10));
    asrs[0].emit("event", { type: "speechComplete", turnId: 1, text: "Is there a pharmacy near here?" });
    await new Promise((r) => setTimeout(r, 30));
    asrs[0].emit("event", { type: "speechComplete", turnId: 2, text: "日本語でお願いします" });
    await new Promise((r) => setTimeout(r, 30));
    const pairs = json.filter((m) => m.type === "interpret.pair").map((p) => `${p.user}↔${p.other}`);
    assert.deepEqual(pairs.at(-1), "Korean↔Japanese");
  } finally {
    session.close();
  }
});
