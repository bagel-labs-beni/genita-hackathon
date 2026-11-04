import { test } from "node:test";
import assert from "node:assert/strict";
import { Interpreter, type InterpretHost } from "../src/interpret/interpreter.ts";
import { acceptCorrection, buildCorrectionInput, correctKorean } from "../src/interpret/asrCorrect.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";
import type { ServerEvent } from "../src/protocol.ts";
import { loadConfig } from "../src/config.ts";

const CORRECT_MARK = "speech-recognition errors";
const isCorrection = (req: SparkRequest) => (req.instructions ?? "").includes(CORRECT_MARK);

async function* text(t: string, delayMs = 0, signal?: AbortSignal): AsyncGenerator<SparkStreamEvent> {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  if (signal?.aborted) throw new Error("aborted");
  yield { type: "text", delta: t };
  yield { type: "done", responseId: null, text: t, status: "completed" };
}

type Fix = { out?: string; delayMs?: number; fail?: boolean };

/** Mocked ASR → Interpreter: `fix(raw)` is the correction model's answer, translations echo "EN(<input>)". */
function harness(opts: { asrCorrect?: { timeoutMs: number } | null; fix?: (raw: string, req: SparkRequest) => Fix; userLanguage?: string } = {}) {
  const sent: ServerEvent[] = [];
  const requests: SparkRequest[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  let seq = 0;
  let utt = 0;
  const host: InterpretHost = {
    now: () => Date.now(),
    admitTurn: () => true,
    send: (e) => sent.push(e),
    sendAudio: () => {},
    nextSeq: () => ++seq,
    nextUtteranceId: () => ++utt,
    translate: (req, signal) => {
      requests.push(req);
      if (isCorrection(req)) {
        const raw = String(req.input).split("Utterance: ").pop()!;
        const f = opts.fix?.(raw, req) ?? { out: raw };
        if (f.fail) return (async function* () { throw new Error("spark down"); })();
        return text(f.out ?? raw, f.delayMs ?? 0, signal);
      }
      return text(`EN(${String(req.input)})`, 5, signal);
    },
    tts: async function* () {},
    useDeviceVoice: () => true,
    say: () => {},
    timing: () => ({ words: [] }),
    log: (event, data) => logs.push({ event, data }),
  };
  const interp = new Interpreter(host, { userLanguage: opts.userLanguage ?? "English", source: "face", other: "Korean", speculate: false, asrCorrect: opts.asrCorrect === undefined ? { timeoutMs: 300 } : opts.asrCorrect });
  interp.begin();
  /** a mocked ASR turn on the mic */
  const say = (t: string) => {
    interp.partial("mic", t);
    interp.speechEnd("mic");
    interp.final("mic", t);
  };
  const done = async () => {
    const t0 = Date.now();
    for (;;) {
      const replies = sent.filter((e) => e.type === "reply");
      const finals = sent.filter((e) => e.type === "interpret.bubble" && (e.status === "done" || e.status === "unknown"));
      if (replies.length && finals.length >= replies.length && !(interp as unknown as { running: unknown }).running && !(interp as unknown as { queue: unknown[] }).queue.length) return;
      if (Date.now() - t0 > 3000) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const lastBubble = () => sent.filter((e) => e.type === "interpret.bubble").pop() as Extract<ServerEvent, { type: "interpret.bubble" }>;
  const translations = () => requests.filter((r) => !isCorrection(r)).map((r) => String(r.input));
  return { interp, say, done, sent, requests, logs, lastBubble, translations };
}

test("asr correct: '대다 안 되나' becomes '대면 안 되나' from context, and that is what gets translated", async () => {
  let seenInput = "";
  const h = harness({
    fix: (raw, req) => {
      seenInput = String(req.input);
      return raw === "대다 안 되나" ? { out: "대면 안 되나" } : { out: raw };
    },
  });
  h.say("Let's just do it over a video call.");
  await h.done();
  h.say("대다 안 되나");
  await h.done();
  const b = h.lastBubble();
  assert.equal(b.original.text, "대면 안 되나");
  assert.equal(b.translation?.text, "EN(대면 안 되나)");
  assert.match(seenInput, /Recent conversation:\n- A \(English\): Let's just do it over a video call\./);
  assert.ok(h.translations().includes("대면 안 되나"));
  assert.ok(h.logs.some((l) => l.event === "interpret.asr_correct" && l.data.outcome === "changed"));
});

test("asr correct: short '남나?' misheard line is fixed by one syllable", async () => {
  const h = harness({ fix: (raw) => (raw === "남나?" ? { out: "남냐?" } : { out: raw }) });
  h.say("남나?");
  await h.done();
  assert.equal(h.lastBubble().original.text, "남냐?");
  assert.equal(h.lastBubble().translation?.text, "EN(남냐?)");
});

test("asr correct: a short line that already makes sense is kept and the raw translation is used (no second translation)", async () => {
  const h = harness();
  h.say("네 맞아요.");
  await h.done();
  assert.equal(h.lastBubble().original.text, "네 맞아요.");
  assert.deepEqual(h.translations(), ["네 맞아요."]);
  assert.ok(h.logs.some((l) => l.event === "interpret.asr_correct" && l.data.outcome === "unchanged"));
});

test("asr correct: kill switch off → raw passthrough, no correction call", async () => {
  const h = harness({ asrCorrect: null, fix: () => ({ out: "대면 안 되나" }) });
  h.say("대다 안 되나");
  await h.done();
  assert.equal(h.lastBubble().original.text, "대다 안 되나");
  assert.equal(h.requests.filter(isCorrection).length, 0);
  assert.equal(loadConfig({ MODEL_API_KEY: "x", GENITA_INTERPRET_ASR_CORRECT: "0" }).interpretAsrCorrect, false);
  assert.equal(loadConfig({ MODEL_API_KEY: "x" }).interpretAsrCorrect, true, "on by default in prod config");
  assert.equal(loadConfig({ MODEL_API_KEY: "x" }).interpretAsrCorrectMs, 800);
});

test("asr correct: timeout or Spark error → raw text is translated", async () => {
  const slow = harness({ asrCorrect: { timeoutMs: 50 }, fix: () => ({ out: "대면 안 되나", delayMs: 400 }) });
  slow.say("대다 안 되나");
  await slow.done();
  assert.equal(slow.lastBubble().original.text, "대다 안 되나");
  assert.equal(slow.lastBubble().translation?.text, "EN(대다 안 되나)");
  assert.ok(slow.logs.some((l) => l.event === "interpret.asr_correct" && l.data.outcome === "timeout"));

  const down = harness({ fix: () => ({ fail: true }) });
  down.say("대다 안 되나");
  await down.done();
  assert.equal(down.lastBubble().translation?.text, "EN(대다 안 되나)");
  assert.ok(down.logs.some((l) => l.event === "interpret.asr_correct" && l.data.outcome === "error"));
});

test("asr correct: English (non-Korean) lines never go through the correction", async () => {
  const h = harness({ fix: () => ({ out: "완전히 다른 말" }) });
  h.say("Can we meet in person?");
  await h.done();
  assert.equal(h.requests.filter(isCorrection).length, 0);
  assert.equal(h.lastBubble().original.text, "Can we meet in person?");
});

test("asr correct: an answer that rewrites, translates or answers is rejected", async () => {
  const h = harness({ fix: () => ({ out: "네, 대면으로 만나도 괜찮아요. 언제가 좋으세요?" }) });
  h.say("대다 안 되나");
  await h.done();
  assert.equal(h.lastBubble().original.text, "대다 안 되나");
  assert.ok(h.logs.some((l) => l.event === "interpret.asr_correct" && l.data.outcome === "rejected"));

  assert.equal(acceptCorrection("대다 안 되나", "Can't we meet in person?"), null, "translation");
  assert.equal(acceptCorrection("대다 안 되나", "대면 안 되나\n(설명)"), null, "multi-line");
  assert.equal(acceptCorrection("남나?", "나 지금 집에 가는 중이야"), null, "rewrite");
  assert.equal(acceptCorrection("대다 안 되나", "Utterance: 대면 안 되나"), "대면 안 되나", "label stripped");
  assert.equal(acceptCorrection("대다 안 되나", "\"대면 안 되나\""), "대면 안 되나", "quotes stripped");
  assert.equal(acceptCorrection("대다 안 되나", "대다 안 되나"), null, "same");
});

test("asr correct: correctKorean resolves within the timeout and passes the context lines", async () => {
  const ac = new AbortController();
  let input = "";
  const t0 = Date.now();
  const r = await correctKorean(
    (req) => {
      input = String(req.input);
      return text("대면 안 되나", 1000);
    },
    "대다 안 되나",
    [{ speaker: "them", lang: "Korean", text: "만나서 얘기할까요?" }],
    { timeoutMs: 60, signal: ac.signal, now: () => Date.now() },
  );
  assert.equal(r.outcome, "timeout");
  assert.equal(r.text, null);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(input, buildCorrectionInput("대다 안 되나", [{ speaker: "them", lang: "Korean", text: "만나서 얘기할까요?" }]));
  assert.match(input, /- B \(Korean\): 만나서 얘기할까요\?\n\nUtterance: 대다 안 되나$/);
});

test("asr correct: numbers must survive (30만원 → 300만원 is not a slip)", () => {
  assert.equal(acceptCorrection("이거 30만원 맞아요?", "이거 300만원 맞아요?"), null);
  assert.equal(acceptCorrection("약은 0.5mg씩 먹어요.", "약은 50mg씩 먹어요."), null);
  assert.equal(acceptCorrection("3시에 대다 안 되나", "3시에 대면 안 되나"), "3시에 대면 안 되나");
});

test("asr correct: a cut answer (status incomplete) keeps the raw line", async () => {
  const r = await correctKorean(
    () => (async function* (): AsyncGenerator<SparkStreamEvent> {
      yield { type: "text", delta: "대면 안" };
      yield { type: "done", responseId: null, text: "대면 안", status: "incomplete" };
    })(),
    "대다 안 되나",
    [],
    { timeoutMs: 300, signal: new AbortController().signal, now: () => Date.now() },
  );
  assert.equal(r.text, null);
  assert.equal(r.outcome, "rejected");
});

test("asr correct: queued Korean lines ask for their corrections at once (waits don't add up)", async () => {
  const asked: number[] = [];
  const t0 = Date.now();
  const h = harness({
    asrCorrect: { timeoutMs: 1000 },
    fix: (raw) => {
      asked.push(Date.now() - t0);
      return { out: raw, delayMs: 150 };
    },
  });
  h.say("대다 안 되나");
  h.say("내일 만나면 되지");
  await h.done();
  assert.equal(asked.length, 2);
  assert.ok(asked[1] < 100, `second correction asked at ${asked[1]} ms, not after the first finished`);
});
