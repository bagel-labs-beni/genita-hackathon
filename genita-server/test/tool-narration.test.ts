import { test } from "node:test";
import assert from "node:assert/strict";
import { isToolNarration } from "../src/text/toolNarration.ts";

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
  "",
];
for (const sentence of positives) test(`tool narration: ${sentence}`, () => assert.equal(isToolNarration(sentence), true));
for (const sentence of negatives) test(`real content: ${sentence}`, () => assert.equal(isToolNarration(sentence), false));
