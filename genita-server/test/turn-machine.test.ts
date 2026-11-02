import { test } from "node:test";
import assert from "node:assert/strict";
import { initialTurnState, reduceTurn, type TurnEvent, type TurnState, type Effect } from "../src/session/turnMachine.ts";

const cfg = { bargeInMinMs: 400, bargeInMinWords: 2 };

function play(events: TurnEvent[], state: TurnState = initialTurnState()) {
  const effects: Effect[] = [];
  for (const e of events) {
    const r = reduceTurn(state, e, cfg);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}
const kinds = (fx: Effect[]) => fx.map((f) => f.type);

test("a finished user turn while listening starts a reply and goes to thinking", () => {
  const { state, effects } = play([{ type: "speech_start" }, { type: "speech_complete", text: "hi there" }]);
  assert.equal(state.phase, "thinking");
  assert.equal(state.utteranceId, 1);
  assert.deepEqual(effects.find((f) => f.type === "start_reply"), { type: "start_reply", text: "hi there", utteranceId: 1 });
});

test("first audio moves thinking to speaking, reply_done back to listening", () => {
  const { state, effects } = play([
    { type: "speech_complete", text: "hi" },
    { type: "first_audio", utteranceId: 1 },
    { type: "reply_done", utteranceId: 1 },
  ]);
  assert.equal(state.phase, "listening");
  assert.deepEqual(
    effects.filter((f) => f.type === "emit_state").map((f) => (f as { phase: string }).phase),
    ["thinking", "speaking", "listening"],
  );
});

test("speechStart while speaking arms the barge-in timer; the timer firing cancels TTS and Spark", () => {
  const speaking = play([{ type: "speech_complete", text: "tell me a story" }, { type: "first_audio", utteranceId: 1 }]).state;
  const armed = play([{ type: "speech_start" }], speaking);
  assert.deepEqual(kinds(armed.effects), ["arm_barge_timer"]);
  assert.equal(armed.state.phase, "speaking");
  const fired = play([{ type: "barge_timer" }], armed.state);
  assert.deepEqual(kinds(fired.effects), ["cancel_reply", "emit_state", "emit_state"]);
  assert.deepEqual(fired.effects[0], { type: "cancel_reply", utteranceId: 1, reason: "barge_in" });
  assert.equal(fired.state.phase, "listening");
});

test("two words of partial transcript cancel before the timer", () => {
  const speaking = play([{ type: "speech_complete", text: "x" }, { type: "first_audio", utteranceId: 1 }]).state;
  const r = play([{ type: "speech_start" }, { type: "partial", text: "wait stop" }], speaking);
  assert.ok(kinds(r.effects).includes("cancel_reply"));
});

test("a backchannel ('yeah') that ends before the threshold does not cancel and does not start a reply", () => {
  const speaking = play([{ type: "speech_complete", text: "x" }, { type: "first_audio", utteranceId: 1 }]).state;
  const r = play(
    [{ type: "speech_start" }, { type: "partial", text: "yeah" }, { type: "speech_end" }, { type: "speech_complete", text: "Yeah." }, { type: "barge_timer" }],
    speaking,
  );
  assert.ok(!kinds(r.effects).includes("cancel_reply"));
  assert.ok(!kinds(r.effects).includes("start_reply"));
  assert.equal(r.state.phase, "speaking");
});

test("after a barge-in the interrupting turn becomes the next reply", () => {
  const speaking = play([{ type: "speech_complete", text: "x" }, { type: "first_audio", utteranceId: 1 }]).state;
  const r = play([{ type: "speech_start" }, { type: "barge_timer" }, { type: "speech_complete", text: "actually, wait" }], speaking);
  assert.equal(r.state.phase, "thinking");
  assert.equal(r.state.utteranceId, 2);
  assert.deepEqual(r.effects.at(-2), { type: "start_reply", text: "actually, wait", utteranceId: 2 });
});

test("bargeInMinMs 0 cancels on speechStart immediately", () => {
  const speaking = play([{ type: "speech_complete", text: "x" }, { type: "first_audio", utteranceId: 1 }]).state;
  const r = reduceTurn(speaking, { type: "speech_start" }, { bargeInMinMs: 0, bargeInMinWords: 2 });
  assert.equal(r.effects[0].type, "cancel_reply");
});

test("typed text while thinking cancels the old reply and starts a new one", () => {
  const thinking = play([{ type: "speech_complete", text: "x" }]).state;
  const r = play([{ type: "text", text: "never mind" }], thinking);
  assert.deepEqual(r.effects[0], { type: "cancel_reply", utteranceId: 1, reason: "text" });
  assert.deepEqual(r.effects.find((f) => f.type === "start_reply"), { type: "start_reply", text: "never mind", utteranceId: 2 });
});

test("client barge_in while listening is a no-op", () => {
  const r = reduceTurn(initialTurnState(), { type: "client_barge_in" }, cfg);
  assert.deepEqual(r.effects, []);
});

test("events for a stale utterance are ignored", () => {
  const thinking = play([{ type: "speech_complete", text: "a" }, { type: "text", text: "b" }]).state; // now utterance 2
  const r = play([{ type: "first_audio", utteranceId: 1 }, { type: "reply_done", utteranceId: 1 }], thinking);
  assert.equal(r.state.phase, "thinking");
  assert.deepEqual(r.effects, []);
});

test("an empty final transcript does not start a reply", () => {
  const r = play([{ type: "speech_start" }, { type: "speech_complete", text: "  " }]);
  assert.equal(r.state.phase, "listening");
  assert.ok(!kinds(r.effects).includes("start_reply"));
});

test("announce starts a reply only into silence", () => {
  const idle = reduceTurn(initialTurnState(), { type: "announce", text: "Found one." }, cfg);
  assert.equal(idle.effects[0].type, "start_reply");
  assert.equal((idle.effects[0] as { announce?: boolean }).announce, true);
  const busy = reduceTurn(idle.state, { type: "announce", text: "Another." }, cfg);
  assert.deepEqual(busy.effects, []);
  const talking = reduceTurn(initialTurnState(), { type: "speech_start" }, cfg);
  assert.deepEqual(reduceTurn(talking.state, { type: "announce", text: "x" }, cfg).effects, []);
});
