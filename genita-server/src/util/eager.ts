/**
 * Starts consuming an async iterable immediately and buffers its items, so
 * sentence N+1's TTS can be fetched while sentence N is still being sent.
 * The reader still sees items strictly in order; a producer error surfaces
 * to the reader after the items produced before it.
 */
export class Eager<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private done = false;
  private error: unknown = null;
  private wake: (() => void) | null = null;

  constructor(source: AsyncIterable<T>) {
    void (async () => {
      try {
        for await (const v of source) {
          this.items.push(v);
          this.notify();
        }
      } catch (err) {
        this.error = err ?? new Error("producer failed");
      } finally {
        this.done = true;
        this.notify();
      }
    })();
  }

  private notify() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.done) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}
