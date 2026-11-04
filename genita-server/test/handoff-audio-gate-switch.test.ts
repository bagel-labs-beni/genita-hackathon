/**
 * 11/4 · TestFlight 331 (build 9): the mic does nothing on the iPhone and the Mac since GATE-A (#688).
 *
 *   1. Diagnosis against the hub: a stale stored owner "mac" + an iPhone call that carries ?device=iphone&owner=mac&epoch=N
 *      leaves the iPhone's call not allowed to play (mayPlay false), and server.ts drops the mic on exactly that check.
 *   2. The kill switch GENITA_AUDIO_GATE=0: gatedCallDevice returns null, so the call runs ungated like an older build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { audioGateOn, callClaim, gatedCallDevice } from "../src/handoff/routes.ts";
import { HandoffHub } from "../src/handoff/hub.ts";
import { MemoryOwnershipStore } from "../src/handoff/store.ts";

const url = (q: string) => new URL("ws://h/v1/session" + q);

test("GENITA_AUDIO_GATE: unset or 1 = gated (today's behaviour); 0/false/off = no call is gated", () => {
  assert.equal(audioGateOn({}), true, "default on");
  assert.equal(audioGateOn({ GENITA_AUDIO_GATE: "1" }), true);
  assert.equal(audioGateOn({ GENITA_AUDIO_GATE: "yes" }), true, "anything else stays on");
  for (const v of ["0", " 0 ", "false", "OFF"]) assert.equal(audioGateOn({ GENITA_AUDIO_GATE: v }), false, v);

  const apps = url("?device=iphone&owner=mac&epoch=3");
  assert.equal(gatedCallDevice("dev", apps, {}), "iphone");
  assert.equal(gatedCallDevice("dev", apps, { GENITA_AUDIO_GATE: "1" }), "iphone");
  assert.equal(gatedCallDevice("iphone", apps, { GENITA_AUDIO_GATE: "0" }), null, "switch off: the apps' URL is not gated");
  assert.equal(gatedCallDevice("mac", url("?device=mac&owner=mac&epoch=3"), { GENITA_AUDIO_GATE: "0" }), null);
  assert.equal(gatedCallDevice("dev", url(""), { GENITA_AUDIO_GATE: "1" }), null, "older builds stay ungated either way");
});

async function staleMacHub(epoch: number) {
  const store = new MemoryOwnershipStore();
  // an earlier session (e.g. a proximity test) left the Mac as the owner; no Mac is connected now
  for (let i = 0; i < epoch; i++) await store.claim("u1", i % 2 ? "iphone" : "mac", null);
  const rec = await store.load("u1");
  assert.equal(rec.owner, "mac");
  assert.equal(rec.epoch, epoch);
  return new HandoffHub(store, () => {}, { handoverMs: 0 });
}

for (const [label, rel] of [["same epoch", 0], ["older epoch", -1], ["newer epoch", 1]] as const) {
  test(`diagnosis: stored owner=mac + iPhone call ?device=iphone&owner=mac (${label}) → mayPlay stays false, so server.ts drops the mic`, async () => {
    const stored = 3;
    const hub = await staleMacHub(stored);
    const known = callClaim(url(`?device=iphone&owner=mac&epoch=${stored + rel}`));
    assert.ok(known, "the URL parses as a claim");
    const sent: Record<string, unknown>[] = [];
    const call = hub.attachCall("u1", "iphone", { stop() {}, send: (m) => sent.push(m), known });
    await call.started();
    // server.ts: `if (!gated || gated.call.mayPlay()) session.onClientAudio(buf);`
    assert.equal(call.mayPlay(), false, "YES: the iPhone's mic frames are dropped");
    assert.equal(hub.ownership("u1")?.owner, "mac", "the start claim doesn't steal from the stale owner; the URL's own owner=mac re-asserts it");
    assert.ok(sent.some((m) => m.type === "ownership" && m.owner === "mac"), "the call is told the Mac owns it");
    call.close();
  });
}

test("diagnosis control: with no stale owner (fresh record) the same iPhone call gets the conversation and its mic", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore(), () => {}, { handoverMs: 0 });
  const call = hub.attachCall("u1", "iphone", { stop() {}, send() {}, known: null });
  await call.started();
  assert.equal(call.mayPlay(), true);
  call.close();
});

test("diagnosis control: the iPhone URL that names itself (owner=phone, newer epoch) wins over the stale Mac", async () => {
  const hub = await staleMacHub(3);
  const call = hub.attachCall("u1", "iphone", { stop() {}, send() {}, known: callClaim(url("?device=iphone&owner=phone&epoch=4")) });
  await call.started();
  assert.equal(call.mayPlay(), true);
  call.close();
});
