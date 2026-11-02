import { test } from "node:test";
import assert from "node:assert/strict";
import { isMostlyHangul } from "../src/text/language.ts";
import { buildTtsBody, isModelRefusal } from "../src/tts/tone.ts";

test("isMostlyHangul flags Korean speech and not English with a Korean word", () => {
  assert.equal(isMostlyHangul("실례합니다, 여기서 시청 가려면 어떻게 가요?"), true);
  assert.equal(isMostlyHangul("I love kimchi jjigae"), false);
  assert.equal(isMostlyHangul("I had 김치 for lunch today with my friends"), false);
  assert.equal(isMostlyHangul("음 그거 good idea 같아"), true);
  assert.equal(isMostlyHangul(""), false);
});

test("v4 turbo body: emotion becomes an audio tag, stability 0.5, no style", () => {
  assert.deepEqual(buildTtsBody("Hi there!", "happy", "eleven_v4_turbo"), {
    text: "[cheerfully] Hi there!",
    model_id: "eleven_v4_turbo",
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  });
});

test("whisper emotion uses the whispers tag; unknown emotion adds no tag", () => {
  assert.equal(buildTtsBody("psst", "whisper", "eleven_v3").text, "[whispers] psst");
  assert.equal(buildTtsBody("ok", "glorbish", "eleven_v3").text, "ok");
  assert.equal(buildTtsBody("ok", null, "eleven_v3").text, "ok");
});

test("models without audio-tag support get tags stripped instead of read aloud", () => {
  assert.equal(buildTtsBody("[laughs] no way", "happy", "eleven_flash_v2_5").text, "no way");
});

test("only 400/403/404/422 count as a model refusal worth falling back on", () => {
  assert.equal(isModelRefusal(422), true);
  assert.equal(isModelRefusal(429), false);
  assert.equal(isModelRefusal(500), false);
});
