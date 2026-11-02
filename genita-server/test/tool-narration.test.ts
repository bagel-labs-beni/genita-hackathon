import { test } from "node:test";
import assert from "node:assert/strict";
import { NarrationJudge, isToolNarration, isToolNarrationLead, isInterjectionOnly } from "../src/text/toolNarration.ts";
import { SentenceSplitter } from "../src/text/sentences.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { turn, tick } from "./helpers/emptyReplies.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";

const positives = [
  "I'll search my memory for that.",
  "I’ll check what you told me.",
  "I'll look that up.",
  "I'll recall our past conversations.",
  "Let me check my memory.",
  "Let me search the web for that.",
  "One sec, looking that up.",
  "Give me a sec while I look that up.",
  "I'll remember that.",
  "I'll save that to memory.",
  "기억을 찾아볼게.",
  "잠깐 찾아볼게요.",
  "기억을 확인해 볼게요.",
  "네가 말해준 내용을 찾아볼게.",
  "잠시만요, 검색해 볼게요.",
  "기억해 둘게요.",
  "Hmm, I'll search my memory for that.",
  "Well, let me check my memory.",
  "One sec; looking that up.",
  "One sec: looking that up.",
  "One sec — looking that up.",
  ...["，", "、", "；", "："].flatMap((separator) => [
    `One sec${separator} looking that up.`,
    `Hmm${separator} I'll search my memory for that.`,
    `잠시만요${separator} 검색해 볼게요.`,
  ]),
  "잠시만요; 검색해 볼게요.",
  "잠시만요: 검색해 볼게요.",
  "잠시만요 — 검색해 볼게요.",
];
const negatives = [
  "Let me think — tofu works.",
  "I'll check the oven.",
  "I'll look after you.",
  "I'll search for my keys.",
  "I remember you love tofu.",
  "You told me you prefer spicy food.",
  "Let me check my memory — tofu works.",
  "I can't look that up right now.",
  "One sec, the tofu is burning.",
  "The search found a tofu recipe.",
  "I'll remember you fondly.",
  "Let me check your coat.",
  "I'll look up at the stars.",
  "I'll look up tofu and cook it tonight.",
  "I'll search my memory for that but tofu works.",
  "기억나, 두부 좋아하잖아.",
  "잠깐, 두부가 좋겠어.",
  "냉장고를 확인해 볼게요.",
  "기억을 찾아볼게요, 두부가 좋겠어요.",
  "검색해 보라고 했지?",
  "찾아봤는데 두부가 있더라.",
  "Hmm, I remember you love tofu.",
  "Well, I'll check the oven.",
  "One sec; the tofu is burning.",
  ...["，", "、", "；", "："].flatMap((separator) => [
    `One sec${separator} the tofu is burning.`,
    `Let me check my memory${separator} tofu works.`,
  ]),
  "",
];
for (const sentence of positives) test(`tool narration: ${sentence}`, () => assert.equal(isToolNarration(sentence), true));
for (const sentence of negatives) test(`real content: ${sentence}`, () => assert.equal(isToolNarration(sentence), false));

const fillers = ["Hm", "Hmm", "HMMMM", "mm", "mmm", "uh", "uhhh", "um", "ummm", "well", "oh", "ohhh", "ah", "ahhh", "eh", "er", "erm", "huh", "okay", "OK", "alright"];
const fillerSeparators = [" ", ", ", ". ", "!? ", "…", "，", "、", "；", "：", "。", "！？", "—", "\n\t"];
for (const filler of fillers) {
  for (const punctuation of ["", ".", ",", "！", "？", "。", "…", "，", "；", "："]) {
    test(`interjection only: ${JSON.stringify(filler + punctuation)}`, () => {
      assert.equal(isInterjectionOnly(` \t${filler}${punctuation}\n`), true);
    });
  }
}
for (const separator of fillerSeparators) {
  for (const text of [fillers.join(separator), `Hmm${separator}Hmm`, `Hmm${separator}Hmm.`]) {
    test(`merged interjections: ${JSON.stringify(text)}`, () => assert.equal(isInterjectionOnly(text), true));
  }
  for (const text of [`Hmm${separator}tofu`, `tofu${separator}okay`, `uh${separator}tofu${separator}um`]) {
    test(`interjections with real words: ${JSON.stringify(text)}`, () => assert.equal(isInterjectionOnly(text), false));
  }
}
for (const text of ["", " \t\n", "，！？…", "Yes!", "No.", "Hmm tofu", "Okay, you like tofu.", "well-being", "ohm", "human", "summary", "okayish", "🤔", "Hmm 🤔"]) {
  test(`not interjection only: ${JSON.stringify(text)}`, () => assert.equal(isInterjectionOnly(text), false));
}
for (const text of ["Hmm", "Hmm,", "Hmm，um", "Okay", "Well, uh，", "Hmm Hmm"]) {
  test(`buffer interjection fragment: ${JSON.stringify(text)}`, () => assert.equal(isToolNarrationLead(text), true));
}
for (const text of ["Hmm.", "Hmm, Hmm.", "Hmm。", "uh！", "Okay?", "Hmm, tofu", "well-being"]) {
  test(`speak complete interjection or real content: ${JSON.stringify(text)}`, () => assert.equal(isToolNarrationLead(text), false));
}

for (const separator of [",", ";", ":", "—", "，", "、", "；", "："]) {
  test(`splitter and announcement check agree on ${separator}`, () => {
    const splitter = new SentenceSplitter({ eagerFirstClause: true });
    const lead = `One sec${separator}`;
    assert.deepEqual(splitter.push(`${lead} looking`), [lead]);
    assert.equal(isToolNarration(`${lead} looking that up.`), true);
  });
}

const announcement = "I'll check my memory.";
const secondAnnouncement = "I'll look that up.";
const realSentence = "You told me you love tofu.";
const TOOL = Symbol("tool call");
const END = Symbol("attempt EOF");
const judgeCases = [
  { name: "round 5 announcement, filler, announcement", input: [announcement, "Hmm.", secondAnnouncement, TOOL], speak: ["Hmm."], answer: false },
  { name: "round 5 eager filler lead", input: [announcement, "Hmm,", secondAnnouncement, TOOL], speak: [], answer: false },
  { name: "multiple tool rounds", input: [announcement, TOOL, secondAnnouncement, TOOL, realSentence], speak: [realSentence], answer: true },
  { name: "judge after real content", input: [realSentence, announcement, "Hmm.", secondAnnouncement, TOOL], speak: [realSentence, "Hmm."], answer: true },
  { name: "tool continuation announcement only", input: [TOOL, announcement], speak: [], answer: false },
  { name: "tool continuation interjections only", input: [TOOL, "Hmm,", "Hmm"], speak: ["Hmm, Hmm"], answer: false },
  { name: "tool state survives retry EOF", input: [announcement, TOOL, "Hmm.", END, "Hmm"], speak: ["Hmm.", "Hmm"], answer: false },
  { name: "real retry answer", input: [TOOL, "Hmm.", END, realSentence], speak: ["Hmm.", realSentence], answer: true },
  { name: "keep lone no-tool announcement", input: [announcement], speak: [announcement], answer: true },
  { name: "keep no-tool filler and lone announcement", input: ["Hmm.", announcement], speak: ["Hmm.", announcement], answer: true },
  { name: "drop announcement before an answer", input: [announcement, realSentence], speak: [realSentence], answer: true },
  { name: "merge eager wait", input: ["One sec，", "looking that up.", TOOL, realSentence], speak: [realSentence], answer: true },
  { name: "keep real content after eager wait", input: ["One sec;", "the tofu is burning.", TOOL], speak: ["One sec; the tofu is burning."], answer: true },
  { name: "keep real content after eager filler", input: ["Hmm,", realSentence, TOOL], speak: [`Hmm, ${realSentence}`], answer: true },
  { name: "preserve raw tags", input: ["<curious> Hmm,", "[whispers] I'll look that up.", TOOL, "<warm> [whispers] Tofu works."], speak: ["<warm> [whispers] Tofu works."], answer: true },
] as const;

for (const scenario of judgeCases) test(`NarrationJudge sequence: ${scenario.name}`, () => {
  const judge = new NarrationJudge();
  const spoken: string[] = [];
  for (const step of scenario.input) {
    const result = step === TOOL ? judge.onToolCall() : step === END ? judge.finish() : judge.push(step);
    spoken.push(...result.speak);
    assert.ok(result.hold.length <= 1);
  }
  spoken.push(...judge.finish().speak);
  assert.deepEqual(spoken, scenario.speak);
  assert.equal(judge.hasAnswer(spoken), scenario.answer);
  assert.deepEqual(judge.finish(), { speak: [], hold: [], dropped: [] });
});

test("NarrationJudge bypass preserves interpretation and self-authored text", () => {
  const judge = new NarrationJudge(false);
  assert.deepEqual(judge.push(announcement).speak, [announcement]);
  judge.onToolCall();
  assert.deepEqual(judge.push("Hmm,").speak, ["Hmm,"]);
  assert.equal(judge.hasAnswer(["Hmm,"]), true);
  assert.equal(judge.hasAnswer([""]), false);
});

// Deterministic exhaustive property: every length 0..4 sequence on each side
// of a tool boundary (121²), with complete and unfinished interjections.
// The oracle uses symbolic kinds, independently of the production predicates.
test("NarrationJudge exhaustive sequences up to four before and after a tool call", () => {
  type Kind = "interjection" | "announcement" | "real";
  const sequences: Kind[][] = [[]];
  let level: Kind[][] = [[]];
  for (let length = 1; length <= 4; length++) {
    level = level.flatMap((prefix) => (["interjection", "announcement", "real"] as const).map((kind) => [...prefix, kind]));
    sequences.push(...level);
  }
  let checked = 0;
  for (const interjection of ["Hmm.", "Hmm,", "Hmm"]) {
    for (const before of sequences) for (const after of sequences) {
      const judge = new NarrationJudge();
      const spoken: string[] = [];
      const expectedReal: string[] = [];
      let index = 0;
      const push = (kind: Kind) => {
        const text = kind === "interjection" ? interjection : kind === "announcement" ? announcement : `Tofu works ${index++}.`;
        if (kind === "real") expectedReal.push(text);
        const result = judge.push(text);
        // Each real sentence leaves the judge immediately, even after a lead.
        if (kind === "real") assert.ok(result.speak.some((s) => s.includes(text)));
        spoken.push(...result.speak);
      };
      before.forEach(push);
      spoken.push(...judge.onToolCall().speak);
      after.forEach(push);
      spoken.push(...judge.finish().speak);
      const text = spoken.join(" ");
      assert.ok(!text.includes(announcement), JSON.stringify({ before, after, interjection, spoken }));
      assert.deepEqual(text.match(/Tofu works \d+\./g) ?? [], expectedReal);
      // This is Session's retry decision: no real answer after tool use,
      // including an interjection-only continuation, must retry.
      assert.equal(judge.hasAnswer(spoken), expectedReal.length > 0);
      checked++;
    }
  }
  assert.equal(checked, 43_923);
});

// Exercise MemoryCall's actual function-call rounds and Session's eager server
// voice splitter, as well as the device voice's whole-sentence path.
function voiceConfig(voice: "server" | "device"): Config {
  return { ...loadConfig({ MODEL_API_KEY: "fake" }), serverTts: voice === "server", webSearch: false, sparkHedge: 1, speculate: false,
    voice: { url: "http://voice.invalid", token: "fake", speakers: { human: 0, animal: 0, character: 0 }, speed: 1, timeoutMs: 1000, model: "seamless" } };
}

async function recallTurn(voice: "server" | "device", announcements: string[][], followupTexts = ["You told me you love tofu."]) {
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const spoken: string[] = [];
  const answer = "You told me you love tofu.";
  let followups = 0;
  const result = await turn({
    config: voiceConfig(voice),
    memory, userId: "fake",
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      const round = Array.isArray(req.input) ? req.input.filter((item) => "type" in item && item.type === "function_call_output").length : 0;
      if (round < announcements.length) {
        for (const delta of announcements[round]) {
          yield { type: "text", delta };
          await tick();
        }
        yield { type: "function_call", name: "recall", call_id: `recall-${round}`, arguments: '{"query":"favorite food"}' };
      } else {
        const text = followupTexts[Math.min(followups++, followupTexts.length - 1)];
        if (text) yield { type: "text", delta: text };
      }
      yield { type: "done", responseId: `round-${round}`, text: "", status: "completed" };
    },
    async *tts(req) {
      spoken.push(req.text);
      yield { audio: Buffer.alloc(960), alignment: null, model: req.model };
    },
  });
  await memory.drain();
  assert.equal(result.events.filter((e) => e.type === "tool" && e.name === "recall" && e.status === "completed").length, announcements.length);
  return { ...result, spoken, answer, followups };
}

for (const voice of ["server", "device"] as const) {
  for (const pieces of [
    ["I'll check my memory. Hmm. I'll look that up. "],
    ["I'll check my memory. ", "Hmm. ", "I'll look that up. "],
    ["I'll check my memory. Hmm, ", "I'll look that up. "],
  ]) test(`round 5: announcements separated by fillers still retry (${voice}, ${JSON.stringify(pieces)})`, async () => {
    const { events, logs, spoken, answer, followups } = await recallTurn(voice, [pieces], ["", "You told me you love tofu."]);
    assert.equal(followups, 2);
    assert.equal(logs.filter((log) => log.event === "spark.empty_retry").length, 1);
    const reply = events.find((e) => e.type === "reply")?.text;
    assert.ok(reply?.endsWith(answer));
    assert.doesNotMatch(reply!, /check my memory|look that up/);
    assert.equal(events.filter((e) => e.type === "reply.delta").map((e) => e.text).join(""), reply);
    if (voice === "server") assert.equal(spoken.join(" "), reply);
    else assert.equal(events.filter((e) => e.type === "say").map((e) => e.text).join(" "), reply);
  });

  for (const [lead, followup] of [
    ["Hmm,", "Hmm."],
    ["Hmm,", "Hmm"],
    ["Hmm,", "Hmm, Hmm."],
    ["Hmm，", "Hmm。"],
    ["Hmm", "uh um well oh ah okay"],
    ["Okay,", "OK"],
    ["Well, uh,", "um，okay！"],
  ]) test(`round 4: repeated fillers require a real tool answer (${voice}, ${JSON.stringify([lead, followup])})`, async () => {
    const { events, logs, spoken, answer, followups } = await recallTurn(voice, [[lead]], [followup, "You told me you love tofu."]);
    assert.equal(followups, 2);
    assert.equal(logs.filter((log) => log.event === "spark.empty_retry").length, 1);
    const reply = events.find((e) => e.type === "reply")?.text;
    assert.ok(reply?.endsWith(answer));
    assert.equal(events.filter((e) => e.type === "reply.delta").map((e) => e.text).join(""), reply);
    assert.equal(events.some((e) => e.type === "error"), false);
    if (voice === "server") assert.equal(spoken.join(" "), reply);
    else assert.equal(events.filter((e) => e.type === "say").map((e) => e.text).join(" "), reply);
  });

  for (const followup of ["Hmm. Hmm", "uh，um；well：oh、ah okay", "Okay"]) {
    test(`round 4: fillers after both attempts report failure (${voice}, ${JSON.stringify(followup)})`, async () => {
      const { events, logs, followups } = await recallTurn(voice, [["Hmm,"]], [followup]);
      assert.equal(followups, 2);
      assert.equal(logs.filter((log) => log.event === "spark.empty_retry").length, 1);
      assert.equal(events.some((e) => e.type === "reply"), false);
      assert.equal(events.filter((e) => e.type === "error" && e.code === "spark_unavailable").length, 1);
    });
  }

  for (const followup of ["Hmm, tofu works.", "Hmm tofu", "Okay, you like tofu.", "Well，tofu！", "Yes!"]) {
    test(`round 4: fillers mixed with real words are an answer (${voice}, ${JSON.stringify(followup)})`, async () => {
      const { events, logs, followups } = await recallTurn(voice, [["Hmm,"]], [followup]);
      assert.equal(followups, 1);
      assert.equal(logs.some((log) => log.event === "spark.empty_retry"), false);
      assert.ok(events.find((e) => e.type === "reply")?.text.endsWith(followup));
      assert.equal(events.some((e) => e.type === "error"), false);
    });
  }

  for (const followup of ["", "<curious> Hmm."]) test(`P2: interjection-only tool turn retries an empty answer (${voice}, ${JSON.stringify(followup)})`, async () => {
    const { events, logs, spoken, answer, followups } = await recallTurn(voice, [["Hmm. I'll search my memory for that. "]], [followup, "You told me you love tofu."]);
    const expected = ["Hmm.", followup ? "Hmm." : "", answer].filter(Boolean).join(" ");
    assert.equal(followups, 2);
    assert.equal(logs.filter((log) => log.event === "spark.empty_retry").length, 1);
    assert.deepEqual(events.filter((e) => e.type === "reply").map((e) => e.text), [expected]);
    assert.equal(events.filter((e) => e.type === "reply.delta").map((e) => e.text).join(""), expected);
    assert.equal(events.some((e) => e.type === "error"), false);
    if (voice === "server") assert.equal(spoken.join(" "), expected);
    else assert.equal(events.filter((e) => e.type === "say").map((e) => e.text).join(" "), expected);
  });

  test(`P2: interjection-only tool turn reports failure after its retry (${voice})`, async () => {
    const { events, logs, followups } = await recallTurn(voice, [["Hmm. I'll search my memory for that. "]], ["", "Hmm."]);
    assert.equal(followups, 2);
    assert.equal(logs.filter((log) => log.event === "spark.empty_retry").length, 1);
    assert.equal(events.some((e) => e.type === "reply"), false);
    assert.equal(events.filter((e) => e.type === "error" && e.code === "spark_unavailable").length, 1);
  });

  test(`substantive content before an empty tool follow-up needs no retry (${voice})`, async () => {
    const { events, logs, followups } = await recallTurn(voice, [["Hmm. I remember you love tofu. "]], [""]);
    assert.equal(followups, 1);
    assert.equal(logs.some((log) => log.event === "spark.empty_retry"), false);
    assert.equal(events.find((e) => e.type === "reply")?.text, "Hmm. I remember you love tofu.");
  });

  const cases = [
    ["P2: judge the second tool-call round", [["I'll search my memory for that. "], ["Let me check my memory. "]]],
    ["P2: judge past a streamed interjection", [["<curious> Hmm, ", "I'll search my memory for that. "]]],
    ...[";", ":", "—", "，", "、", "；", "："].map((separator) => [`P2: wait separator ${separator}`, [[`One sec${separator} looking that up. `]]] as const),
  ] as const;
  for (const [name, announcements] of cases) test(`${name} (${voice})`, async () => {
    const { events, spoken, answer } = await recallTurn(voice, announcements.map((pieces) => [...pieces]));
    assert.deepEqual(events.filter((e) => e.type === "reply").map((e) => e.text), [answer]);
    assert.equal(events.filter((e) => e.type === "reply.delta").map((e) => e.text).join(""), answer);
    if (voice === "server") assert.deepEqual(spoken, [answer]);
    else assert.deepEqual(events.filter((e) => e.type === "say").map((e) => e.text), [answer]);
  });

  for (const pieces of [
    ["Hmm. I'll search my memory for that. "],
    ["<curious> Hmm. ", "I'll search my memory for that. "],
  ]) test(`P2: keep a standalone interjection and judge the next sentence (${voice}, ${pieces.length} chunks)`, async () => {
    const { events, spoken, answer } = await recallTurn(voice, [pieces]);
    const expected = `Hmm. ${answer}`;
    assert.equal(events.find((e) => e.type === "reply")?.text, expected);
    assert.equal(events.filter((e) => e.type === "reply.delta").map((e) => e.text).join(""), expected);
    if (voice === "server") assert.deepEqual(spoken, ["Hmm.", answer]);
    else assert.deepEqual(events.filter((e) => e.type === "say").map((e) => e.text), ["Hmm.", answer]);
  });

  test(`substantive content after an interjection survives a recall (${voice})`, async () => {
    const { events, answer } = await recallTurn(voice, [["<warm> Hmm, ", "I remember you love tofu. "]]);
    assert.equal(events.find((e) => e.type === "reply")?.text, `Hmm, I remember you love tofu. ${answer}`);
  });

  for (const separator of ["，", "、", "；", "："]) test(`real content after ${separator} survives a recall (${voice})`, async () => {
    const { events, spoken, answer } = await recallTurn(voice, [[`One sec${separator} `, "the tofu is burning. "]]);
    const expected = `One sec${separator} the tofu is burning. ${answer}`;
    assert.equal(events.find((e) => e.type === "reply")?.text, expected);
    assert.equal(events.filter((e) => e.type === "reply.delta").map((e) => e.text).join(""), expected);
    if (voice === "server") assert.equal(spoken.join(" "), expected);
    else assert.equal(events.filter((e) => e.type === "say").map((e) => e.text).join(" "), expected);
  });

  for (const text of ["Hmm,", "Hmm.", "Hmm. I'll search my memory for that.", "Hmm. I remember you love tofu.", "Hmm, I'll search my memory for that.", "One sec; looking that up.", "One sec; the tofu is burning.", "One sec， looking that up.", "One sec， the tofu is burning."]) {
    test(`no-tool reply preserves ${JSON.stringify(text)} (${voice})`, async () => {
      const { events } = await turn({
        config: voiceConfig(voice),
        async *spark(): AsyncGenerator<SparkStreamEvent> {
          for (const delta of text.match(/.{1,5}/gs) ?? []) {
            yield { type: "text", delta };
            await tick();
          }
          yield { type: "done", responseId: "no-tool", text, status: "completed" };
        },
        async *tts(req) { yield { audio: Buffer.alloc(960), alignment: null, model: req.model }; },
      });
      assert.equal(events.find((e) => e.type === "reply")?.text, text);
    });
  }
}
