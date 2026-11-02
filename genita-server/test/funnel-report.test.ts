import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReport, parseLogLines, renderReport } from "../scripts/funnel-report.ts";

test("funnel report reads prefixed JSON lines and reports prep, fallback, and ordered funnel numbers", () => {
  const records = parseLogLines(readFileSync(new URL("./fixtures/funnel.log", import.meta.url), "utf8"));
  const report = buildReport(records);
  assert.equal(report.companions[0]?.uploadToSceneS, 10);
  assert.equal(report.companions[0]?.sceneToFaceS, 20);
  assert.equal(report.companions[0]?.faceToReadyS, 30);
  assert.equal(report.companions[0]?.readyToGreetedS, 20);
  assert.equal(report.gates.uploadToMovingFaceP50Ms, 30_000);
  assert.equal(report.gates.uploadToMovingFace, "PASS");
  assert.deepEqual(report.turns, { firstAudioMs: { p50: 1200, p90: 1200 }, ttsFallbackDevice: 1, voiceCapacityFallback: 1 });
  assert.deepEqual(report.funnel.map((x) => x.count), [1, 1, 1, 1, 1, 1, 1]);
  assert.match(renderReport(report), /upload → moving face p50 ≤ 120 s: PASS \(30\.0 s\)/);
});
