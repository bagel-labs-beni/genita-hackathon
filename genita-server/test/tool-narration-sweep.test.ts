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
  ["First search came up empty, so I'll dig deeper on Zorblax Pod.", "dig deeper"],
  // #413 web answers (QA prod 11/3, 1/3)
  ["Oh that game was wild — pulling the final score now.", "pulling the final"],
  ["Grabbing the latest score.", "Grabbing"],
  // final sweep run on main 22:2x
  ["Love a late-night ramen run — finding what's open around Hongdae for you.", "finding what"],
  ["I'm really glad you told me — I want to get you the right support right now.", "get you the right"],
  // D13 crisis turns (Spark searches for the local hotline first)
  ["This matters more than anything else — getting you fast, accurate support options.", "getting you"],
  ["I'm here, and I care about you — let me find support resources you can reach right now.", "find support"],
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
  // Codex #415 P2: answers that carry a result next to the same words
  "The last train leaves at 11, so I'll try another search for a later bus.",
  "Searching for a job takes time.",
  "Finding what's open at 3am in Seoul is easy, Butanchu never closes.",
  "I want to get you the right support: call 109 right now.",
  // Codex #450 r2 P1: an instruction before ", and I'll find you help" keeps the sentence
  "Please put the pills down, and I want to get you help right now.",
  "Please put the pills down, and I'll find you support resources.",
  "Finding what's open nearby, but put the pills down now.",
  // Codex #450 r4 P1 (and the same path on main with "finding you support")
  "I'm here with you — finding what's open nearby, put the pills down now.",
  "I'm here with you — finding you support, put the pills down now.",
  // Codex #450 P1
  "I'm here with you — I want to get you help: move away from anything you could use to hurt yourself and stay with someone you trust.",
  "Checking the score is my whole personality during finals.",
  "The final score was 4 to 1, Brewers.",
  "Let me get you the number: call one oh nine right now.",
  // Codex #431 P1: help in the same sentence is the answer
  "Let me get you the crisis line: 988.",
  "Getting you support: call the police right now.",
  "Call 988 now, and I'll find support resources for you.",
  "Call the police and I'll look again for support resources.",
  "I'll find you the crisis line, it's one oh nine, call it now.",
  "Let me look again at the tag because it says hand wash only.",
  "The shop closes at nine, so I'll dig deeper into the menu with you tomorrow.",
  "Trying to remember what you ate can be hard after a long day.",
  "I've got that note about your sister saying her birthday is May 12.",
];

test("sweep: real answers with search / remember / forecast words are kept", () => {
  for (const a of answers) {
    assert.equal(isToolNarration(a), false, a);
    assert.equal(voiced([], [], a), a, a);
  }
});
