/** Spread + seeded shuffle helpers for the convo eval. Pure. */
export function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

const r2 = (v: number) => Math.round(v * 100) / 100;
export function meanStd(xs: number[]): { mean: number; sd: number; n: number } | null {
  if (!xs.length) return null;
  return { mean: r2(xs.reduce((a, b) => a + b, 0) / xs.length), sd: r2(sampleStd(xs)), n: xs.length };
}

/** mulberry32: small seeded PRNG, [0,1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  const r = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
