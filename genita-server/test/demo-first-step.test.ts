/**
 * Demo S3: "I see onions, tomatoes, red bell peppers, and garlic. How about a tomato and pepper soup?
 * Let's start by chopping the onions." The fridge line now ends with the recipe's first step, only when
 * there is a dish and something was confirmed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fridgeLine } from "../src/finds/pipeline.ts";

const have = (name: string) => ({ id: name, name, tier: "have" as const, from: "camera" as const });
const maybe = (name: string) => ({ id: name, name, tier: "maybe" as const, from: "both" as const });
const COUNTER = [have("onions"), have("tomatoes"), have("red bell peppers"), have("garlic")];

test("first step follows the dish", () => {
  assert.equal(
    fridgeLine(COUNTER, "Tomato and pepper soup", "Chop the onions and garlic."),
    "I can see onions, tomatoes, red bell peppers, and garlic. You could make tomato and pepper soup. First, chop the onions and garlic.",
  );
});

test("first step after the 'if you have' part; missing period added; whitespace trimmed", () => {
  assert.equal(
    fridgeLine([have("eggs"), maybe("kimchi")], "kimchi fried rice", "  Fry the kimchi  "),
    "I can see eggs. You could make kimchi fried rice, if you have kimchi. First, fry the kimchi.",
  );
});

test("an acronym or 'I' at the start keeps its capital", () => {
  assert.equal(fridgeLine([have("eggs")], "omelette", "BBQ the peppers."), "I can see eggs. You could make omelette. First, BBQ the peppers.");
});

test("no step, no dish, or nothing confirmed: the line is as before", () => {
  assert.equal(fridgeLine(COUNTER.slice(0, 2), "soup"), "I can see onions and tomatoes. You could make soup.");
  assert.equal(fridgeLine(COUNTER.slice(0, 2), null, "Chop the onions."), "I can see onions and tomatoes.");
  assert.equal(fridgeLine([maybe("kimchi")], "kimchi stew", "Chop the kimchi."), "I can't say for sure what's in there yet. Tap what you have on the card — kimchi stew might work.");
  assert.equal(fridgeLine(COUNTER.slice(0, 1), "soup", "   "), "I can see onions. You could make soup.");
});
