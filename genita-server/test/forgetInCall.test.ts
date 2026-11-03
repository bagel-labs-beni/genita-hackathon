import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetInCall, isAnaphoricForget, pointedLine } from "../src/convo/forgetInCall.ts";

const u = (text: string) => ({ role: "user" as const, text });
const a = (text: string) => ({ role: "assistant" as const, text });

test("anaphoric forget: points back with nothing new after it", () => {
  for (const t of ["actually forget I said that, i don't wanna get into it", "forget that", "scratch that lol", "forget it, never mind", "pretend i didn't say that", "don't remember that please", "forget what I just said"]) assert.ok(isAnaphoricForget(t), t);
  for (const t of ["forget that I like leather accessories", "I always forget my keys", "don't forget to text me", "forget about the gym, let's get tacos", "I forget what time it starts"]) assert.ok(!isAnaphoricForget(t), t);
});

test("in-call input: the pointed-at line, the forget turn and both replies are gone; the rest stays", () => {
  const h = [u("hey"), a("<happy> Hey!"), u("my ex texted me happy birthday out of nowhere"), a("<surprised> Out of nowhere? Bold move."), u("actually forget I said that, i don't wanna get into it"), a("<warm> Done, gone."), u("ok what should i do tonight")];
  assert.deepEqual(forgetInCall(h).map((x) => x.text), ["hey", "<happy> Hey!", "ok what should i do tonight"]);
  assert.equal(pointedLine(h.slice(0, 4)), "my ex texted me happy birthday out of nowhere");
});

test("explicit forget: the request turn goes, and lines about its target go (strict list from the session)", () => {
  const h = [u("I love leather jackets"), a("Leather jackets forever."), u("actually forget that I like leather jackets"), a("Gone."), u("anyway ramen?")];
  assert.deepEqual(forgetInCall(h, ["leather jackets"]).map((x) => x.text), ["anyway ramen?"]);
  assert.deepEqual(forgetInCall([u("hi"), a("yo")]).map((x) => x.text), ["hi", "yo"]);
});

test("Codex #547: 'I can't forget what I just said' is no request; an earlier unrelated pair stays; the forgotten line's words key loosely", async () => {
  const { forgetKeyText } = await import("../src/convo/forgetInCall.ts");
  for (const t of ["I can't ignore that.", "I can't forget what I just said.", "she said forget it"]) assert.ok(!isAnaphoricForget(t), t);
  const h = [u("what should I eat tonight"), a("Ramen."), u("I prefer jasmine tea before bed"), a("Cozy."), u("forget I said that"), a("Gone."), u("ok so dinner?")];
  assert.deepEqual(forgetInCall(h, [{ text: forgetKeyText("I prefer jasmine tea before bed"), forget: true }]).map((x) => x.text), ["what should I eat tonight", "Ramen.", "ok so dinner?"]);
  assert.equal(forgetKeyText("I prefer jasmine tea before bed"), "jasmine tea bed");
});

test("Codex #547 P1: a summarized memory of the forgotten line is caught by its loose keys", async () => {
  const { avoidKeys, mentionsAvoided } = await import("../src/personalize/forgotten.ts");
  const { forgetKeyText } = await import("../src/convo/forgetInCall.ts");
  const keys = avoidKeys([{ text: forgetKeyText("I prefer jasmine tea before bed"), forget: true }]);
  assert.ok(mentionsAvoided("Likes jasmine tea.", keys));
  assert.ok(!mentionsAvoided("Likes spicy ramen.", keys));
});
