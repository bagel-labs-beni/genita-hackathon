/**
 * Streaming 24 kHz → 16 kHz resampler for s16le mono (TTS audio → Peter,
 * whose MuseTalk/Whisper front end runs at 16 kHz).
 *
 * Rational 2/3: upsample ×2 (zero-stuff), low-pass at 7 kHz (95-tap
 * Blackman windowed sinc designed at 48 kHz), keep every 3rd sample.
 * Polyphase evaluation, so only real input samples are multiplied.
 * Stateful: chunk boundaries do not change the output.
 */
const TAPS = 95;
const FS_UP = 48000;
const CUTOFF = 7000;

const H: Float64Array = (() => {
  const h = new Float64Array(TAPS);
  const mid = (TAPS - 1) / 2;
  const fc = CUTOFF / FS_UP;
  let sum = 0;
  for (let n = 0; n < TAPS; n++) {
    const x = n - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (TAPS - 1));
    h[n] = sinc * w;
    sum += h[n];
  }
  // unity DC gain after zero-stuffing (×2)
  for (let n = 0; n < TAPS; n++) h[n] = (h[n] / sum) * 2;
  return h;
})();

export class Resampler24to16 {
  private hist: number[] = []; // input samples, hist[0] is absolute index histStart
  private histStart = 0;
  private received = 0;
  private nextOut = 0;
  private carry: number | null = null; // odd trailing byte

  push(chunk: Buffer): Buffer {
    let buf = chunk;
    if (this.carry !== null) {
      buf = Buffer.concat([Buffer.from([this.carry]), chunk]);
      this.carry = null;
    }
    if (buf.length % 2) {
      this.carry = buf[buf.length - 1];
      buf = buf.subarray(0, buf.length - 1);
    }
    for (let i = 0; i < buf.length; i += 2) this.hist.push(buf.readInt16LE(i));
    this.received += buf.length / 2;

    const out: number[] = [];
    // y[m] = Σ_k h[k]·xup[3m−k], xup[2j] = x[j]; needs x up to floor(3m/2)
    while (Math.floor((3 * this.nextOut) / 2) < this.received) {
      const n = 3 * this.nextOut;
      let acc = 0;
      for (let k = n % 2; k < TAPS; k += 2) {
        const j = (n - k) / 2;
        if (j < 0) break;
        const idx = j - this.histStart;
        if (idx < 0) break;
        acc += H[k] * this.hist[idx];
      }
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc))));
      this.nextOut++;
    }
    // drop history no longer needed: oldest j used next is floor((3·next − TAPS)/2)
    const keepFrom = Math.max(0, Math.floor((3 * this.nextOut - TAPS) / 2) - 1);
    if (keepFrom > this.histStart) {
      this.hist.splice(0, keepFrom - this.histStart);
      this.histStart = keepFrom;
    }
    const b = Buffer.alloc(out.length * 2);
    out.forEach((v, i) => b.writeInt16LE(v, i * 2));
    return b;
  }
}
