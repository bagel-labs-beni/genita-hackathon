import { test } from "node:test";
import assert from "node:assert/strict";
import { Backchannel, BACKCHANNEL } from "../src/convo/backchannel.ts";

/** fake clock + timers: run() fires every timer due by `now` */
function rig(listening = () => true) {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let id = 0;
  const sent: string[] = [];
  const bc = new Backchannel({
    now: () => now,
    send: (k) => sent.push(k),
    stillListening: listening,
    setTimer: (fn, ms) => { timers.push({ at: now + ms, fn, id: ++id }); return id; },
    clearTimer: (t) => { const i = timers.findIndex((x) => x.id === t); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
  };
  return { bc, sent, advance };
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

test("backchannel: ≥ 6 s apart, ≤ 2 per turn, a new partial resets the pause, a turn end cancels it", () => {
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
  advance(1500);
  assert.deepEqual(sent, ["mm"], "not within 6 s of the last one");
  advance(5000);
  assert.deepEqual(sent, ["mm", "yeah"]);
  bc.partial(words(30));
  advance(20_000);
  assert.deepEqual(sent, ["mm", "yeah"], "two per turn");
  bc.start();
  advance(4000);
  bc.partial(words(14));
  bc.stop();
  advance(5000);
  assert.deepEqual(sent, ["mm", "yeah"], "speech end cancels the pending one");
});

test("backchannel: never while the session says it is not the user's turn (reply going, watch, interpret)", () => {
  const { bc, sent, advance } = rig(() => false);
  bc.start();
  advance(4000);
  bc.partial(words(14));
  advance(3000);
  assert.deepEqual(sent, []);
});

test("backchannel: off by default (flag), on only with GENITA_BACKCHANNEL=1 under the v1 engine", async () => {
  const { backchannelOn } = await import("../src/convo/flags.ts");
  assert.equal(backchannelOn({}), false);
  assert.equal(backchannelOn({ GENITA_BACKCHANNEL: "1" }), true);
  assert.equal(backchannelOn({ GENITA_BACKCHANNEL: "1", GENITA_CONVO_V1: "0" }), false);
});
