/**
 * 11/4 · TestFlight 331 (build 9): the mic does nothing on the iPhone and the Mac since GATE-A (#688).
 *
 *   1. Root fix in the hub: a stale stored owner "mac" whose app was quit (no presence, no call) no longer keeps an
 *      iPhone call silent — the start takes it, and the URL's own stale owner=mac can't re-assert it. A connected owner
 *      still keeps it ("Continue on your Mac").
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
  // an earlier session (e.g. a proximity test) left the Mac as the owner
  for (let i = 0; i < epoch; i++) await store.claim("u1", i % 2 ? "iphone" : "mac", null);
  const rec = await store.load("u1");
  assert.equal(rec.owner, "mac");
  assert.equal(rec.epoch, epoch);
  return new HandoffHub(store, () => {}, { handoverMs: 0 });
}
const msgs = () => {
  const out: Record<string, unknown>[] = [];
  return { out, send: (m: Record<string, unknown>) => out.push(m) };
};

/*
 * Diagnosis (before the root fix, origin/main 40f30533): with the Mac app quit, the iPhone call below ended with
 * mayPlay() false — the URL's own owner=mac sync claim re-asserted the Mac and the start claim never steals — so
 * server.ts dropped every mic frame. The root fix: an owner with no live connection is taken over by the start.
 */
for (const [label, rel] of [["same epoch", 0], ["older epoch", -1], ["newer epoch", 1]] as const) {
  test(`root fix: stored owner=mac with the Mac app quit + iPhone call ?device=iphone&owner=mac (${label}) → the iPhone takes it, mic flows`, async () => {
    const stored = 3;
    const hub = await staleMacHub(stored);
    const known = callClaim(url(`?device=iphone&owner=mac&epoch=${stored + rel}`));
    assert.ok(known, "the URL parses as a claim");
    const m = msgs();
    const call = hub.attachCall("u1", "iphone", { stop() {}, send: m.send, known });
    await call.started();
    // server.ts: `if (!gated || gated.call.mayPlay()) session.onClientAudio(buf);`
    assert.equal(call.mayPlay(), true, "the iPhone's mic frames reach the session");
    const own = hub.ownership("u1");
    assert.equal(own?.owner, "iphone");
    assert.ok((own?.epoch ?? 0) > Math.max(stored, stored + rel), "a fresh epoch, above anything the stale URL said");
    assert.ok(m.out.some((x) => x.type === "ownership" && x.owner === "iphone" && x.trigger === "start"), "the call hears the move");
    // the Mac app opens again later: its presence learns the iPhone holds it
    const mac = msgs();
    const p = hub.connect("u1", { device: "mac", send: mac.send });
    await new Promise((r) => setImmediate(r));
    assert.ok(mac.out.some((x) => x.type === "ownership" && x.owner === "iphone"), "the reconnecting Mac hears owner=iphone");
    p.close();
    call.close();
  });
}

test("no steal: the Mac's presence is connected (even locked) → the iPhone start leaves it (the 'Continue on your Mac' sheet case)", async () => {
  for (const locked of [false, true]) {
    const hub = await staleMacHub(3);
    const macP = hub.connect("u1", { device: "mac", send() {} });
    if (locked) macP.setActive(false);
    const call = hub.attachCall("u1", "iphone", { stop() {}, send() {}, known: callClaim(url("?device=iphone&owner=mac&epoch=3")) });
    await call.started();
    assert.equal(call.mayPlay(), false, `locked=${locked}`);
    assert.deepEqual(hub.ownership("u1"), { owner: "mac", epoch: 3 });
    call.close(); macP.close();
  }
});

test("no steal: a Mac call is open (no presence) → the iPhone start leaves it", async () => {
  const hub = await staleMacHub(3);
  const macCall = hub.attachCall("u1", "mac", { stop() {}, send() {} });
  await macCall.started();
  assert.equal(macCall.mayPlay(), true);
  const call = hub.attachCall("u1", "iphone", { stop() {}, send() {} });
  await call.started();
  assert.equal(call.mayPlay(), false);
  assert.equal(hub.ownership("u1")?.owner, "mac");
  call.close(); macCall.close();
});

test("no steal: an ungated Mac call is live (callStarted only) → the iPhone start leaves it", async () => {
  const hub = await staleMacHub(3);
  const ended = hub.callStarted("u1", "mac");
  const call = hub.attachCall("u1", "iphone", { stop() {}, send() {} });
  await call.started();
  assert.equal(call.mayPlay(), false);
  ended();
  call.close();
});

test("the URL's owner=mac is still applied while the Mac is connected (a newer Mac claim the server missed wins)", async () => {
  const hub = await staleMacHub(1); // mac @1
  await hub.claimHttp("u1", "iphone", null, "button"); // iphone @2
  const macP = hub.connect("u1", { device: "mac", send() {} });
  const call = hub.attachCall("u1", "iphone", { stop() {}, send() {}, known: callClaim(url("?device=iphone&owner=mac&epoch=3")) });
  await call.started();
  assert.deepEqual(hub.ownership("u1"), { owner: "mac", epoch: 3 });
  assert.equal(call.mayPlay(), false);
  call.close(); macP.close();
});

test("control: with no owner yet (fresh record) the iPhone call gets the conversation and its mic", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore(), () => {}, { handoverMs: 0 });
  const call = hub.attachCall("u1", "iphone", { stop() {}, send() {}, known: null });
  await call.started();
  assert.equal(call.mayPlay(), true);
  call.close();
});
