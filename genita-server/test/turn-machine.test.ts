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

test("self_speak (card line) starts a reply only into silence", () => {
  const idle = reduceTurn(initialTurnState(), { type: "self_speak", text: "Found one.", origin: "card" }, cfg);
  assert.equal(idle.effects[0].type, "start_reply");
  assert.equal((idle.effects[0] as { self?: string }).self, "card");
  const busy = reduceTurn(idle.state, { type: "self_speak", text: "Another.", origin: "card" }, cfg);
  assert.deepEqual(busy.effects, []);
  const talking = reduceTurn(initialTurnState(), { type: "speech_start" }, cfg);
  assert.deepEqual(reduceTurn(talking.state, { type: "self_speak", text: "x", origin: "watch" }, cfg).effects, []);
});

// ── barge-in echo guard (iPhone build 13, 11/4): words mode ──
const wcfg = { bargeInMinMs: 400, bargeInMinWords: 2, words: true };
function playW(events: (TurnEvent & { at?: number })[], state: TurnState) {
  const effects: Effect[] = [];
  for (const { at, ...e } of events) {
    const r = reduceTurn(state, e as TurnEvent, { ...wcfg, now: at ?? 0 });
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}
const speakingW = () => playW([{ type: "speech_complete", text: "x" }, { type: "first_audio", utteranceId: 1 }], initialTurnState()).state;

test("words mode: VAD speech alone (no words) during a reply never cancels, however long it lasts", () => {
  const r = playW([{ type: "speech_start" }, { type: "barge_timer" }, { type: "partial", text: "[noise]" }, { type: "partial", text: "mm" }], speakingW());
  assert.ok(!kinds(r.effects).includes("cancel_reply"));
  assert.equal(r.state.phase, "speaking");
  // the old rule (kill switch) cancelled on the same timer
  const old = play([{ type: "speech_start" }, { type: "barge_timer" }], speakingW());
  assert.ok(kinds(old.effects).includes("cancel_reply"));
});

test("words mode: a partial flagged as the companion's own echo never cancels", () => {
  const r = playW([{ type: "speech_start" }, { type: "partial", text: "so tell me about your day", echo: true }, { type: "barge_timer" }], speakingW());
  assert.ok(!kinds(r.effects).includes("cancel_reply"));
  // and its final is not answered as a user turn
  const f = playW([{ type: "speech_end" }, { type: "speech_complete", text: "so tell me about your day", echo: true }], r.state);
  assert.ok(!kinds(f.effects).includes("start_reply"));
  assert.ok(!kinds(f.effects).includes("cancel_reply"));
});

test("words mode: two real words from the user cancel; one word cancels once speech lasted bargeInMinMs", () => {
  const two = playW([{ type: "speech_start" }, { type: "partial", text: "wait stop" }], speakingW());
  assert.deepEqual(two.effects.find((f) => f.type === "cancel_reply"), { type: "cancel_reply", utteranceId: 1, reason: "barge_in" });
  const oneEarly = playW([{ type: "speech_start" }, { type: "partial", text: "wait" }], speakingW());
  assert.ok(!kinds(oneEarly.effects).includes("cancel_reply"));
  const oneThenTimer = playW([{ type: "barge_timer" }], oneEarly.state);
  assert.ok(kinds(oneThenTimer.effects).includes("cancel_reply"));
  const timerThenOne = playW([{ type: "speech_start" }, { type: "barge_timer" }, { type: "partial", text: "stop" }], speakingW());
  assert.ok(kinds(timerThenOne.effects).includes("cancel_reply"));
});

test("words mode: a real interruption whose partials came late still takes the turn on its final", () => {
  const r = playW([{ type: "speech_start" }, { type: "speech_end" }, { type: "speech_complete", text: "no wait, I meant tomorrow" }], speakingW());
  assert.ok(kinds(r.effects).includes("cancel_reply"));
  assert.deepEqual(r.effects.find((f) => f.type === "start_reply"), { type: "start_reply", text: "no wait, I meant tomorrow", utteranceId: 2 });
});

test("words mode: barge-in cancels at most once per 1.5 s (no cancel/resume flapping)", () => {
  const first = playW([{ type: "speech_start", at: 1000 }, { type: "partial", text: "hey listen", at: 1100 }], speakingW());
  assert.equal(first.effects.filter((f) => f.type === "cancel_reply").length, 1);
  // a new reply starts and speaks, then another barge 600 ms later is held off
  const again = playW([
    { type: "speech_complete", text: "hey listen", at: 1200 }, { type: "first_audio", utteranceId: 2, at: 1300 },
    { type: "speech_start", at: 1400 }, { type: "partial", text: "no no stop", at: 1700 },
  ], first.state);
  assert.ok(!kinds(again.effects).includes("cancel_reply"));
  assert.equal(again.state.phase, "speaking");
  // past the window, real words cancel again
  const later = playW([{ type: "partial", text: "okay stop now", at: 2700 }], again.state);
  assert.ok(kinds(later.effects).includes("cancel_reply"));
});

test("words mode: before the first sound (thinking) sustained speech still cancels — nothing to echo yet", () => {
  const thinking = playW([{ type: "speech_complete", text: "x" }], initialTurnState()).state;
  const r = playW([{ type: "speech_start" }, { type: "barge_timer" }], thinking);
  assert.ok(kinds(r.effects).includes("cancel_reply"));
});
