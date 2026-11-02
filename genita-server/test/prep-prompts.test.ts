import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { KLING_PROMPT_MAX, PREP_EMOTIONS, SCENE_PROMPT, SILENT_NEGATIVE, klingSilentInput, silentPrompt } from "../src/prep/prompts.ts";
import { IMPORT_PROMPT } from "../src/prep/importProfile.ts";

const repo = (p: string) => new URL(`../../${p}`, import.meta.url);
const SILENT_SRC = repo("peter-engine/generation-prompts/silent.txt");

test("silent prompt fits fal's 2,500-char cap for every emotion and kind", () => {
  for (const kind of ["human", "animal", "character"] as const)
    for (const e of PREP_EMOTIONS) {
      const p = silentPrompt(e, kind);
      assert.ok(p.length <= KLING_PROMPT_MAX, `${kind}/${e} is ${p.length}`);
    }
  assert.ok(SILENT_NEGATIVE.length <= KLING_PROMPT_MAX);
});

test("silent prompt keeps every section of Dyno's silent.txt and its NEGATIVE block verbatim", { skip: !existsSync(SILENT_SRC) }, () => {
  const src = readFileSync(SILENT_SRC, "utf8");
  // the file is pinned in generation-settings.json
  assert.equal(createHash("sha256").update(readFileSync(SILENT_SRC)).digest("hex"), "a1157bc66416da8a3f4c20b393f070515c79203758471f830d9f5dcdd2b3cdef");
  assert.equal(src.split("NEGATIVE")[1].trim(), SILENT_NEGATIVE);
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

test("import prompt v3: docs, server asset and iOS bundle copy are byte-identical", () => {
  const docs = readFileSync(repo("docs/profile-import/prompt-v3.txt"));
  const server = readFileSync(repo("genita-server/src/prep/assets/import-prompt.txt"));
  const ios = readFileSync(repo("ios-app/Genita/Resources/import-prompt.txt"));
  assert.ok(docs.equals(server), "server asset drifted from docs/profile-import/prompt-v3.txt");
  assert.ok(docs.equals(ios), "iOS bundle copy drifted from docs/profile-import/prompt-v3.txt");
  assert.equal(IMPORT_PROMPT, docs.toString("utf8"));
  assert.match(IMPORT_PROMPT, /^10\. Preferences still to confirm$/m);
  assert.match(IMPORT_PROMPT, /^7\. Likes and dislikes$/m);
});

