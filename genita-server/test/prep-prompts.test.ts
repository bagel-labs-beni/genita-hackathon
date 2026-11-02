import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { SCENE_PROMPT } from "../src/prep/prompts.ts";
import { IMPORT_PROMPT } from "../src/prep/importProfile.ts";

const repo = (p: string) => new URL(`../../${p}`, import.meta.url);

test("scene edits preserve likeness, portrait framing and non-human appearance", () => {
  for (const kind of ["human", "animal", "character"] as const) assert.match(SCENE_PROMPT[kind], /vertical 9:16/);
  assert.match(SCENE_PROMPT.human, /unaltered likeness/);
  assert.match(SCENE_PROMPT.animal, /reference animal's species/);
  assert.match(SCENE_PROMPT.character, /original art style/);
});

test("import prompt asset matches docs/profile-import/prompt-final.txt", { skip: !existsSync(repo("docs/profile-import/prompt-final.txt")) }, () => {
  assert.equal(IMPORT_PROMPT, readFileSync(repo("docs/profile-import/prompt-final.txt"), "utf8"));
});
