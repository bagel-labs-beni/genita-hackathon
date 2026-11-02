import { test } from "node:test";
import assert from "node:assert/strict";
import { gateCall } from "../src/handoff/routes.ts";
import type { HandoffHub } from "../src/handoff/hub.ts";

// Device voice (#157): `say` is the companion's voice on that device, so the owner gate covers it like `audio`.
test("handoff gate: a non-owner gets no say/audio lines and no frames; captions still flow", () => {
  let owner = false;
  const hub = { attachCall: () => ({ mayPlay: () => owner }) } as unknown as HandoffHub;
  const got: string[] = [];
  let frames = 0;
  const { sink } = gateCall(hub, "u", "iphone", { sendJson: (m) => got.push(String((m as { type: string }).type)), sendBinary: () => { frames++; }, close() {} }, () => {});
  for (const type of ["reply.delta", "say", "audio", "reply"]) sink.sendJson({ type } as never);
  sink.sendBinary(Buffer.alloc(4));
  assert.deepEqual(got, ["reply.delta", "reply"]);
  assert.equal(frames, 0);
  owner = true;
  sink.sendJson({ type: "say" } as never);
  sink.sendBinary(Buffer.alloc(4));
  assert.deepEqual(got.slice(-1), ["say"]);
  assert.equal(frames, 1);
});
