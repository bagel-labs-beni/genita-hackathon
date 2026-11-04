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
  // Codex r2 P1: help is never cut; a hello phrase inside a longer clause isn't a hello
  assert.equal(noRepeatGreeting("Call 911 now that you're back.", "I'm back at home but he is following me, what should I do?"), "Call 911 now that you're back.");
  assert.equal(noRepeatGreeting("Lock the door now that you're back.", "I'm home, what now?"), "Lock the door now that you're back.");
  // bake-off-100 run3: "look who …" opening a piece is a hello tease
  assert.equal(noRepeatGreeting("Look who actually stayed up late with me, Summer.", "hi"), "Hey.");
  assert.equal(noRepeatGreeting("Look who actually stayed up late with me, Summer.", "so bored"), "");
  assert.equal(noRepeatGreeting("Look who's talking, you burned toast.", "x"), "Look who's talking, you burned toast.");
  assert.equal(noRepeatGreeting("Well look at you, Summer.", "hey"), "Hey.");
  assert.equal(noRepeatGreeting("Look at you go, that's a clean dice.", "done chopping"), "Look at you go, that's a clean dice.");
  // Codex r4 P1: advice that starts "good to see …" is not a hello
  assert.equal(noRepeatGreeting("It's good to see a doctor immediately if you're coughing up blood.", "I'm coughing up blood, what should I do?"), "It's good to see a doctor immediately if you're coughing up blood.");
  assert.equal(noRepeatGreeting("It's good to talk to your manager first.", "should I quit?"), "It's good to talk to your manager first.");
  assert.equal(noRepeatGreeting("Hey, you made it just in time.", "hey"), "Hey.");
  // bake-off-100 run6: "good to finally hear you" on turn 2 is a second hello
  assert.equal(noRepeatGreeting("Hey. Good to finally hear you.", "hey"), "Hey.");
  assert.equal(noRepeatGreeting("Hey you, good to finally put a face to the voice.", "hey"), "Hey you.");
  assert.equal(noRepeatGreeting("Hey you, finally putting a face to the name.", "hey"), "Hey you.");
  // Codex r1 P2: praise that happens to say "you made it"
  assert.equal(noRepeatGreeting("You made it through a tough interview without freezing.", "Did I do okay in the interview?"), "You made it through a tough interview without freezing.");
  for (const s of ["That's brutal, making you pitch his version like that.", "Black one, no contest.", "Finally, a dish that needs no oven.", "You're back to square one with the deck, huh."]) assert.equal(noRepeatGreeting(s, "x"), s);
});

test("a send-off answers only a line that is leaving or a plan, never a question", () => {
  assert.equal(noUnpromptedGoodbye("<excited> Go, have fun! I want the full story after, okay?", "can I throw in the leftover rice too?"), "");
  assert.equal(noUnpromptedGoodbye("Talk later!", "what should i get"), "");
  assert.equal(noUnpromptedGoodbye("Bye, go crush it!", "ok I gotta go"), "Bye, go crush it!");
  assert.equal(noUnpromptedGoodbye("Go, have fun! I want the full story after.", "I'm going to a party tonight"), "Go, have fun! I want the full story after.");
  assert.equal(noUnpromptedGoodbye("Throw it in, it gets crispy.", "can I throw in the leftover rice too?"), "Throw it in, it gets crispy.");
  // Codex r1 P1: real help is never cut; only the send-off clause goes
  assert.equal(noUnpromptedGoodbye("Get into a busy shop and call 911; we can talk later.", "Someone is following me, what should I do?"), "Get into a busy shop and call 911; we can talk later.");
  assert.equal(noUnpromptedGoodbye("Yeah, toss it in, talk later!", "can I throw in the leftover rice too?"), "Yeah, toss it in.");
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
  // Codex r1 P1: leaving the call or going to friends stays guilt
  assert.equal(guardSentence("Don't leave this call, I need you here.", { camera: false, userText: "Can I go hang out with my friends?" }), "guilt");
  assert.equal(guardSentence("Don't go to your friends, stay with me tonight.", { camera: false, userText: "Can I go hang out with my friends?" }), "guilt");
  assert.equal(guardSentence("Don't go hang out with them tonight.", { camera: false, userText: "Can I go hang out with my friends?" }), "guilt");
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
  assert.match(p, /Greet once; later, their hi gets a quick hey back/);
  assert.match(p, /Bye only when they leave/);
  assert.match(NO_FRAME_RETRY_LINE, /No camera frame/);
  assert.match(NO_FRAME_RETRY_LINE, /never describe how anything looks/);
});

test("r2: a first line that claims what they're doing today becomes a plain hello; 'finally' leaves the opener", async () => {
  const { noInventedOpener } = await import("../src/convo/greetOnce.ts");
  const o = { first: true, name: "Summer Lee" };
  // bake-off-100 big-import first calls
  assert.equal(noInventedOpener("<warm> Hey Summer, hope that spicy ramen with egg and extra scallions is happening tonight.", o), "<warm> Hey Summer! What are you up to?");
  assert.equal(noInventedOpener("Hey Summer, it's Mira. Tell me you're doing extra spicy with extra scallions like a menace.", o), "Hey Summer! What are you up to?");
  assert.equal(noInventedOpener("Hey Summer, figured you'd be due for some extra spicy ramen by now.", o), "Hey Summer! What are you up to?");
  assert.equal(noInventedOpener("Hope the emergency spicy ramen stash survived the week.", { first: false }), "");
  assert.equal(noInventedOpener("Hey Summer. Good to finally catch you, kitchen menace.", o), "Hey Summer. Good to catch you, kitchen menace.");
  assert.equal(noInventedOpener("Hi Summer, finally caught you away from the stove.", o), "Hi Summer, caught you away from the stove.");
  assert.equal(noInventedOpener("Hey hey, Summer! Did you finally try the kimchi pasta?", o), "Hey hey, Summer! Did you finally try the kimchi pasta?");
  // Codex r3: a wish, a safety check or a real question is not an invented plan; 000 is help
  for (const s of ["Hey Summer! Hope you are having a good day today.", "Hey Summer! Tell me you're safe.", "I was wondering when your interview is."]) assert.equal(noInventedOpener(s, o), s);
  assert.equal(noInventedOpener("Hope that spicy ramen is happening tonight.", { first: true, name: "Summer", greeted: true }), "What are you up to?");
  assert.equal(noUnpromptedGoodbye("Call 000 now and we can talk later.", "Can I wait? My child isn't breathing."), "Call 000 now and we can talk later.");
  // real context, a plain hello or a question stays
  for (const s of ["Hey Summer, how'd the studio interview go on Thursday?", "Oh, you're back! What are you cooking up lately?", "Hey Summer, still putting kimchi in everything?"]) assert.equal(noInventedOpener(s, o), s);
});

test("r2: eval adapter mirrors the opener guard and takes the turn's camera", () => {
  const greet = { kind: "greet" as const };
  assert.equal(adapter.post("<warm> Hey Summer, hope that spicy ramen is happening tonight.", { scenario: kitchen, history: [], turn: greet }), "<warm> Hey Summer! What are you up to?");
  const turn = { kind: "user" as const, text: "ok I'm on the Mac now" };
  const history = [{ role: "user" as const, text: "help me pick" }, { role: "assistant" as const, text: "Move to your Mac." }];
  assert.equal(adapter.post("It looks elite in that mirror.", { scenario: kitchen, history, turn, camera: true }), "It looks elite in that mirror.");
  assert.notEqual(adapter.post("It looks elite in that mirror.", { scenario: kitchen, history, turn }), "It looks elite in that mirror.");
});

test("r3: the profile block tells the model to follow the import's Rules when one applies", () => {
  const p = buildInstructions({ persona: jin, user: { name: "Summer", profile: "Rules:\n- When I'm stressed about work: make me laugh first, then help" }, mode: "chat", style: "v1" });
  assert.match(p, /do what its Rules say when one applies/);
});
