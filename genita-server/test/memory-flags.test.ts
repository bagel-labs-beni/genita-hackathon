import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryFeatures, createMemory } from "../src/memory/index.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";

// D40: Us photo and seen memory are cut for the hackathon build; flags default off.
test("memory features: Us photo and seen memory are off unless their env flag is 1", () => {
  assert.deepEqual(memoryFeatures({}), { usPhotos: false, seenMemory: false, sessionMemory: true });
  assert.deepEqual(memoryFeatures({ GENITA_US_PHOTOS: "1", GENITA_SEEN_MEMORY: "1" }), { usPhotos: true, seenMemory: true, sessionMemory: true });
  // session memory (call summaries, 11/3) is on unless GENITA_SESSION_MEMORY=0
  assert.equal(memoryFeatures({ GENITA_SESSION_MEMORY: "0" }).sessionMemory, false);
});

test("createMemory: no Us photo service by default", () => {
  const prev = process.env.GENITA_US_PHOTOS; delete process.env.GENITA_US_PHOTOS;
  try { assert.equal(createMemory("fake", () => {}).photos, undefined); }
  finally { if (prev !== undefined) process.env.GENITA_US_PHOTOS = prev; }
});

test("seen memory off: rememberSeen saves nothing and never verifies a crop", async () => {
  const repo = new InMemoryMemoryRepository();
  let verified = 0;
  const service = new MemoryService({ repository: repo, state: repo, extract: async () => [], seenMemory: false, deleteCrop: async () => {}, verifyCrop: async () => { verified++; return true; } });
  const crop = { image_ref: "seen/a.jpg", width: 256, height: 256, box: [1, 1, 10, 10] as [number, number, number, number], safeObject: true };
  const saved = await service.rememberSeen("a", { sessionId: "s", discussedText: "We discussed the kimchi tub." }, { object: "kimchi", line: "I showed a kimchi tub.", crop } as never);
  assert.equal(saved, null); assert.equal(verified, 0); assert.equal((await service.list("a")).length, 0);
});
