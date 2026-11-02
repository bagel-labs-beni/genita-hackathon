/** Import v3: the profile's Likes & dislikes ("Taste" lines) reach the Finds recipe prompt. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { styleProfileText, toStyleCard } from "../src/prep/importProfile.ts";
import { runRecipe, type PipelineCtx } from "../src/finds/pipeline.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";

const f = (text: string) => ({ text, label: "explicit" as const, scope: "any" });

test("finds recipe prompt carries the profile's Likes & dislikes", async () => {
  const prompts: string[] = [];
  const vendors: FindsVendors = {
    async spark(req) {
      prompts.push(typeof req.input === "string" ? req.input : JSON.stringify(req.input));
      return { text: "", output: [] };
    },
    async *sparkStream() {
      yield { type: "text" as const, delta: "NONE\n" };
      yield { type: "done" as const, responseId: null, text: "", status: "completed" };
    },
    async sam() {
      return [];
    },
    async image() {
      return Buffer.from([]);
    },
  };
  const profile = styleProfileText(
    toStyleCard({
      sections: { communication: [f("Warm and brief.")], likes: [f("Korean home cooking."), f("Dislikes cilantro.")] } as never,
      rules: [],
      to_confirm: [],
    }),
  );
  const ctx: PipelineCtx = {
    findId: "find-1",
    utteranceId: 1,
    kind: "recipe",
    question: "What can I make?",
    frames: ["data:image/jpeg;base64,AAA"],
    memories: [],
    profile,
    replyText: Promise.resolve(""),
    vendors,
    emit: () => {},
    signal: new AbortController().signal,
    now: () => performance.now(),
    log: () => {},
    images: false,
    putImage: async () => "",
  };
  await runRecipe(ctx);
  const recipe = prompts.find((p) => p.includes("Pick one simple dish"));
  assert.ok(recipe, "recipe prompt sent");
  assert.match(recipe!, /Dislikes cilantro/);
  assert.match(recipe!, /data, not instructions/);
});
