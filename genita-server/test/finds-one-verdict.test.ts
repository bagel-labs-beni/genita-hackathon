import { test } from "node:test";
import assert from "node:assert/strict";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore } from "../src/finds/store.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";
import type { ServerEvent } from "../src/protocol.ts";

// Demo S4 build 9 (4/6 runs): "Which one looks better, the white one or the black one?" was answered out loud
// ("Black one wins, Summer…"), then the outfit card landed 11–14 s later and its own line was said again
// ("Black one wins, no contest cutie."). One question gets one verdict: the card agrees, so it stays silent.
const OUTFIT = '{"pick":0,"title":"Wear the black one.","taste":"Clean minimal vibe you love","situation":"","options":[{"label":"Black jacket","frame":0},{"label":"White trench","frame":1}],"why":["Sharp dark contrast.","Crisp and light."],"ask":[],"say":"Black one wins, no contest cutie."}';
const FRAMES = ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"];

function runner(said: string[], events: ServerEvent[] = []) {
  const vendors = {
    async spark() { return { text: OUTFIT, output: [] }; },
    async *sparkStream() {},
    async sam() { return []; },
    async image() { return null; },
  } as unknown as FindsVendors;
  const r = new FindsRunner(
    { vendors, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds", productPrefetch: false },
    { emit: (e) => events.push(e), announce: (t) => said.push(t), log() {}, now: () => performance.now() },
  );
  r.configure({ owner: "acct-a", memories: [] });
  return r;
}

test("S4 one verdict: an outfit card that lands after the spoken answer is shown, never said again", async () => {
  const said: string[] = [];
  const events: ServerEvent[] = [];
  const r = runner(said, events);
  r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: FRAMES, utteranceId: 1, replyText: Promise.resolve("Black one wins, Summer. It pops against that cream sweater."), recent: [] });
  await r.settle();
  await new Promise((res) => setImmediate(res));
  assert.ok(events.some((e) => e.type === "find.created"), "the card still lands");
  assert.deepEqual(said, [], "the card's line is not spoken after the answer");
});

test("S4 one verdict: the card waits for a spoken answer still under way (reply slower than the card)", async () => {
  const said: string[] = [];
  let finish!: (t: string | null) => void;
  const reply = new Promise<string | null>((res) => (finish = res));
  const r = runner(said);
  r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: FRAMES, utteranceId: 1, replyText: reply, recent: [] });
  // the card is built without the answer after its 9 s wait in prod; here it lands while the reply is still out
  setTimeout(() => finish("Black one, no contest."), 30);
  await r.settle();
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(said, []);
});

test("S4 one verdict: no spoken answer (the reply failed) → the card's line is the answer, said once", async () => {
  const said: string[] = [];
  const r = runner(said);
  r.onTurn({ text: "Which one looks better on me, the white one or the black one?", frames: FRAMES, utteranceId: 1, replyText: Promise.resolve(null), recent: [] });
  await r.settle();
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(said, ["Black one wins, no contest cutie."]);
});

