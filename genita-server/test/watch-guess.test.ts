import { test } from "node:test";
import assert from "node:assert/strict";
import { isGuessLine, reactionScript } from "../src/watch/rules.ts";
import { buildMemoRequest, buildQuickRequest } from "../src/watch/memo.ts";

// AI sweep 11/3: what prod (genita-api) and local watch-sim said over a blurred jumpstyle dance clip
const invented = ["Oh he totally dodged that", "Whoa he's losing balance", "That wobbly one foot hop", "Oh his shoe flew off", "He almost ate it", "About to wipe out", "Oh no his pants", "Uh oh, his shorts"];
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
