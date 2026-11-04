import { test } from "node:test";
import assert from "node:assert/strict";
import { newPrepState, prepView, sceneFraming } from "../src/prep/runner.ts";
import type { CompanionRecord } from "../src/prep/store.ts";

// Face plan item 1: the app draws the call scene in the poster's crop before the face set is downloaded. `framing`
// must be what GenitaKit FaceRenderer.framing(set) computes from the manifest (faceBox, flow.kind, flow.map.framing).

function companion(type: CompanionRecord["type"], face?: Record<string, unknown>, faceStatus = "done"): CompanionRecord {
  const prep = newPrepState();
  prep.steps.scene = { status: "done", attempts: 1, url: "/v1/companion/face/neutral" };
  if (face) prep.steps.face = { status: faceStatus as "done", attempts: 1, face: { size: [1152, 2048], items: {}, ms: { total: 0, edits: 0, sam: 0 }, ...face } as any };
  return { id: "c1", userId: "u1", imageId: "img1", type, voiceId: "v", name: "Mira", createdAt: new Date().toISOString(), prep };
}
const box = (face: number[]) => ({ ref: { face, mouth: [0.4, 0.5, 0.6, 0.55] } });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("framing: null until the scene's face box is known", () => {
  assert.equal(prepView(companion("human")).framing, null);
  const c = companion("human");
  c.prep.steps.scene = { status: "running", attempts: 1 };
  assert.equal(sceneFraming(c), null);
});

test("framing: people are never zoomed; centre = face centre x, a tenth of the face height above its centre", () => {
  const f = prepView(companion("human", { ...box([0.2, 0.24, 0.72, 0.57]), flow: { kind: "human", map: {}, files: {} } })).framing!;
  assert.equal(f.zoom, 1);
  close(f.cx, 0.46);
  close(f.cy, 0.405 - 0.1 * 0.33);
});

test("framing: a small non-human face is zoomed up to 35 % of the frame height, capped at 1.35x", () => {
  // face 0.3 tall → 0.35 / 0.3
  const a = sceneFraming(companion("character", { ...box([0.3, 0.3, 0.7, 0.6]), flow: { kind: "character2d", map: {} } }))!;
  close(a.zoom, 0.35 / 0.3);
  // face 0.2 tall → 1.75 → cap 1.35
  assert.equal(sceneFraming(companion("animal", { ...box([0.4, 0.4, 0.6, 0.6]), flow: { kind: "animal", map: {} } }))!.zoom, 1.35);
  // a big face → 1
  assert.equal(sceneFraming(companion("animal", { ...box([0.1, 0.1, 0.9, 0.6]), flow: { kind: "animal", map: {} } }))!.zoom, 1);
});

test("framing: the app's kind rule — a finished set without flow reads as a person; before the flow, the companion type", () => {
  // done without flow (no Python on that server): the app sees no kind → person → no zoom
  assert.equal(sceneFraming(companion("animal", { ...box([0.4, 0.4, 0.6, 0.6]) }))!.zoom, 1);
  // face step still running, boxes known, flow not made yet: the companion type decides
  assert.equal(sceneFraming(companion("animal", { ...box([0.4, 0.4, 0.6, 0.6]) }, "running"))!.zoom, 1.35);
  assert.equal(sceneFraming(companion("human", { ...box([0.4, 0.4, 0.6, 0.6]) }, "running"))!.zoom, 1);
});

test("framing: map.framing wins, clamped like the app (zoom 1…2, centre inside the still)", () => {
  const map = (framing: unknown) => ({ ...box([0.4, 0.4, 0.6, 0.6]), flow: { kind: "human", map: { framing } } });
  const a = sceneFraming(companion("human", map({ zoom: 1.5, cy: 0.3 })))!;
  assert.equal(a.zoom, 1.5);
  close(a.cy, 0.3);
  assert.equal(sceneFraming(companion("human", map({ zoom: 9, cy: 1.4 })))!.zoom, 2);
  assert.equal(sceneFraming(companion("human", map({ zoom: 9, cy: 1.4 })))!.cy, 1);
  assert.equal(sceneFraming(companion("human", map({ zoom: 0.5 })))!.zoom, 1);
  // a wrong-typed field is ignored (the app's tolerant decode), the rest of the rule applies
  const b = sceneFraming(companion("animal", { ...box([0.4, 0.4, 0.6, 0.6]), flow: { kind: "animal", map: { framing: { zoom: "x", cy: null } } } }))!;
  assert.equal(b.zoom, 1.35);
  close(b.cy, 0.5 - 0.02);
});

test("framing: a degenerate face box is the whole still (as FaceSet does)", () => {
  const f = sceneFraming(companion("animal", { ...box([0.5, 0.5, 0.5, 0.9]), flow: { kind: "animal", map: {} } }))!;
  assert.equal(f.zoom, 1);
  close(f.cx, 0.5);
  close(f.cy, 0.5 - 0.1);
});
