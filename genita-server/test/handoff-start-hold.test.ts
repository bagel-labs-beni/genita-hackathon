/**
 * Prod a5e2c4c (11/4): the greeting's opener came from the voice cache ~5 ms after `ready`, before the call's
 * start claim made this device the owner, so the gate dropped its audio — "Hey, Q!" showed with no sound and
 * the first sound came ~3 s later with Spark's line. Between `ready` and the claim, frames wait; then they're judged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateCall } from "../src/handoff/routes.ts";
import { HandoffHub } from "../src/handoff/hub.ts";
import { MemoryOwnershipStore } from "../src/handoff/store.ts";

type Out = string;
function wire(hub: HandoffHub, device: "iphone" | "mac") {
  const out: Out[] = [];
  const g = gateCall(hub, "u1", device, {
    sendJson: (m) => out.push(String((m as { type: string }).type)),
    sendBinary: () => out.push("bin"),
    close() {},
  }, () => {});
  return { ...g, out };
}
const opener = (sink: ReturnType<typeof wire>["sink"]) => {
  sink.sendJson({ type: "ready" } as never);
  sink.sendJson({ type: "reply.delta", text: "Hey, Q!" } as never);
  sink.sendJson({ type: "speaking" } as never);
  sink.sendJson({ type: "audio", seq: 1 } as never);
  sink.sendBinary(Buffer.alloc(8));
  sink.sendJson({ type: "audio.timing", seq: 1 } as never);
};

test("start hold: the opener said before the start claim still plays, in order, once the claim lands", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore(), () => {}, { handoverMs: 0 });
  const c = wire(hub, "iphone");
  opener(c.sink); // ~5 ms after ready, the claim not made yet
  assert.deepEqual(c.out, ["ready"], "held until the claim");
  await c.call.started();
  const sound = c.out.filter((t) => t !== "ownership");
  assert.deepEqual(sound, ["ready", "reply.delta", "speaking", "audio", "bin", "audio.timing"]);
  c.sink.sendBinary(Buffer.alloc(8));
  assert.equal(c.out.at(-1), "bin", "after the claim: straight through");
  c.call.close();
});

test("start hold: a device that loses the start claim (the other one holds the call) still gets no sound, captions in order", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore(), () => {}, { handoverMs: 0 });
  const mac = wire(hub, "mac");
  mac.sink.sendJson({ type: "ready" } as never);
  await mac.call.started(); // the Mac holds the conversation
  const phone = wire(hub, "iphone");
  opener(phone.sink);
  await phone.call.started();
  assert.deepEqual(phone.out.filter((t) => t !== "ownership"), ["ready", "reply.delta", "speaking", "audio.timing"]);
  mac.call.close(); phone.call.close();
});

test("start hold: a claim that never comes releases the held lines after the wait (judged as before)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hub = { attachCall: () => ({ mayPlay: () => false, started: () => new Promise<void>(() => {}), close() {} }) } as unknown as HandoffHub;
  const c = wire(hub, "iphone");
  opener(c.sink);
  assert.deepEqual(c.out, ["ready"]);
  t.mock.timers.tick(1500);
  assert.deepEqual(c.out, ["ready", "reply.delta", "speaking", "audio.timing"]);
});

test("start hold (MV-01): a start that takes the conversation with a newer local claim plays its held opener after the handover lease", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore(), () => {}, { handoverMs: 60 });
  const mac = wire(hub, "mac");
  mac.sink.sendJson({ type: "ready" } as never);
  await mac.call.started(); // the Mac holds it (epoch 1)
  const out: string[] = [];
  const phone = gateCall(hub, "u1", "iphone", {
    sendJson: (m) => out.push(String((m as { type: string }).type)),
    sendBinary: () => out.push("bin"),
    close() {},
  }, () => {}, { owner: "iphone", epoch: 2 }); // Continue here made while presence was down
  opener(phone.sink);
  await phone.call.started();
  assert.deepEqual(out.filter((t) => t !== "ownership"), ["ready", "reply.delta", "speaking", "audio", "bin", "audio.timing"], "the opener plays, after the lease");
  assert.equal(phone.call.mayPlay(), true);
  mac.call.close(); phone.call.close();
});
