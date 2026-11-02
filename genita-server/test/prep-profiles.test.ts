import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSIFY_SCHEMA } from "../src/prep/classify.ts";
import { FACE_KEYS, faceEditPrompt, faceKeysFor, faceSoftPrompt } from "../src/prep/face.ts";
import { flowProfileOf, profileMouthKeys, profilePrompt } from "../src/prep/profiles.ts";

test("classify asks for species and character style (mouth profiles), strict schema keeps them required", () => {
  const req = CLASSIFY_SCHEMA as unknown as { required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.ok(req.required.includes("species") && req.required.includes("character_style"));
  assert.deepEqual(req.properties.character_style.enum, ["2d", "3d", "none"]);
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
});

test("profile keys and prompts come from prep-py/profiles.json; humans keep the v7 set", () => {
  assert.equal(profileMouthKeys("human"), null);
  assert.deepEqual(profileMouthKeys("animal"), ["J2", "J3"]);
  assert.deepEqual(profileMouthKeys("cat"), ["C2"]);
  assert.deepEqual(profileMouthKeys("character2d"), ["SM", "WD", "OO", "EE"]);
  assert.deepEqual([...faceKeysFor("human", "human")], [...FACE_KEYS]);
  const dog = faceKeysFor("animal", "animal");
  assert.ok(dog.includes("J2") && dog.includes("J3") && !dog.includes("MID") && dog.includes("blink") && dog.includes("A"));
  const anime = faceKeysFor("character", "character2d");
  assert.ok(["SM", "WD", "OO", "EE"].every((k) => anime.includes(k as never)) && !anime.includes("AH"));
  const j2 = faceEditPrompt("J2", "animal", false, { profile: "animal", species: "Corgi" });
  assert.match(j2, /the same corgi/);
  assert.doesNotMatch(j2, /\{species\}/);
  assert.match(faceEditPrompt("J2", "animal", true, { profile: "animal", species: "dog" }), /same position and size in the frame\.$/);
  assert.equal(faceEditPrompt("blink", "animal", false, { profile: "animal", species: "dog" }), profilePrompt("animal", "BLINK", "dog"));
  // a refused J3 retries with the cat lane's calm prompt; humans are unchanged
  assert.equal(faceSoftPrompt("J3", "animal", { profile: "animal", species: "dog" }), profilePrompt("cat", "C2", "dog"));
  assert.equal(faceEditPrompt("AH", "human", false, { profile: "human" }), faceEditPrompt("AH", "human", false));
  assert.throws(() => faceEditPrompt("J2", "animal", false), /no prompt for J2/);
});
