import { test } from "node:test";
import assert from "node:assert/strict";
import { FACE_CONCURRENCY, faceConcurrency } from "../src/prep/face.ts";

test("face set: every key in one wave by default (prep 96–126 s → 64–94 s, 11/3); GENITA_FACE_CONCURRENCY overrides", () => {
  assert.ok(FACE_CONCURRENCY >= 20, "a human set is 20–21 keys: one wave");
  assert.equal(faceConcurrency({}), FACE_CONCURRENCY);
  assert.equal(faceConcurrency({ GENITA_FACE_CONCURRENCY: "6" }), 6);
  for (const bad of ["0", "-1", "2.5", "x", "100"]) assert.equal(faceConcurrency({ GENITA_FACE_CONCURRENCY: bad }), FACE_CONCURRENCY, bad);
});
