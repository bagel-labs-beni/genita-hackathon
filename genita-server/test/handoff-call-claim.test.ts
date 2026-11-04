/** MV-01 (GATE-A): the apps' call URL names the device and its own last known owner. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callClaim, gatedCallDevice } from "../src/handoff/routes.ts";

const url = (q: string) => new URL("ws://h/v1/session" + q);

test("callClaim: the apps' owner/epoch query, 'phone' spelled as the local link does", () => {
  assert.deepEqual(callClaim(url("?device=iphone&owner=phone&epoch=3")), { owner: "iphone", epoch: 3 });
  assert.deepEqual(callClaim(url("?device=mac&owner=mac&epoch=12")), { owner: "mac", epoch: 12 });
});

test("callClaim: missing, zero or malformed → null (only the start claim runs)", () => {
  for (const q of ["", "?device=iphone", "?owner=mac", "?owner=mac&epoch=0", "?owner=tv&epoch=2", "?owner=mac&epoch=-1", "?owner=mac&epoch=1.5", "?owner=mac&epoch=99999999999", "?owner=mac&epoch=abc"]) {
    assert.equal(callClaim(url(q)), null, q);
  }
});

test("the apps' URL is gated by its device", () => {
  assert.equal(gatedCallDevice("dev", url("?device=iphone&owner=phone&epoch=1")), "iphone");
  assert.equal(gatedCallDevice("dev", url("?device=mac&owner=mac&epoch=1")), "mac");
  assert.equal(gatedCallDevice("dev", url("")), null, "older builds without ?device= stay ungated");
});
