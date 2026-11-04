/**
 * The instant nonverbal reaction's sound (lead's call 11/4): a small inhale, ≤ 0.45 s, never louder than breath.
 * Synthesized once (no asset): band-limited noise under a quick rise / slower fall, peak about −30 dBFS, as
 * PCM s16le 24 kHz mono base64 — what `backchannel.audio` carries.
 */
const SR = 24_000;
const LEN_S = 0.42;
/** peak sample: ~ −30 dBFS */
const PEAK = 1_000;

let cached: string | null = null;

export function inhalePcmBase64(): string {
  if (cached) return cached;
  const n = Math.round(SR * LEN_S);
  const out = Buffer.alloc(n * 2);
  // deterministic noise (xorshift), a two-pole low-pass for an airy, not hissy, breath
  let x = 0x9e3779b9;
  let a = 0;
  let b = 0;
  const raw: number[] = [];
  let max = 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    const white = ((x >>> 0) / 0xffffffff) * 2 - 1;
    a += 0.18 * (white - a);
    b += 0.18 * (a - b);
    const t = i / n;
    // rise over the first 40 %, fall over the rest (an inhale swells, then stops)
    const env = t < 0.4 ? Math.sin((t / 0.4) * (Math.PI / 2)) : Math.cos(((t - 0.4) / 0.6) * (Math.PI / 2));
    const v = (a - b * 0.5) * env;
    raw.push(v);
    max = Math.max(max, Math.abs(v));
  }
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round((raw[i] / (max || 1)) * PEAK), i * 2);
  cached = out.toString("base64");
  return cached;
}
