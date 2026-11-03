import { test } from "node:test";
import assert from "node:assert/strict";
import { NarrationJudge, isToolNarration } from "../src/text/toolNarration.ts";

/** what the session voices for: [before tool] → tool → [between] → tool → answer → EOF */
function voiced(before: string[], between: string[], answer: string): string {
  const j = new NarrationJudge(true);
  const out: string[] = [];
  for (const s of before) out.push(...j.push(s).speak);
  out.push(...j.onToolCall().speak);
  for (const s of between) out.push(...j.push(s).speak);
  if (between.length) out.push(...j.onToolCall().speak);
  out.push(...j.push(answer).speak);
  out.push(...j.finish().speak);
  return out.join(" ");
}

// AI sweep 11/3 (real Spark, web_search + memory tools on): these were voiced on main
// [line, the part that must never be voiced]
const leaked: [string, string][] = [
  ["First search came up empty, so I'll try again with a broader query.", "broader query"],
  ["Got it — trying to remember that concert we mentioned.", "trying to remember"],
  ["Rain check for Seoul — looking at tomorrow's forecast now.", "looking at"],
  ["Nothing yet, let me try a different search.", "different search"],
  ["I'll search again with different keywords.", "search again"],
  ["Trying to remember which concert that was.", "remember which"],
  ["Looking at today's weather now.", "today's weather"],
  // round 2 on the fix branch (n=18)
  ["Got you, hunting down late-night ramen near Hongdae.", "hunting down"],
  ["Love that, late-night ramen run — finding you the Hongdae spots now.", "finding you"],
  ["Love a late-night ramen mission — pulling together Hongdae spots that are actually open late.", "pulling together"],
  ["You mentioned a concert — I'm pulling up what we discussed.", "pulling up"],
  ["I've got that note about your sister — pulling it up now.", "note about"],
];

test("sweep: retry / recall-in-progress / forecast lookup lines are never voiced around a tool", () => {
  for (const [line, part] of leaked) {
    for (const said of [voiced([], [line], "Brewers took it in five."), voiced([line], [], "Brewers took it in five.")]) {
      assert.ok(!said.includes(part), `${line} → ${said}`);
      assert.ok(said.endsWith("Brewers took it in five."), `${line} → ${said}`);
    }
  }
});

// real answers that share words with the patterns stay
const answers = [
  "My search came up empty, I've never heard of Zorblax Pod.",
  "I'm trying to remember the last time I had good ramen, honestly.",
  "Tomorrow's forecast says rain after lunch, so grab an umbrella.",
  "Try again tomorrow, the shop opens at ten.",
  "Looking at your fridge, kimchi fried rice is right there.",
  "I tried a different ramen place last week and it slapped.",
  "Looking for a job is exhausting, I get it.",
  "Hunting down a vintage jacket like that is a whole sport.",
  "Love that, you're finally going.",
];

test("sweep: real answers with search / remember / forecast words are kept", () => {
  for (const a of answers) {
    assert.equal(isToolNarration(a), false, a);
    assert.equal(voiced([], [], a), a, a);
  }
});
