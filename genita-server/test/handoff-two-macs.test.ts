/** MV-01 (audit 11/4): two Macs on one account — Move to Mac is relayed to one Mac, the most recently active. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HandoffHub } from "../src/handoff/hub.ts";
import { MemoryOwnershipStore } from "../src/handoff/store.ts";

type M = Record<string, unknown>;
function presence(hub: HandoffHub, device: "iphone" | "mac") {
  const got: M[] = [];
  const h = hub.connect("u", { device, send: (m) => got.push(m) });
  return { h, got, moveRequests: () => got.filter((m) => m.type === "move.request").length };
}

test("Move to Mac goes to the most recently active Mac only", () => {
  let now = 1_000;
  const hub = new HandoffHub(new MemoryOwnershipStore(), () => {}, { handoverMs: 0, now: () => now });
  const phone = presence(hub, "iphone");
  const laptop = presence(hub, "mac");
  now += 10;
  const desktop = presence(hub, "mac");
  phone.h.moveRequest("mac");
  assert.deepEqual([laptop.moveRequests(), desktop.moveRequests()], [0, 1], "the newest Mac answers, not both");
  now += 10;
  laptop.h.setActive(false); laptop.h.setActive(true); // the laptop was used last
  phone.h.moveRequest("mac");
  assert.deepEqual([laptop.moveRequests(), desktop.moveRequests()], [1, 1]);
  desktop.h.setActive(false); laptop.h.setActive(false);
  phone.h.moveRequest("mac");
  assert.equal(phone.got.filter((m) => m.type === "move.failed").at(-1)?.reason, "peer_inactive", "no active Mac: MV-E as before");
});
