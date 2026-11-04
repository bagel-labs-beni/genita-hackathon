import { test } from "node:test";
import assert from "node:assert/strict";
import { unseenToHeard } from "../src/convo/unseenSight.ts";

test("b10 gate: nothing seen → a sight word about the thing becomes a hearing one; 'looks like' and a seen frame stay", () => {
  assert.equal(unseenToHeard("That looks dangerously good. Slurp it before it gets soggy.", false), "That sounds dangerously good. Slurp it before it gets soggy.");
  assert.equal(unseenToHeard("Hey, good to see you again. Rough night, huh?", false), "Hey, good to hear from you again. Rough night, huh?");
  assert.equal(unseenToHeard("It's looking great already.", false), "It's sounding great already.");
  assert.equal(unseenToHeard("Those really look amazing.", false), "Those really sound amazing.");
  assert.equal(unseenToHeard("That looks like a plan.", false), "That looks like a plan.");
  assert.equal(unseenToHeard("I'm looking forward to it.", false), "I'm looking forward to it.");
  assert.equal(unseenToHeard("That looks dangerously good.", true), "That looks dangerously good.");
});
