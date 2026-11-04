import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetInCall, isAnaphoricForget, isCorrection, pointedLine } from "../src/convo/forgetInCall.ts";

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

test("Codex #547 r2: a negated or quoted forget keeps its turn (either detector)", () => {
  for (const t of ["she said forget it", "I can't forget what I said."]) {
    const h = [u("hey"), a("yo"), u(t), a("Huh.")];
    assert.equal(forgetInCall(h).length, 4, t);
  }
});

test("Codex #547 r3: 'Actually, scratch that, the red one.' is a correction, not a forget", () => {
  assert.ok(!isAnaphoricForget("I want the black jacket. Actually, scratch that, the red one."));
  assert.ok(isAnaphoricForget("actually forget I said that, i don't wanna get into it"));
  assert.ok(isAnaphoricForget("scratch that lol"));
});

test("Codex #547 r4: 'scratch that, I don't want to wear black, I want the red one' is a correction; 'forget that, I don't wanna talk about it' still a forget", () => {
  assert.equal(isAnaphoricForget("Actually, scratch that, I don't want to wear black, I want the red one."), false);
  assert.equal(isAnaphoricForget("forget that, i don't wanna talk about it"), true);
  assert.equal(isAnaphoricForget("forget I said that, I don't want to get into it right now."), true);
});

test("Codex #547 r5: a real crisis line is never forgotten mid-call", () => {
  const h = [
    { role: "user" as const, text: "I swallowed all my sleeping pills" },
    { role: "assistant" as const, text: "Call 911 right now." },
    { role: "user" as const, text: "forget I said that" },
    { role: "assistant" as const, text: "Okay." },
    { role: "user" as const, text: "Can I go to sleep now?" },
  ];
  const out = forgetInCall(h).map((x) => x.text);
  assert.ok(out.includes("I swallowed all my sleeping pills"));
  assert.ok(out.includes("Call 911 right now."));
});

test("Codex #547 r6: 'Actually, forget that, I want the red one.' is a correction: both lines stay for Spark", () => {
  const h = [
    { role: "user" as const, text: "I want the black jacket" },
    { role: "assistant" as const, text: "Black is sharp." },
    { role: "user" as const, text: "Actually, forget that, I want the red one." },
    { role: "assistant" as const, text: "Red it is." },
    { role: "user" as const, text: "Which one did I choose?" },
  ];
  assert.ok(isCorrection("Actually, forget that, I want the red one."));
  assert.ok(!isCorrection("forget I said that"));
  const out = forgetInCall(h).map((x) => x.text);
  assert.ok(out.includes("Actually, forget that, I want the red one."));
  assert.ok(out.includes("Red it is."));
});
