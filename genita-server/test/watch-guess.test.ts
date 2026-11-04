import { test } from "node:test";
import assert from "node:assert/strict";
import { isGuessLine, reactionScript } from "../src/watch/rules.ts";
import { buildMemoRequest, buildQuickRequest } from "../src/watch/memo.ts";

// AI sweep 11/3: what prod (genita-api) and local watch-sim said over a blurred jumpstyle dance clip
const invented = ["Oh he totally dodged that", "Whoa he's losing balance", "That wobbly one foot hop", "Oh his shoe flew off", "He almost ate it", "About to wipe out", "Oh no his pants", "Uh oh, his shorts", "There goes his shoe"];
// what the same runs said that matched the clip
const grounded = ["That monster dunk", "Going up for dunk", "Clean skate flip right there", "stuck that landing clean", "Pancake stuck to ceiling", "cat took over laptop", "That extra spicy bite", "Those kicks are insane", "He fell, total wipeout", "That little hop dance", "Oh no, the pancake", "His shoes are fire", "He slipped and fell", "He tripped over the hurdle", "Oh no, his cake", "His shoes light up"];

test("watch: a reaction that guesses balance, dodging or things flying off is never said", () => {
  for (const line of invented) {
    assert.equal(isGuessLine(line), true, line);
    assert.equal(reactionScript("funny", line), null, line);
  }
  for (const line of grounded) {
    assert.equal(isGuessLine(line), false, line);
    assert.ok(reactionScript("surprising", line), line);
  }
});

test("watch: quick look and memo prompts say a blurred dance move is still the move", () => {
  const quick = buildQuickRequest({ companion: { name: "Juno" }, frames: [], heard: [] });
  assert.match(String(quick.instructions), /a blur is the move/);
  assert.match(String(quick.instructions), /no balance or dodging/);
  const memo = buildMemoRequest({ companion: { name: "Juno", traits: [] }, memo: [], lines: [], frames: [], names: {}, blank: false } as never);
  assert.match(String(memo.instructions), /mid-move frame is still the move/);
});

// QA build 6 (11/4): a solo drive-and-dunk was called an "alley-oop" (needs a lob pass two frames can't show)
test("watch: a named play or trick is never said as written; the plain line goes out on time instead", async () => {
  const { isJargonLine } = await import("../src/watch/rules.ts");
  const named = ["What an alley-oop!", "Alley oop slam", "Sick kickflip", "Clean heelflip", "Nice crossover", "Buzzer beater!", "That three-pointer though", "Tomahawk jam", "Did a 360", "Huge backflip"];
  for (const line of named) {
    assert.equal(isJargonLine(line), true, line);
    assert.equal(reactionScript("surprising", line), "<surprised> [surprised] Whoa, no way!", line);
  }
  assert.equal(reactionScript("funny", "Alley-oop fail"), "<laugh> [smileopen] [laughs] Haha, no way");
  for (const line of grounded) assert.equal(isJargonLine(line), false, line);
  for (const line of ["He dunked it himself", "Landed that flip", "Three of them dancing", "Pan's on fire", "He just threw it down"]) {
    assert.equal(isJargonLine(line), false, line);
  }
});

test("watch: the quick look and the memo are told to say the plain action, never a named play or trick", () => {
  const quick = buildQuickRequest({ companion: { name: "Juno" }, frames: [], heard: [] });
  assert.match(String(quick.instructions), /no named play or trick: say the plain action/);
  const memo = buildMemoRequest({ companion: { name: "Juno", traits: [] }, memo: [], lines: [], frames: [], names: {}, blank: false } as never);
  assert.match(String(memo.instructions), /never a named play or trick/);
});

// camera proxy 11/4: a TV dunk in two camera frames got "caught it midair" (a lob the frames never showed)
test("camera turns (both prompt styles) say: name only actions seen in the frames, never infer a play", async () => {
  const { buildInstructions } = await import("../src/prompt/persona.ts");
  const mina = { name: "Mina", kind: "human", traits: ["warm"], speakingStyle: "short" } as never;
  for (const style of ["v1", "legacy"] as const) {
    const s = buildInstructions({ persona: mina, mode: "chat", style, cameraAttached: true } as never);
    assert.match(s, /Name only actions you can see happening in the frames; never infer what happened before or between them/, style);
    assert.doesNotMatch(buildInstructions({ persona: mina, mode: "chat", style } as never), /Name only actions you can see/, `${style} without camera`);
  }
});

// CW-03 11/4: "closed the doors on her", "right in the doorway" — answers added what the frames never showed
test("question context: a joke never adds an event, object or line; the memo notes who comes in", async () => {
  const { buildQuestionContext } = await import("../src/watch/memo.ts");
  const q = buildQuestionContext({ source: "YouTube", memo: [], lines: [], names: new Map(), frames: ["data:image/jpeg;base64,AA"], blank: false });
  assert.match(q.instructions, /never adds an event, object or line that isn't in the frames or lines/);
  const memo = buildMemoRequest({ companion: { name: "Juno", traits: [] }, memo: [], lines: [], frames: [], names: {}, blank: false } as never);
  assert.match(String(memo.instructions), /who comes in or leaves/);
});
