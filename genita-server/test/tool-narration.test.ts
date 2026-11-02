import { test } from "node:test";
import assert from "node:assert/strict";
import { isToolNarration } from "../src/text/toolNarration.ts";
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

for (const separator of [",", ";", ":", "—", "，", "、", "；", "："]) {
  test(`splitter and announcement check agree on ${separator}`, () => {
    const splitter = new SentenceSplitter({ eagerFirstClause: true });
    const lead = `One sec${separator}`;
    assert.deepEqual(splitter.push(`${lead} looking`), [lead]);
    assert.equal(isToolNarration(`${lead} looking that up.`), true);
  });
}

// Exercise MemoryCall's actual function-call rounds and Session's eager server
// voice splitter, as well as the device voice's whole-sentence path.
function voiceConfig(voice: "server" | "device"): Config {
  return { ...loadConfig({ MODEL_API_KEY: "fake" }), serverTts: voice === "server", webSearch: false, sparkHedge: 1, speculate: false,
    voice: { url: "http://voice.invalid", token: "fake", speakers: { human: 0, animal: 0, character: 0 }, speed: 1, timeoutMs: 1000, model: "seamless" } };
}

async function recallTurn(voice: "server" | "device", announcements: string[][]) {
  const repo = new InMemoryMemoryRepository();
  const memory = new MemoryService({ repository: repo, state: repo, extract: async () => [] });
  const spoken: string[] = [];
  const answer = "You told me you love tofu.";
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
      } else yield { type: "text", delta: answer };
      yield { type: "done", responseId: `round-${round}`, text: "", status: "completed" };
    },
    async *tts(req) {
      spoken.push(req.text);
      yield { audio: Buffer.alloc(960), alignment: null, model: req.model };
    },
  });
  await memory.drain();
  assert.equal(result.events.filter((e) => e.type === "tool" && e.name === "recall" && e.status === "completed").length, announcements.length);
  return { ...result, spoken, answer };
}

for (const voice of ["server", "device"] as const) {
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
