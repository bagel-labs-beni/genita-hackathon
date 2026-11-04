/**
 * prompt-100 (11/4): the prompt-rewrite review's weak points, held in code.
 * - turn 2 said "Hey, look who finally showed up." after the opener had already greeted (bake-off D)
 * - "can I throw in the leftover rice too?" got "Go, have fun! I want the full story after" (guilt guard false positive
 *   on a cooking tip, then its send-off fallback)
 * - the Mac stage with no frame: a reply that only described what it saw was dropped to nothing
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { noRepeatGreeting, noUnpromptedGoodbye, userIsLeaving } from "../src/convo/greetOnce.ts";
import { fallbackLine, guardSentence, NO_FRAME_RETRY_LINE } from "../src/convo/guard.ts";
import { adapter } from "../src/convo/evalAdapter.ts";
import { buildInstructions } from "../src/prompt/persona.ts";

test("a second hello after the opener goes; the rest of the sentence stays", () => {
  // bake-off D transcripts, turn 2 after the opener
  assert.equal(noRepeatGreeting("Hey, look who finally showed up.", "ok I'm on the Mac now"), "");
  assert.equal(noRepeatGreeting("<happy> Hey you, finally decided to show up.", "hey"), "<happy> Hey you.");
  assert.equal(noRepeatGreeting("Hey, look who finally showed up.", "hey"), "Hey.");
  assert.equal(noRepeatGreeting("There you are, so what's the verdict on the fit?", "ok I'm on the Mac now"), "So what's the verdict on the fit?");
  assert.equal(noRepeatGreeting("Oh hey, you're back!", "hi"), "Oh hey!");
  assert.equal(noRepeatGreeting("Oh hey, you're back!", "can I throw in the rice?"), "");
  assert.equal(noRepeatGreeting("Well hey, Tuesday night troublemaker, you made it.", "hey"), "Tuesday night troublemaker.");
  // not a greeting: untouched
  for (const s of ["That's brutal, making you pitch his version like that.", "Black one, no contest.", "Finally, a dish that needs no oven.", "You're back to square one with the deck, huh."]) assert.equal(noRepeatGreeting(s, "x"), s);
});

test("a send-off answers only a line that is leaving or a plan, never a question", () => {
  assert.equal(noUnpromptedGoodbye("<excited> Go, have fun! I want the full story after, okay?", "can I throw in the leftover rice too?"), "");
  assert.equal(noUnpromptedGoodbye("Talk later!", "what should i get"), "");
  assert.equal(noUnpromptedGoodbye("Bye, go crush it!", "ok I gotta go"), "Bye, go crush it!");
  assert.equal(noUnpromptedGoodbye("Go, have fun! I want the full story after.", "I'm going to a party tonight"), "Go, have fun! I want the full story after.");
  assert.equal(noUnpromptedGoodbye("Throw it in, it gets crispy.", "can I throw in the leftover rice too?"), "Throw it in, it gets crispy.");
  assert.ok(userIsLeaving("ok I gotta go"));
  assert.ok(userIsLeaving("alright I'm heading out"));
  assert.ok(!userIsLeaving("can I throw in the leftover rice too?"));
});

test("a cooking tip is not guilt, and the guilt fallback never says goodbye to a question", () => {
  const ctx = { camera: false, userText: "can I throw in the leftover rice too?" };
  // red on main: "don't leave" / "don't go" matched guilt → the "Go, have fun!" fallback
  assert.equal(guardSentence("Totally, just don't leave it in too long or it gets mushy.", ctx), null);
  assert.equal(guardSentence("Don't go overboard with the garlic though.", ctx), null);
  assert.equal(guardSentence("Don't leave me hanging tonight.", { camera: false, userText: "I'm going out" }), "guilt");
  assert.equal(guardSentence("No, don't go!", { camera: false, userText: "I'm going out" }), "guilt");
  assert.equal(fallbackLine("guilt", "can I throw in the leftover rice too?"), null);
  assert.match(fallbackLine("guilt", "ok I gotta go") ?? "", /have fun/);
});

const jin = { name: "Jin", kind: "human" as const, traits: ["warm"] };
const kitchen = { persona: jin, user: { name: "Summer", profile: "- Likes: Late-night ramen" }, callNumber: 2, gapHours: 24 };

test("eval adapter (session mirror): turn 2 drops the repeat hello, a question never gets the send-off", () => {
  const history = [{ role: "user" as const, text: "hey" }, { role: "assistant" as const, text: "<happy> Oh hey Summer, what's cooking?" }];
  const turn = { kind: "user" as const, text: "ok what do I do first" };
  assert.equal(adapter.post("<happy> Look who finally showed up. Start by dicing the onions.", { scenario: kitchen, history, turn }), "Start by dicing the onions.");
  const rice = { kind: "user" as const, text: "can I throw in the leftover rice too?" };
  assert.equal(adapter.post("<excited> Go, have fun! I want the full story after, okay?", { scenario: kitchen, history, turn: rice }), "");
});

test("the prompt says: greet once, goodbye only when they leave; the no-frame retry line answers without vision", () => {
  const p = buildInstructions({ persona: jin, user: { name: "Summer" }, mode: "chat", style: "v1" });
  assert.match(p, /Greet once per call: never again say hi/);
  assert.match(p, /Say bye only when they're leaving/);
  assert.match(NO_FRAME_RETRY_LINE, /No camera frame/);
  assert.match(NO_FRAME_RETRY_LINE, /never describe how anything looks/);
});
