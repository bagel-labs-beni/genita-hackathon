/** Chelsea 11/5 (01:12): the companion's lines never contain em dashes (—) or en dashes (–). */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import { DashScrubber, noDashOn, scrubDashes } from "../src/text/noDash.ts";
import { buildInstructions } from "../src/prompt/persona.ts";
import { NAMED_RECIPE_SAY } from "../src/finds/namedRecipe.ts";
import { Interpreter, type InterpretHost } from "../src/interpret/interpreter.ts";
import type { ServerEvent } from "../src/protocol.ts";
import { turn } from "./helpers/emptyReplies.ts";

const CASES: [string, string][] = [
  ["Menya Sandaime's the classic pick — I put a few more up with photos.", "Menya Sandaime's the classic pick. I put a few more up with photos."],
  ["the cream one—it warms you up", "the cream one, it warms you up"],
  ["it's good — really good — trust me", "it's good, really good, trust me"],
  ["3–5 minutes", "3 to 5 minutes"],
  ["from 2019 – 2020", "from 2019 to 2020"],
  ["pages 3—5", "pages 3-5"],
  ["wait—", "wait."],
  ["— so anyway", "so anyway"],
  ["<warm> — so anyway", "<warm> so anyway"],
  ["Okay, — fine.", "Okay, fine."],
  ['He said — "no"', 'He said, "no"'],
  ["no dash here", "no dash here"],
];

test("no dash: em/en dashes become a comma, a period before a capital, 'to' between numbers", () => {
  for (const [input, want] of CASES) {
    assert.equal(scrubDashes(input), want, input);
    assert.doesNotMatch(scrubDashes(input), /[—–]/);
  }
  assert.ok(noDashOn({}));
  assert.ok(!noDashOn({ GENITA_NO_DASH: "0" }));
});

test("no dash, streamed: a dash split across chunks (every split point, and one character at a time) comes out the same as the whole line", () => {
  for (const [input, want] of CASES) {
    for (let i = 1; i < input.length; i++) {
      const d = new DashScrubber();
      assert.equal(d.push(input.slice(0, i)) + d.push(input.slice(i)) + d.flush(), want, `${JSON.stringify(input)} split at ${i}`);
    }
    const d = new DashScrubber();
    assert.equal([...input].map((c) => d.push(c)).join("") + d.flush(), want, `${input} one char at a time`);
  }
  // the dash alone in a chunk, between two words: "pick " | "—" | " I put"
  const d = new DashScrubber();
  assert.equal(d.push("the classic pick ") + d.push("—") + d.push(" I put") + d.flush(), "the classic pick. I put");
});

async function* deltas(parts: string[]): AsyncGenerator<SparkStreamEvent> {
  for (const p of parts) yield { type: "text", delta: p };
  yield { type: "done", responseId: "r", text: parts.join(""), status: "completed" };
}

test("no dash in a call: the reply, its captions and the spoken sentences carry none, even with the dash in its own chunk", async () => {
  const { events } = await turn({ async *spark() { yield* deltas(["<happy> Menya Sandaime's the classic pick ", "—", " I put a few more up. It's 10–15 minutes from you."]); } });
  const reply = events.find((e) => e.type === "reply") as { text: string } | undefined;
  assert.equal(reply?.text, "Menya Sandaime's the classic pick. I put a few more up. It's 10 to 15 minutes from you.");
  for (const e of events) {
    if (e.type === "reply" || e.type === "reply.delta" || e.type === "say") assert.doesNotMatch(String((e as { text: string }).text), /[—–]/, JSON.stringify(e));
  }
});

test("no dash: GENITA_NO_DASH=0 keeps the old behaviour (reply and prompt)", async () => {
  process.env.GENITA_NO_DASH = "0";
  try {
    const { events } = await turn({ async *spark() { yield* deltas(["The cream one — trust me."]); } });
    assert.equal((events.find((e) => e.type === "reply") as { text: string }).text, "The cream one — trust me.");
    const p = buildInstructions({ persona: { name: "Mira", kind: "human", traits: ["warm"] }, mode: "chat", style: "v1" });
    assert.match(p, /a dash for a quick turn/);
  } finally { delete process.env.GENITA_NO_DASH; }
});

test("no dash: the system prompt says comma or period, never an em or en dash; the card say-line has none", () => {
  // the v1 conversation prompt (the default; the legacy prompt never asked for dashes)
  const p = buildInstructions({ persona: { name: "Mira", kind: "human", traits: ["warm"] }, mode: "chat", style: "v1" });
  assert.doesNotMatch(p, /a dash for a quick turn/);
  assert.match(p, /commas where you'd breathe, never a dash \(— or –\)/);
  assert.doesNotMatch(NAMED_RECIPE_SAY, /[—–]/);
});

test("no dash never touches interpretation: a translation keeps the speaker's dashes", async () => {
  const sent: ServerEvent[] = [];
  let seq = 0;
  let utt = 0;
  const host: InterpretHost = {
    now: () => Date.now(), admitTurn: () => true, send: (e) => sent.push(e), sendAudio: () => {}, nextSeq: () => ++seq, nextUtteranceId: () => ++utt,
    translate: () => deltas(["Wait — really?"]), tts: async function* () {}, useDeviceVoice: () => true, say: () => {}, timing: () => ({ words: [] }), log: () => {},
  };
  const interp = new Interpreter(host, { userLanguage: "English", source: "face", other: "Korean", speculate: false, asrCorrect: null });
  interp.begin();
  interp.final("mic", "잠깐, 진짜?");
  const end = Date.now() + 2000;
  while (!sent.some((e) => e.type === "interpret.bubble" && e.status === "done") && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  const done = sent.find((e) => e.type === "interpret.bubble" && e.status === "done") as Extract<ServerEvent, { type: "interpret.bubble" }>;
  assert.equal(done.translation?.text, "Wait — really?");
  interp.stop();
});
