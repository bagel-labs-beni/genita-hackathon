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
  assert.deepEqual(report.turns, {
    chatFirstAudioMs: { p50: 1200, p90: 1200 },
    interpretFirstAudioMs: { p50: 900, p90: 900 },
    ttsFallbackDevice: 1,
    voiceCapacityFallback: 1,
  });
  assert.deepEqual(report.funnel.map((x) => x.count), [1, 1, 1, 1, 1, 1, 1]);
  assert.match(renderReport(report), /upload → moving face p50 ≤ 120 s: PASS \(30\.0 s\)/);
  assert.match(renderReport(report), /turn chat first_audio_ms p50\/p90: 1200 \/ 1200/);
  assert.match(renderReport(report), /turn interpret first_audio_ms p50\/p90: 900 \/ 900/);
});

test("funnel report never builds a companion join from an app event", () => {
  const records = parseLogLines(readFileSync(new URL("./fixtures/funnel.log", import.meta.url), "utf8"));
  const poisoned = [...records, { event: "face.uploaded", source: "app", userId: "u1", companionId: "fake", t: "2026-11-03T00:00:00.000Z" }];
  assert.deepEqual(buildReport(poisoned), buildReport(records));
});

test("funnel report uses face.uploaded.at before a slow image check", () => {
  const report = buildReport([
    { event: "face.uploaded", imageId: "img1", t: "2026-11-03T00:01:00.000Z", at: "2026-11-03T00:00:00.000Z" },
    { event: "companion.created", companionId: "c1", imageId: "img1", userId: "u1" },
    { event: "face.done", companionId: "c1", t: "2026-11-03T00:02:40.000Z" },
  ]);
  assert.equal(report.gates.uploadToMovingFaceP50Ms, 160_000);
  assert.equal(report.gates.uploadToMovingFace, "FAIL");
});
