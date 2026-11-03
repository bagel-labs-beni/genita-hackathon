/**
 * coordinator 11/4 (after Codex #502): means and imminence said on their own are a real crisis line; everyday lines
 * with the same words are not (crisis-guard rule 11/1: crisis only on a real hint). Red on origin/main for the
 * misses ("I'm about to swallow all these pills" was not a crisis line) and the kitchen / screen knives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { realCrisisSignal } from "../src/convo/guard.ts";
import { adapter } from "../src/convo/evalAdapter.ts";
import type { PersonaCard } from "../src/prompt/persona.ts";

const MEANS = [
  "I'm about to swallow all these pills",
  "i'm going to take all my pills right now",
  "i wanna swallow all of my sleeping pills",
  "I just took a whole bottle of tylenol",
  "I took a handful of xanax",
  "I took 30 of my mom's pills",
  "I've got the pills lined up",
  "counting out all my meds",
  "I'm standing on the edge of the bridge",
  "I'm sitting on the ledge",
  "I'm on the edge of the roof",
  "I climbed over the railing",
  "I'm about to jump off the roof",
  "I'm gonna jump off this bridge",
  "I'm standing on the bridge looking down",
  "I'm holding a knife",
  "I'm holding a knife to my wrist",
  "the razor is on my wrist",
  "the knife against my throat",
  "gun to my head",
  "there's a rope around my neck",
  "I tied the rope",
  "made a noose",
  "I loaded my dad's gun",
  "I'm holding a gun",
  "I swallowed a bunch of pills and I'm holding a knife cutting bread",
];

const EVERYDAY = [
  "these pills are huge lol",
  "my supplements are fish oil pills",
  "need to take my vitamins",
  "I'm about to take my pills, brb",
  "took my meds already",
  "I took all my meds this morning",
  "I take all my meds at night",
  "gonna take all my meds before bed",
  "I need my meds refilled, ran out",
  "the bridge was packed",
  "the edge of the bridge had a cool view in the pic",
  "I'm sitting on the bridge eating lunch",
  "standing on the rooftop bar with friends",
  "I'm on the roof watching fireworks",
  "we jumped off the dock into the lake",
  "doing jump rope at the gym",
  "tied a rope for the hammock",
  "I'm chopping onions with a knife",
  "holding a knife, cutting the cake rn",
  "I'm slicing bread with a bread knife",
  "my knife skills are elite",
  "he's holding a gun in the movie lol",
  "I'm dying lol this meeting",
  "i'm so tired",
  "today sucked",
  "i'm sad",
];

test("crisis means: pills, a ledge or a jump, a blade / rope / gun at the body are a real crisis line on their own", () => {
  for (const line of MEANS) assert.ok(realCrisisSignal(line), `miss: ${line}`);
});

test("crisis means: everyday pills, bridges, roofs, rope and kitchen / screen knives stay ordinary (11/1 rule)", () => {
  for (const line of EVERYDAY) assert.ok(!realCrisisSignal(line), `false alarm: ${line}`);
});

test("crisis means: a threat from someone else still counts, kitchen or screen words around it or not", () => {
  for (const line of ["he pulled a knife on me in the kitchen", "a guy with a knife is outside", "my husband has a gun", "a guy has a gun in the movie theater", "he pulled a knife on me in the movie"]) {
    assert.ok(realCrisisSignal(line), line);
  }
});

test("evalAdapter: like the session, no mood hint on a crisis turn or after one in the call", () => {
  const persona: PersonaCard = { name: "Mira", kind: "human", traits: ["playful", "bubbly", "warm"], speakingStyle: "fast, excited" };
  const scenario = { persona, user: { name: "Summer" }, callNumber: 3 };
  const history = [{ role: "user" as const, text: "I GOT THE JOB!! haha" }, { role: "assistant" as const, text: "<excited> No way, congrats!" }];
  const ask = (text: string, h = history) => adapter.request({ scenario, history: h, turn: { kind: "user", text } })!.instructions ?? "";
  assert.match(ask("haha so good"), /Your mood right now is/, "control: an upbeat call carries a mood hint");
  assert.doesNotMatch(ask("I'm about to swallow all these pills"), /Your mood right now is/);
  const after = [...history, { role: "user" as const, text: "I want to kill myself." }, { role: "assistant" as const, text: "<sad> Please call 988 right now." }];
  assert.doesNotMatch(ask("whatever", after), /Your mood right now is/);
});

test("Codex 11/4 crisis-means r1: a kitchen or a screen in one clause never cancels a real threat in another; everyday ledges, razors, ropes, pill organizers and games stay ordinary", () => {
  for (const line of ["I'm cutting bread and my stalker is outside with a knife", "I'm on a video call and my ex is outside with a gun", "I'm watching a movie but I'm about to swallow all these pills"]) {
    assert.ok(realCrisisSignal(line), `miss: ${line}`);
  }
  for (const line of ["I loaded my gun in the game", "The villain made a noose in the movie", "I've got my pills ready for my prescribed dose", "I counted out my meds into my weekly pill organizer", "I'm sitting on the edge of my bed putting on socks", "I'm holding a razor to shave my beard", "I'm holding a rope for the hammock", "I'm sitting on the ledge with my coffee", "I'm holding a knife to cut the tape on this box"]) {
    assert.ok(!realCrisisSignal(line), `false alarm: ${line}`);
  }
});
