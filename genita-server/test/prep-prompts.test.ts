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

test("listening loops retain identity, silence and framing sections for every companion", () => {
  for (const kind of ["human", "animal", "character"] as const) {
    const p = silentPrompt("neutral", kind);
    assert.ok(p.startsWith("[emotion: attentive ease"));
    for (const h of ["SILENT MODE (CRITICAL)", "CAMERA (LOCKED, ZERO SCALE CHANGE)", "BACKGROUND", "EXPRESSION", "EYES", "HEAD & BODY", "REALISM"]) assert.ok(p.includes(h), h);
    for (const rule of ["single anatomical mouth", "head and shoulders keep their pixel size", "depth and apparent head size stay constant"]) assert.ok(p.includes(rule), rule);
  }
  assert.match(silentPrompt("neutral", "human"), /REAL HUMAN VIDEO/);
});

test("emotion line changes per clip; non-human prompts drop the real-person framing", () => {
  for (const kind of ["human", "animal", "character"] as const) {
    assert.equal(new Set(PREP_EMOTIONS.map((emotion) => silentPrompt(emotion, kind))).size, PREP_EMOTIONS.length);
  }
  assert.match(silentPrompt("happy"), /closed-lip smile/);
  assert.match(silentPrompt("warm"), /tender/);
  assert.doesNotMatch(silentPrompt("neutral", "animal"), /REAL HUMAN|real person/);
  assert.doesNotMatch(silentPrompt("neutral", "character"), /REAL HUMAN|real person/);
  assert.match(silentPrompt("neutral", "character"), /original art style/);
});

test("kling input keeps the ten-second silent start-frame request shape", () => {
  const i = klingSilentInput("https://x/scene.png", "neutral", "human");
  assert.equal(i.duration, "10");
  assert.equal(i.generate_audio, false);
  assert.equal(i.start_image_url, "https://x/scene.png");
  assert.equal(i.negative_prompt, SILENT_NEGATIVE);
  assert.ok(!("end_image_url" in i));
});

test("scene edits preserve likeness, portrait framing and non-human appearance", () => {
  for (const kind of ["human", "animal", "character"] as const) assert.match(SCENE_PROMPT[kind], /vertical 9:16/);
  assert.match(SCENE_PROMPT.human, /unaltered likeness/);
  assert.match(SCENE_PROMPT.animal, /reference animal's species/);
  assert.match(SCENE_PROMPT.character, /original art style/);
});

test("import prompt asset matches docs/profile-import/prompt-final.txt", { skip: !existsSync(repo("docs/profile-import/prompt-final.txt")) }, () => {
  assert.equal(IMPORT_PROMPT, readFileSync(repo("docs/profile-import/prompt-final.txt"), "utf8"));
});
