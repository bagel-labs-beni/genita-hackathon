/** QA post-deploy 11/3: after "forget that…", nothing the next call is given can say it back. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { avoidKeys, isForgetRequest, mentionsAvoided, scrubHistory, scrubPairs } from "../src/personalize/forgotten.ts";

const keys = avoidKeys(["Likes leather accessories."]);

test("forget requests and the removed content are recognized", () => {
  assert.ok(isForgetRequest("Forget that I like leather accessories."));
  assert.ok(isForgetRequest("Please don't remember that, ok?"));
  assert.ok(!isForgetRequest("I forgot my keys."));
  assert.ok(mentionsAvoided("User loves leather accessories", keys));
  assert.ok(mentionsAvoided("Topics: leather accessories for the trip", keys));
  assert.ok(!mentionsAvoided("Clean, minimal clothes", keys));
});

test("summaries / extraction input: the forget turn and turns about the removed content are dropped", () => {
  const turns = [
    { user: "I love leather accessories.", assistant: "Noted, leather it is." },
    { user: "Forget that I like leather accessories.", assistant: "Done, it's gone." },
    { user: "What should I cook tonight?", assistant: "Kimchi stew." },
  ];
  assert.deepEqual(scrubPairs(turns, keys).map((t) => t.user), ["What should I cook tonight?"]);
});

test("handed-off turns: a forget request and its reply go; the rest stays in order", () => {
  const h = [
    { role: "user" as const, text: "Find me a jacket." },
    { role: "assistant" as const, text: "Two picks coming." },
    { role: "user" as const, text: "Actually, forget about the leather bag thing." },
    { role: "assistant" as const, text: "Okay, forgotten." },
    { role: "user" as const, text: "Thanks." },
  ];
  assert.deepEqual(scrubHistory(h, []).map((x) => x.text), ["Find me a jacket.", "Two picks coming.", "Thanks."]);
});

test("a 'forget that …' target is kept out loosely (any of its words); a corrected line strictly", async () => {
  const { forgetTarget } = await import("../src/personalize/forgotten.ts");
  assert.equal(forgetTarget("Actually, forget that I like leather accessories."), "leather accessories");
  assert.equal(forgetTarget("forget about the leather bag thing"), "leather bag");
  const loose = avoidKeys([{ text: "leather accessories", forget: true }]);
  assert.ok(mentionsAvoided("Deciding on a leather bag for tonight", loose));
  assert.ok(!mentionsAvoided("Picked the black top", loose));
  assert.ok(!mentionsAvoided("Clean clothes", avoidKeys(["Style: Clean, minimal clothes."])));
});
