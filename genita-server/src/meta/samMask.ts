/**
 * SAM 3.1 mask tokens: `<|mask;x=0;y=0[;c=..];data=<H>,<W>,<enc><payload>|>`.
 *
 * Wire format as documented on dev.meta.ai/docs/sam/reading-segmentation and
 * implemented by Meta's @meta-sam/parser (mask-codec.js, SAM License). This is
 * our own dependency-free port so the server can decode without the package.
 *
 *   H,W       mask raster rows, columns. The raster covers the record's box
 *             (W = x2 - x1 + 1, H = y2 - y1 + 1 in source pixels).
 *   enc       first char after "H,W,": "~" lossless (default), "!" one_bit
 *             (request with metadata.mask_encoding = "one_bit").
 *   payload   base85 over ASCII 0x21..0x7e minus  " \ , ; < > |  (85 chars,
 *             '!' = 0), a 5-char length prefix (byte count, base85), then
 *             4 bytes -> 5 chars big-endian, a short tail keeps remainder+1 chars.
 *   one_bit   adaptive binary range coder, context = 12 neighbouring bits
 *             (2 left, 5 above, 5 two rows up), zero padding of 2 around.
 *   lossless  byte 0 = spatial predictor (0 paeth, 1 up, 2 left, 3 avg, 4 MED),
 *             then a range-coded 8-bit coverage raster: a zero/non-zero flag with a
 *             4-neighbour context, non-zero residuals by an order-0/1/2 mix,
 *             zigzag residual + prediction. Coverage >= 129 is "inside".
 */

export type SamMaskEncoding = "lossless" | "one_bit";
export type SamMaskToken = { height: number; width: number; payload: string };
export type DecodedSamMask = {
  width: number;
  height: number;
  encoding: SamMaskEncoding;
  /** row-major 0/1, length width * height */
  bits: Uint8Array;
};

export class SamMaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamMaskError";
  }
}

const EXCLUDED = new Set(['"', "\\", ",", ";", "<", ">", "|"]);
const ALPHABET = (() => {
  let s = "";
  for (let c = 0x21; c <= 0x7e; c++) if (!EXCLUDED.has(String.fromCharCode(c))) s += String.fromCharCode(c);
  return s;
})();
const RADIX = 85;
const PREFIX = 5;
const DIGIT = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DIGIT[ALPHABET.charCodeAt(i)] = i;

const MASK32 = 0xffffffff;
const TOP = 1 << 24;
const BOTTOM = 1 << 16;
/** Largest raster we decode (a full 4K frame); anything bigger is not a real SAM mask. */
const MAX_AREA = 4096 * 4096;

function digit(s: string, i: number): number {
  const code = s.charCodeAt(i);
  const v = code < 128 ? DIGIT[code] : -1;
  if (v < 0) throw new SamMaskError("mask payload: invalid character");
  return v;
}

function packChars(input: Uint8Array): string {
  let n = input.length;
  const prefix = new Array<string>(PREFIX);
  for (let i = PREFIX - 1; i >= 0; i--) {
    prefix[i] = ALPHABET[n % RADIX];
    n = Math.floor(n / RADIX);
  }
  if (n !== 0) throw new SamMaskError("mask payload too large");
  const out = prefix;
  const group = (v: number, keep: number) => {
    const d = new Array<number>(5);
    for (let i = 4; i >= 0; i--) {
      d[i] = v % RADIX;
      v = (v - d[i]) / RADIX;
    }
    for (let i = 0; i < keep; i++) out.push(ALPHABET[d[i]]);
  };
  const full = input.length - (input.length % 4);
  let o = 0;
  for (; o < full; o += 4) group(((input[o] << 24) | (input[o + 1] << 16) | (input[o + 2] << 8) | input[o + 3]) >>> 0, 5);
  const rem = input.length - o;
  if (rem > 0) {
    let v = 0;
    for (let i = 0; i < 4; i++) v = ((v << 8) | (i < rem ? input[o + i] : 0)) >>> 0;
    group(v, rem + 1);
  }
  return out.join("");
}

/** base85 payload (without the encoding marker) -> bytes */
export function unpackSamPayload(s: string): Uint8Array {
  if (s.length < PREFIX) throw new SamMaskError("mask payload: missing length prefix");
  let length = 0;
  for (let i = 0; i < PREFIX; i++) length = length * RADIX + digit(s, i);
  const rem = length % 4;
  const expected = PREFIX + Math.floor(length / 4) * 5 + (rem === 0 ? 0 : rem + 1);
  if (s.length !== expected) throw new SamMaskError("mask payload: length does not match prefix");
  const out = new Uint8Array(length);
  let src = PREFIX;
  let dst = 0;
  for (const full = length - rem; dst < full; dst += 4, src += 5) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * RADIX + digit(s, src + i);
    if (v > MASK32) throw new SamMaskError("mask payload: out-of-range group");
    out[dst] = (v >>> 24) & 0xff;
    out[dst + 1] = (v >>> 16) & 0xff;
    out[dst + 2] = (v >>> 8) & 0xff;
    out[dst + 3] = v & 0xff;
  }
  if (rem > 0) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * RADIX + (i < rem + 1 ? digit(s, src + i) : RADIX - 1);
    if (v > MASK32) throw new SamMaskError("mask payload: out-of-range tail");
    for (let i = 0; i < rem; i++) out[dst + i] = (v >>> (24 - i * 8)) & 0xff;
  }
  return out;
}

class RangeEncoder {
  private low = 0;
  private range = MASK32;
  private out: number[] = [];
  encode(cum: number, freq: number, total: number) {
    const r = Math.floor(this.range / total);
    this.low = (this.low + r * cum) >>> 0;
    this.range = r * freq;
    for (;;) {
      if (((this.low ^ (this.low + this.range)) >>> 0) >= TOP) {
        if (this.range >= BOTTOM) break;
        this.range = (-this.low >>> 0) & (BOTTOM - 1);
      }
      this.out.push((this.low >>> 24) & 0xff);
      this.low = (this.low << 8) >>> 0;
      this.range = (this.range << 8) >>> 0;
    }
  }
  finish(): Uint8Array {
    for (let i = 0; i < 4; i++) {
      this.out.push((this.low >>> 24) & 0xff);
      this.low = (this.low << 8) >>> 0;
    }
    return Uint8Array.from(this.out);
  }
}

class RangeDecoder {
  private pos = 0;
  private low = 0;
  private range = MASK32;
  private code = 0;
  private scaled = 0;
  private readonly input: Uint8Array;
  constructor(input: Uint8Array) {
    this.input = input;
    if (input.length < 4) throw new SamMaskError("mask payload: missing finalization");
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.read()) >>> 0;
  }
  freq(total: number): number {
    this.scaled = Math.floor(this.range / total);
    if (this.scaled === 0) throw new SamMaskError("mask payload: invalid coding state");
    const v = Math.floor(((this.code - this.low) >>> 0) / this.scaled);
    return v >= total ? total - 1 : v;
  }
  decode(cum: number, freq: number) {
    this.low = (this.low + this.scaled * cum) >>> 0;
    this.range = this.scaled * freq;
    for (;;) {
      if (((this.low ^ (this.low + this.range)) >>> 0) >= TOP) {
        if (this.range >= BOTTOM) break;
        this.range = (-this.low >>> 0) & (BOTTOM - 1);
      }
      this.code = ((this.code << 8) | this.read()) >>> 0;
      this.low = (this.low << 8) >>> 0;
      this.range = (this.range << 8) >>> 0;
    }
  }
  private read(): number {
    if (this.pos >= this.input.length) throw new SamMaskError("mask payload ended early");
    return this.input[this.pos++];
  }
}

// ---- one_bit --------------------------------------------------------------

const PAD = 2;
const CONTEXTS = 1 << 12;
const BIT_INC = 14;
const BIT_LIMIT = 4096;

function bitContext(r: Uint8Array, p: number, prior: number, earlier: number): number {
  return (
    r[p - 1] |
    (r[p - 2] << 1) |
    (r[prior - 2] << 2) |
    (r[prior - 1] << 3) |
    (r[prior] << 4) |
    (r[prior + 1] << 5) |
    (r[prior + 2] << 6) |
    (r[earlier - 2] << 7) |
    (r[earlier - 1] << 8) |
    (r[earlier] << 9) |
    (r[earlier + 1] << 10) |
    (r[earlier + 2] << 11)
  );
}

function bump(counts: Uint16Array, o: number, bit: number) {
  counts[o + bit] += BIT_INC;
  if (counts[o] + counts[o + 1] >= BIT_LIMIT) {
    counts[o] = counts[o] >> 1 || 1;
    counts[o + 1] = counts[o + 1] >> 1 || 1;
  }
}

/** one_bit encoder (the server never sends masks; tests and probes use it). */
export function encodeOneBit(bits: Uint8Array, width: number, height: number): string {
  if (width <= 0 || height <= 0 || width * height !== bits.length) throw new SamMaskError("mask raster size mismatch");
  const enc = new RangeEncoder();
  const counts = new Uint16Array(CONTEXTS * 2).fill(1);
  const pw = width + 2 * PAD;
  const padded = new Uint8Array(pw * (height + PAD));
  for (let y = 0; y < height; y++) {
    const row = (y + PAD) * pw + PAD;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const o = bitContext(padded, p, p - pw, p - 2 * pw) << 1;
      const zero = counts[o];
      const one = counts[o + 1];
      const bit = bits[y * width + x];
      if (bit !== 0 && bit !== 1) throw new SamMaskError("mask raster is not binary");
      if (bit === 0) enc.encode(0, zero, zero + one);
      else enc.encode(zero, one, zero + one);
      padded[p] = bit;
      bump(counts, o, bit);
    }
  }
  return "!" + packChars(enc.finish());
}

function decodeOneBit(payload: string, width: number, height: number): Uint8Array {
  const dec = new RangeDecoder(unpackSamPayload(payload.slice(1)));
  const counts = new Uint16Array(CONTEXTS * 2).fill(1);
  const pw = width + 2 * PAD;
  const padded = new Uint8Array(pw * (height + PAD));
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = (y + PAD) * pw + PAD;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const o = bitContext(padded, p, p - pw, p - 2 * pw) << 1;
      const zero = counts[o];
      const one = counts[o + 1];
      const bit = dec.freq(zero + one) < zero ? 0 : 1;
      if (bit === 0) dec.decode(0, zero);
      else dec.decode(zero, one);
      padded[p] = bit;
      out[y * width + x] = bit;
      bump(counts, o, bit);
    }
  }
  return out;
}

// ---- lossless (8-bit coverage) ---------------------------------------------

const SYMBOLS = 256;
const ZERO_INC = 32;
const ZERO_LIMIT = 16384;
const O1_INC = 56;
const O1_LIMIT = 8192;
const O2_STEP = 14 * 44;
const O2_LIMIT = 14 * 3584;
const O0_STEP = 2 * 16;
const O0_LIMIT = 2 * 2048;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function predict(out: Uint8Array, o: number, x: number, y: number, mode: number, width: number): number {
  const left = x > 0 ? out[o - 1] : 0;
  const up = y > 0 ? out[o - width] : 0;
  if (mode === 1) return up;
  if (mode === 2) return left;
  if (mode === 3) return (left + up) >> 1;
  const ul = x > 0 && y > 0 ? out[o - width - 1] : 0;
  if (mode === 0) return paeth(left, up, ul);
  // mode 4: median edge detector (LOCO-I)
  if (ul >= Math.max(left, up)) return Math.min(left, up);
  if (ul <= Math.min(left, up)) return Math.max(left, up);
  return left + up - ul;
}

function zeroCtx(res: Uint8Array, o: number, x: number, y: number, width: number): number {
  const l = x > 0 ? (res[o - 1] === 0 ? 1 : 0) : 1;
  const u = y > 0 ? (res[o - width] === 0 ? 1 : 0) : 1;
  const ul = x > 0 && y > 0 ? (res[o - width - 1] === 0 ? 1 : 0) : 1;
  const ur = y > 0 && x < width - 1 ? (res[o - width + 1] === 0 ? 1 : 0) : 1;
  return l | (u << 1) | (ul << 2) | (ur << 3);
}

/** lossless payload -> row-major 8-bit coverage (0..255) */
export function decodeLosslessCoverage(payload: string, width: number, height: number): Uint8Array {
  const packed = unpackSamPayload(payload.slice(1));
  if (packed.length < 5) throw new SamMaskError("lossless mask payload truncated");
  const mode = packed[0];
  if (mode > 4) throw new SamMaskError("lossless mask payload: invalid predictor");
  const dec = new RangeDecoder(packed.subarray(1));
  const n = width * height;
  const out = new Uint8Array(n);
  const res = new Uint8Array(n);
  const zeroCounts = new Uint32Array(32).fill(1);
  const o1 = new Uint16Array(SYMBOLS * SYMBOLS).fill(1);
  const o1Tot = new Int32Array(SYMBOLS).fill(SYMBOLS);
  const o0 = new Uint16Array(SYMBOLS).fill(2);
  let o0Tot = SYMBOLS * 2;
  const o2 = new Map<number, Uint16Array>();
  let prev = 0;
  for (let o = 0; o < n; o++) {
    const x = o % width;
    const y = (o - x) / width;
    const zo = zeroCtx(res, o, x, y, width) << 1;
    const z = zeroCounts[zo];
    const nz = zeroCounts[zo + 1];
    const bit = dec.freq(z + nz) < z ? 0 : 1;
    dec.decode(bit === 0 ? 0 : z, bit === 0 ? z : nz);
    zeroCounts[zo + bit] += ZERO_INC;
    if (zeroCounts[zo] + zeroCounts[zo + 1] >= ZERO_LIMIT) {
      zeroCounts[zo] = zeroCounts[zo] >> 1 || 1;
      zeroCounts[zo + 1] = zeroCounts[zo + 1] >> 1 || 1;
    }
    let sym = 0;
    if (bit === 1) {
      const above = o >= width ? res[o - width] : 0;
      const k2 = (prev << 8) | above;
      let second = o2.get(k2);
      if (!second) o2.set(k2, (second = new Uint16Array(SYMBOLS + 1)));
      const f1 = prev << 8;
      const excludedZero = second[0] + o1[f1] + o0[0];
      const total = second[SYMBOLS] + o1Tot[prev] + o0Tot - excludedZero;
      const target = dec.freq(total);
      let cum = 0;
      sym = 1;
      let f = second[1] + o1[f1 + 1] + o0[1];
      while (cum + f <= target) {
        cum += f;
        if (++sym >= SYMBOLS) throw new SamMaskError("lossless mask payload malformed");
        f = second[sym] + o1[f1 + sym] + o0[sym];
      }
      dec.decode(cum, f);
      second[sym] += O2_STEP;
      second[SYMBOLS] += O2_STEP;
      if (second[SYMBOLS] >= O2_LIMIT) {
        let t = 0;
        for (let v = 0; v < SYMBOLS; v++) t += second[v] = second[v] >> 1;
        second[SYMBOLS] = t;
      }
      o1[f1 + sym] += O1_INC;
      o1Tot[prev] += O1_INC;
      if (o1Tot[prev] >= O1_LIMIT) {
        let t = 0;
        for (let v = 0; v < SYMBOLS; v++) t += o1[f1 + v] = o1[f1 + v] >> 1 || 1;
        o1Tot[prev] = t;
      }
      o0[sym] += O0_STEP;
      o0Tot += O0_STEP;
      if (o0Tot >= O0_LIMIT) {
        let t = 0;
        for (let v = 0; v < SYMBOLS; v++) t += o0[v] = o0[v] >> 1;
        o0Tot = t;
      }
    }
    res[o] = sym;
    const delta = sym & 1 ? -((sym + 1) >> 1) : sym >> 1;
    out[o] = (predict(out, o, x, y, mode, width) + delta) & 0xff;
    prev = sym;
  }
  return out;
}

/** Decode one mask token's data to a binary raster. Throws SamMaskError on anything malformed. */
export function decodeSamMask(m: SamMaskToken): DecodedSamMask {
  const { width, height, payload } = m;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_AREA) {
    throw new SamMaskError("mask dimensions out of range");
  }
  if (payload.startsWith("~")) {
    const cov = decodeLosslessCoverage(payload, width, height);
    const bits = new Uint8Array(cov.length);
    for (let i = 0; i < cov.length; i++) bits[i] = cov[i] >= 129 ? 1 : 0;
    return { width, height, encoding: "lossless", bits };
  }
  if (payload.startsWith("!")) {
    const bits = decodeOneBit(payload, width, height);
    // canonical check, as Meta's parser does: a damaged payload rarely re-encodes to itself
    if (encodeOneBit(bits, width, height) !== payload) throw new SamMaskError("one_bit mask payload not canonical");
    return { width, height, encoding: "one_bit", bits };
  }
  throw new SamMaskError("mask payload: unknown encoding marker");
}

// ---- wire form for the apps -----------------------------------------------

/**
 * What the apps draw (observe.boxes items[].mask): a binary grid stretched over
 * the item's box. Row-major run lengths, alternating, starting with a run of 0s
 * (which may be 0 long). sum(rle) === w * h.
 */
export type WireMask = { w: number; h: number; rle: number[] };

/** Nearest-neighbour downscale so the long side is at most maxSide (never upscales). */
export function downscaleMask(m: { width: number; height: number; bits: Uint8Array }, maxSide: number): { width: number; height: number; bits: Uint8Array } {
  const s = Math.max(m.width, m.height) / maxSide;
  if (s <= 1) return m;
  const width = Math.max(1, Math.round(m.width / s));
  const height = Math.max(1, Math.round(m.height / s));
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(m.height - 1, Math.floor(((y + 0.5) * m.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(m.width - 1, Math.floor(((x + 0.5) * m.width) / width));
      bits[y * width + x] = m.bits[sy * m.width + sx];
    }
  }
  return { width, height, bits };
}

export function toRle(bits: Uint8Array): number[] {
  const rle: number[] = [];
  let cur = 0;
  let run = 0;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === cur) run++;
    else {
      rle.push(run);
      cur = bits[i];
      run = 1;
    }
  }
  rle.push(run);
  return rle;
}

export function fromRle(w: number, h: number, rle: number[]): Uint8Array {
  const bits = new Uint8Array(w * h);
  let i = 0;
  let v = 0;
  for (const n of rle) {
    if (v) bits.fill(1, i, i + n);
    i += n;
    v ^= 1;
  }
  if (i !== w * h) throw new SamMaskError("rle does not cover the mask");
  return bits;
}

/** Mask token -> wire mask (null when it can't be decoded or is empty). */
export function wireMask(m: SamMaskToken, maxSide = 96): WireMask | null {
  try {
    const d = downscaleMask(decodeSamMask(m), maxSide);
    if (!d.bits.some((b) => b === 1)) return null;
    return { w: d.width, h: d.height, rle: toRle(d.bits) };
  } catch {
    return null;
  }
}
