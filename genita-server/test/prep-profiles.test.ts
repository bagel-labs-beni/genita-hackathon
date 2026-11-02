import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSIFY_SCHEMA } from "../src/prep/classify.ts";
import { FACE_KEYS, faceEditPrompt, faceKeysFor, faceSoftPrompt } from "../src/prep/face.ts";
import { flowProfileOf, profileMouthKeys, profilePrompt } from "../src/prep/profiles.ts";

test("classify asks for species and character style (mouth profiles), strict schema keeps them required", () => {
  const req = CLASSIFY_SCHEMA as unknown as { required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.ok(req.required.includes("species") && req.required.includes("character_style"));
  assert.deepEqual(req.properties.character_style.enum, ["2d", "3d", "toy", "none"]);
});

test("profile from the image check: human / dog → animal / cat / 2D anime / 3D (and unsure → 3D)", () => {
  assert.equal(flowProfileOf("human", { species: "" }), "human");
  assert.equal(flowProfileOf("animal", { species: "dog" }), "animal");
  assert.equal(flowProfileOf("animal", { species: "Cat" }), "cat");
  assert.equal(flowProfileOf("animal", { species: "tabby kitten" }), "cat");
  assert.equal(flowProfileOf("animal", null), "animal");
  assert.equal(flowProfileOf("character", { character_style: "2d" }), "character2d");
  assert.equal(flowProfileOf("character", { character_style: "3d" }), "character3d");
  assert.equal(flowProfileOf("character", {}), "character3d");
  assert.equal(flowProfileOf("character", { character_style: "toy" }), "toy");
});

test("profile keys and prompts come from prep-py/profiles.json; humans keep the v7 set", () => {
  assert.equal(profileMouthKeys("human"), null);
  assert.deepEqual(profileMouthKeys("animal"), ["AH", "AH2"]);   // 11/3: animal jaw keys named like the v2 ladder
  assert.deepEqual(profileMouthKeys("cat"), ["AH2"]);
  assert.deepEqual(profileMouthKeys("character2d"), ["SM", "WD", "OO", "EE"]);
  assert.deepEqual(profileMouthKeys("toy"), ["AH", "AH2"]);
  assert.ok(!(profileMouthKeys("character3d") ?? []).includes("FV"), "v16: FV dropped from 3D (lower-lip twist)");
  assert.match(profilePrompt("toy", "AH") ?? "", /\S/);
  assert.deepEqual([...faceKeysFor("human", "human")], [...FACE_KEYS]);
  const dog = faceKeysFor("animal", "animal");
  assert.ok(dog.includes("AH") && dog.includes("AH2") && !dog.includes("MID") && dog.includes("blink") && dog.includes("A"));
  const anime = faceKeysFor("character", "character2d");
  assert.ok(["SM", "WD", "OO", "EE"].every((k) => anime.includes(k as never)) && !anime.includes("AH"));
  const j2 = faceEditPrompt("AH", "animal", false, { profile: "animal", species: "Corgi" });
  assert.match(j2, /the same corgi/);
  assert.doesNotMatch(j2, /\{species\}/);
  assert.match(faceEditPrompt("AH", "animal", true, { profile: "animal", species: "dog" }), /same position and size in the frame\.$/);
  assert.equal(faceEditPrompt("blink", "animal", false, { profile: "animal", species: "dog" }), profilePrompt("animal", "BLINK", "dog"));
  // humans are unchanged
  assert.equal(faceEditPrompt("AH", "human", false, { profile: "human" }), faceEditPrompt("AH", "human", false));
  assert.throws(() => faceEditPrompt("J2", "animal", false), /no prompt for J2/);
});

test("codex round 3: a profile's blink / mouth-key retry keeps its own prompt and species; the plan is saved with the first state", async () => {
  const blink = faceEditPrompt("blink", "animal", false, { profile: "animal", species: "dog" });
  assert.equal(faceSoftPrompt("blink", "animal", { profile: "animal", species: "dog" }), blink);
  assert.equal(faceSoftPrompt("AH2", "animal", { profile: "animal", species: "dog" }), faceEditPrompt("AH2", "animal", false, { profile: "animal", species: "dog" }));
  const { makeFaceSet } = await import("../src/prep/face.ts");
  const { fakeMedia, fakePng } = await import("./helpers/fakeMedia.ts");
  const { media } = fakeMedia({ keyOf: () => "x" });
  const refs: Array<{ keys?: string[]; profile?: string }> = [];
  await makeFaceSet({ metaKey: "k", media, scene: fakePng(1000, 2000, "scene"), kind: "animal", size: "1024x1820", profile: "cat", species: "cat", onRef: async (s) => void refs.push({ keys: s.keys, profile: s.profile }) });
  assert.equal(refs[0].profile, "cat");
  assert.ok(refs[0].keys?.includes("AH2") && !refs[0].keys?.includes("AH"));
});
