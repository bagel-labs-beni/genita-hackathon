/** One shared voice GPU: reserve a seat for the call, retry overflow only between replies. */
export type VoiceSeats = {
  tryTake(sessionId: string): boolean;
  release(sessionId: string): void;
  holders(): number;
  waiting(): number;
};

export function createVoiceSeats(max: number): VoiceSeats {
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError("Voice capacity must be a nonnegative integer");
  const holders = new Set<string>();
  const waiting = new Set<string>();
  return {
    tryTake(sessionId) {
      if (holders.has(sessionId)) return true;
      if (max !== 0 && holders.size >= max) {
        waiting.add(sessionId);
        return false;
      }
      waiting.delete(sessionId);
      holders.add(sessionId);
      return true;
    },
    release(sessionId) {
      holders.delete(sessionId);
      waiting.delete(sessionId);
    },
    holders: () => holders.size,
    waiting: () => waiting.size,
  };
}
