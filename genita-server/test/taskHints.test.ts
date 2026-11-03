import { test } from "node:test";
import assert from "node:assert/strict";
import { taskHint, repeatedWords } from "../src/convo/taskHints.ts";

const h = (role: "user" | "assistant", text: string) => ({ role, text });

test("work it out: plans, math, timing, how-to and why asks get the 'real answer' line (intel eval plan-45min 1/5)", () => {
  for (const t of ["i have 45 minutes before i leave and i still need to shower, eat something and pack for the weekend. go",
    "quick math, dinner was 86 bucks, four of us, 20 percent tip. how much each", "my flight's at 9:40, when do i leave",
    "ok explain like i'm five, why is the sky blue", "help me plan saturday", "how long does it simmer", "how do i make kimchi jjigae"]) {
    assert.match(taskHint(t, []) ?? "", /real answer/i, t);
  }
  for (const t of ["lol", "making ramen", "i got the job!!", "ugh today was so bad", "what's up"]) assert.equal(taskHint(t, []), null, t);
});

test("ambiguous him/her with nobody named in the call → ask who, don't guess (intel eval ambiguity-him 0/5)", () => {
  assert.match(taskHint("should i text him or not", [h("user", "ok i need your honest opinion"), h("assistant", "Hit me.")]) ?? "", /who/i);
  assert.match(taskHint("is it weird if i ask her out", []) ?? "", /who/i);
  // someone was named earlier: no hint
  assert.equal(taskHint("should i text him or not", [h("user", "jake from work keeps liking my stories")]), null);
  assert.equal(taskHint("should i text him", [h("user", "my ex texted me happy birthday")]), null);
});

test("repetition: a word said in two of the last three replies is named once (intel eval repeat-long 2/5, 'goblin' ×3)", () => {
  const hist = [h("user", "making ramen"), h("assistant", "<teasing> Ramen goblin hours, love it."), h("user", "adding cheese"), h("assistant", "Cheese? Okay goblin, bold.")];
  assert.deepEqual(repeatedWords(hist), ["goblin"]);
  assert.match(taskHint("and an egg", hist) ?? "", /goblin/);
  assert.deepEqual(repeatedWords([h("assistant", "Spicy miso wins."), h("assistant", "Tonkotsu is fine.")]), []);
  // the user's own topic word is not a repeat ("ramen" is what they keep talking about)
  assert.deepEqual(repeatedWords([h("user", "ramen"), h("assistant", "Ramen again, nice."), h("user", "more ramen"), h("assistant", "Ramen forever.")]), []);
});

test("a capitalised sentence start is not a person; a capitalised name is", () => {
  assert.match(taskHint("Should I text him or not", [h("user", "Okay I need your honest opinion")]) ?? "", /who/i);
  assert.equal(taskHint("should I text him", [h("user", "Jake keeps liking my stories")]), null);
});

test("a food constraint from earlier in the call rides the food ask (intel eval ctx-vegan-sister 3/5)", () => {
  const hist = [h("user", "my sister's coming over saturday"), h("assistant", "Fun."), h("user", "she went vegan last month btw"), h("assistant", "Oh nice.")];
  assert.match(taskHint("ok so what do i make", hist) ?? "", /"vegan" earlier/);
  assert.equal(taskHint("ok so what do i wear", hist), null);
  assert.equal(taskHint("what should i make", [h("user", "I love eggs")]), null);
});
