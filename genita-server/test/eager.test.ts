import { test } from "node:test";
import assert from "node:assert/strict";
import { Eager } from "../src/util/eager.ts";

async function* slow(items: number[], log: string[]) {
  for (const i of items) {
    log.push(`produce ${i}`);
    await new Promise((r) => setTimeout(r, 5));
    yield i;
  }
}

test("Eager starts producing before anyone reads, and yields everything in order", async () => {
  const log: string[] = [];
  const e = new Eager(slow([1, 2, 3], log));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(log.length >= 3, "produced ahead of the reader");
  const got: number[] = [];
  for await (const v of e) got.push(v);
  assert.deepEqual(got, [1, 2, 3]);
});

test("Eager rethrows the producer's error to the reader after earlier items", async () => {
  async function* boom() {
    yield 1;
    throw new Error("tts down");
  }
  const e = new Eager(boom());
  const got: number[] = [];
  await assert.rejects(async () => {
    for await (const v of e) got.push(v);
  }, /tts down/);
  assert.deepEqual(got, [1]);
});
