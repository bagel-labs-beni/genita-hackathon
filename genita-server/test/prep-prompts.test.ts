import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { KLING_PROMPT_MAX, PREP_EMOTIONS, SCENE_PROMPT, SILENT_NEGATIVE, klingSilentInput, silentPrompt } from "../src/prep/prompts.ts";
import { IMPORT_PROMPT } from "../src/prep/importProfile.ts";

const repo = (p: string) => new URL(`../../${p}`, import.meta.url);

test("silent prompt fits fal's 2,500-char cap for every emotion and kind", () => {
  for (const kind of ["human", "animal", "character"] as const)
    for (const e of PREP_EMOTIONS) {
      const p = silentPrompt(e, kind);
      assert.ok(p.length <= KLING_PROMPT_MAX, `${kind}/${e} is ${p.length}`);
    }
  assert.ok(SILENT_NEGATIVE.length <= KLING_PROMPT_MAX);
});

test("silent prompt keeps the approved framing and identity rules", () => {
  const p = silentPrompt("neutral", "human");
  assert.ok(p.startsWith("[emotion: friendly]"));
  for (const h of ["REAL HUMAN VIDEO", "SILENT MODE (CRITICAL)", "CAMERA (LOCKED", "BACKGROUND", "EXPRESSION", "EYES", "HEAD & BODY", "REALISM"]) assert.ok(p.includes(h), h);
  for (const rule of ["ONE mouth only", "Static locked-off tripod camera", "Do NOT redesign, beautify, stylize, or reinterpret the face", "must NOT move the head closer to or farther from the camera"]) assert.ok(p.includes(rule), rule);
});

test("emotion line changes per clip; non-human prompts drop the real-person framing", () => {
  assert.notEqual(silentPrompt("happy"), silentPrompt("neutral"));
  assert.match(silentPrompt("happy"), /closed-lip smile/);
  assert.match(silentPrompt("warm"), /tender/);
  assert.doesNotMatch(silentPrompt("neutral", "animal"), /REAL HUMAN|real person/);
  assert.match(silentPrompt("neutral", "character"), /original art style/);
});

test("kling input is Dyno's setting: 10 s, silent, start frame only", () => {
  const i = klingSilentInput("https://x/scene.png", "neutral", "human");
  assert.equal(i.duration, "10");
  assert.equal(i.generate_audio, false);
  assert.equal(i.start_image_url, "https://x/scene.png");
  assert.equal(i.negative_prompt, SILENT_NEGATIVE);
  assert.ok(!("end_image_url" in i));
});

test("human scene prompt is the T2 prompt (Muse 9.2/10)", () => {
  assert.match(SCENE_PROMPT.human, /^Keep this exact same person: identical face shape/);
  assert.match(SCENE_PROMPT.human, /vertical 9:16/);
});

test("import prompt asset matches docs/profile-import/prompt-final.txt", { skip: !existsSync(repo("docs/profile-import/prompt-final.txt")) }, () => {
  assert.equal(IMPORT_PROMPT, readFileSync(repo("docs/profile-import/prompt-final.txt"), "utf8"));
});
