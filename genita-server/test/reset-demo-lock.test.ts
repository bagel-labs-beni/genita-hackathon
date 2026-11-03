/** Codex #514 P2 ①: the judge demo copy at sign-in and a companion reset never overlap (same create lock as POST /v1/companion). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrepRunner } from "../src/prep/runner.ts";
import { guardDemoSeed } from "../src/prep/reset.ts";
type PrepDeps = ConstructorParameters<typeof PrepRunner>[0];

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

test("reset lock: a judge sign-in during a reset copies no demo (its faces would be swept); the next sign-in does", async () => {
  const runner = new PrepRunner({} as PrepDeps);
  const logs: string[] = [];
  let seeded = 0;
  const seed = guardDemoSeed(async () => { seeded++; }, runner, (e, d) => logs.push(`${e}:${String(d.reason)}`));
  const g = gate();
  const reset = runner.resetCompanion("u1", () => g.p); // the reset's erase is under way
  await seed("u1");
  assert.equal(seeded, 0, "no demo copy while the reset erases");
  assert.deepEqual(logs, ["demo.skipped:reset_in_progress"]);
  g.open(); await reset;
  await seed("u1");
  assert.equal(seeded, 1, "after the reset: copied");
});

test("reset lock: a reset that starts while a demo copy runs waits for it before erasing", async () => {
  const runner = new PrepRunner({} as PrepDeps);
  const order: string[] = [];
  const g = gate();
  const seed = guardDemoSeed(async () => { order.push("copy start"); await g.p; order.push("copy done"); }, runner, () => {});
  const s = seed("u1");
  await Promise.resolve();
  const reset = runner.resetCompanion("u1", async () => { order.push("erase"); });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["copy start"], "the erase waits");
  g.open(); await s; await reset;
  assert.deepEqual(order, ["copy start", "copy done", "erase"]);
});

test("reset lock: other seed failures still surface", async () => {
  const runner = new PrepRunner({} as PrepDeps);
  const seed = guardDemoSeed(async () => { throw new Error("boom"); }, runner, () => {});
  await assert.rejects(seed("u1"), /boom/);
});
