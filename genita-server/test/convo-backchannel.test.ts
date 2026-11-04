import { test } from "node:test";
import assert from "node:assert/strict";
import { Backchannel, BACKCHANNEL } from "../src/convo/backchannel.ts";

/** fake clock + timers: run() fires every timer due by `now` */
function rig(listening = () => true, extra: { blocked?: () => boolean; companionDoneAt?: () => number } = {}) {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let id = 0;
  const sent: string[] = [];
  const bc = new Backchannel({
    now: () => now,
    send: (k) => sent.push(k),
    stillListening: listening,
    ...extra,
    setTimer: (fn, ms) => { timers.push({ at: now + ms, fn, id: ++id }); return id; },
    clearTimer: (t) => { const i = timers.findIndex((x) => x.id === t); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
  };
  return { bc, sent, advance, now: () => now };
}
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

test("backchannel: a 1.2 s pause mid-sentence in a long turn gets one 'mm'; short turns and sentence ends get nothing", () => {
  const { bc, sent, advance } = rig();
  bc.start();
  advance(4000);
  bc.partial(words(6));
  advance(2000);
  assert.deepEqual(sent, [], "under 12 words");
  bc.partial(words(14));
  advance(BACKCHANNEL.pauseMs - 1);
  assert.deepEqual(sent, []);
  advance(1);
  assert.deepEqual(sent, ["mm"]);
  bc.partial(words(20) + ".");
  advance(5000);
  assert.deepEqual(sent, ["mm"], "a finished sentence is the turn ending, not a pause");
});

// 11/4 18:5x (Chelsea, TF 341: beats at odd times): one per turn — never twice in a row
test("backchannel: one per turn (never twice in a row), a new partial resets the pause, a turn end cancels it", () => {
  const { bc, sent, advance } = rig();
  bc.start();
  advance(4000);
  bc.partial(words(13));
  advance(600);
  bc.partial(words(15)); // still talking: the pause restarts
  advance(1000);
  assert.deepEqual(sent, []);
  advance(200);
  assert.deepEqual(sent, ["mm"]);
  bc.partial(words(18));
  advance(25_000);
  bc.partial(words(30));
  advance(25_000);
  assert.deepEqual(sent, ["mm"], "one per turn, even 50 s later");
  bc.start();
  advance(4000);
  bc.partial(words(14));
  bc.stop();
  advance(5000);
  assert.deepEqual(sent, ["mm"], "speech end cancels the pending one");
  bc.start();
  advance(4000);
  bc.partial(words(14));
  advance(BACKCHANNEL.pauseMs);
  assert.deepEqual(sent, ["mm", "yeah"], "a later turn, past the 20 s gap, gets its one");
});

test("backchannel: never within 1.5 s of the reply starting (end-of-turn hold), never while a find/search runs, never right after the companion spoke", () => {
  // the hold ends 2.4 s in: a cue at 1.05 s would land 1.35 s before the reply
  const a = rig();
  a.bc.start(); a.advance(4000);
  a.bc.held(words(14), 1050, 2400);
  a.advance(3000);
  assert.deepEqual(a.sent, [], "too close to the reply");
  // a long hold leaves room: the cue goes
  const b = rig();
  b.bc.start(); b.advance(4000);
  b.bc.held(words(14), 1050, 4000);
  b.advance(1050);
  assert.deepEqual(b.sent, ["mm"]);
  // a find or a search is running: no cue
  let busy = true;
  const c = rig(() => true, { blocked: () => busy });
  c.bc.start(); c.advance(4000);
  c.bc.partial(words(14));
  c.advance(3000);
  assert.deepEqual(c.sent, [], "search pending");
  busy = false;
  // the companion finished speaking 1 s ago: no cue (3 s quiet after the companion first)
  let doneAt = -Infinity;
  const d = rig(() => true, { companionDoneAt: () => doneAt });
  d.bc.start(); d.advance(4000);
  doneAt = 4000 + BACKCHANNEL.pauseMs - 1000;
  d.bc.partial(words(14));
  d.advance(BACKCHANNEL.pauseMs);
  assert.deepEqual(d.sent, [], "right after the companion spoke");
});

test("backchannel: never while the session says it is not the user's turn (reply going, watch, interpret)", () => {
  const { bc, sent, advance } = rig(() => false);
  bc.start();
  advance(4000);
  bc.partial(words(14));
  advance(3000);
  assert.deepEqual(sent, []);
});

test("backchannel: on by default (11/4), GENITA_BACKCHANNEL=0 turns it off, never without the v1 engine", async () => {
  const { backchannelOn } = await import("../src/convo/flags.ts");
  assert.equal(backchannelOn({}), true);
  assert.equal(backchannelOn({ GENITA_BACKCHANNEL: "0" }), false);
  assert.equal(backchannelOn({ GENITA_BACKCHANNEL: "1" }), true);
  assert.equal(backchannelOn({ GENITA_BACKCHANNEL: "1", GENITA_CONVO_V1: "0" }), false);
});
