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

