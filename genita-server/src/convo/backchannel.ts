/**
 * Backchannels (DESIGN §3 P1, #345): during a long user turn, a 1.2 s pause mid-sentence gets a soft "mm" / "yeah"
 * from the companion, the way a friend listens. The server only decides WHEN; the app plays its own short clip
 * (device-side, no Spark, no voice GPU, never a reply). Off unless GENITA_BACKCHANNEL=1 (off for the demo).
 *
 * Rules: the user is mid-turn (speech started, not ended) and has said ≥ 12 words; no new partial for 1.2 s;
 * at most 2 per turn and ≥ 20 s apart (11/4: not too often in one call); never in the first 3 s of a turn. A turn end or a new turn clears the timer.
 */
export type BackchannelKind = "mm" | "yeah";

export const BACKCHANNEL = { pauseMs: 1200, minWords: 12, gapMs: 20_000, maxPerTurn: 2, notBeforeMs: 3000 } as const;

export type BackchannelDeps = {
  now: () => number;
  send: (kind: BackchannelKind) => void;
  /** the session's own check at fire time: chat mode, user still mid-turn, companion not speaking */
  stillListening: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

export class Backchannel {
  private timer: unknown = null;
  private turnStart = 0;
  private fired = 0;
  private lastFired = -Infinity;
  private words = 0;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (t: unknown) => void;

  private readonly d: BackchannelDeps;

  constructor(d: BackchannelDeps) {
    this.d = d;
    this.setT = d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    this.clearT = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** speech started: a new user turn */
  start(): void {
    this.stop();
    this.turnStart = this.d.now();
    this.fired = 0;
    this.words = 0;
  }

  /** a cumulative partial transcript of the current turn */
  partial(text: string): void {
    this.words = text.trim() ? text.trim().split(/\s+/).length : 0;
    this.clear();
    const now = this.d.now();
    if (this.words < BACKCHANNEL.minWords || this.fired >= BACKCHANNEL.maxPerTurn) return;
    // a sentence that just ended is the end of the turn coming, not a mid-sentence pause
    if (/[.?!]\s*$/.test(text)) return;
    const due = Math.max(BACKCHANNEL.pauseMs, this.turnStart + BACKCHANNEL.notBeforeMs - now, this.lastFired + BACKCHANNEL.gapMs - now);
    this.timer = this.setT(() => {
      this.timer = null;
      if (!this.d.stillListening()) return;
      this.fired++;
      this.lastFired = this.d.now();
      this.d.send(this.fired % 2 ? "mm" : "yeah");
    }, due);
  }

  /** speech ended, the turn completed, or the session closed */
  stop(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
  }
}
