import { test } from "node:test";
import assert from "node:assert/strict";
import { Resampler24to16 } from "../src/lips/resample.ts";

function sine(hz: number, sr: number, n: number, amp = 8000): Buffer {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / sr)), i * 2);
  return b;
}
const samples = (b: Buffer) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
const zeroCrossings = (xs: number[]) => xs.slice(1).filter((x, i) => (xs[i] < 0) !== (x < 0)).length;

test("24 kHz → 16 kHz keeps 2/3 of the samples and the pitch", () => {
  const out = samples(new Resampler24to16().push(sine(1000, 24000, 24000)));
  assert.ok(Math.abs(out.length - 16000) <= 2, `len ${out.length}`);
  // 1 kHz for 1 s ≈ 2000 zero crossings at any sample rate
  assert.ok(Math.abs(zeroCrossings(out.slice(100)) - 2000 * (out.length - 100) / out.length) < 10);
  const peak = Math.max(...out.slice(100).map(Math.abs));
  assert.ok(peak > 7000 && peak < 9000, `peak ${peak}`); // passband ~unity gain
});

test("streaming in odd-sized chunks equals one-shot", () => {
  const input = sine(440, 24000, 4801);
  const once = new Resampler24to16().push(input);
  const r = new Resampler24to16();
  const parts: Buffer[] = [];
  for (let o = 0; o < input.length; ) {
    const n = [7, 2, 1000, 333, 4][parts.length % 5] * 2;
    parts.push(r.push(input.subarray(o, o + n)));
    o += n;
  }
  assert.deepEqual(samples(Buffer.concat(parts)), samples(once));
});

test("content above 8 kHz is attenuated (anti-alias)", () => {
  const out = samples(new Resampler24to16().push(sine(10000, 24000, 24000)));
  const peak = Math.max(...out.slice(100).map(Math.abs));
  assert.ok(peak < 2500, `aliased peak ${peak}`);
});
