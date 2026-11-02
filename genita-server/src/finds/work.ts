/** Account lifetime, independent of a call/socket. Only tombstones survive idle work. */
export class FindsWork {
  private readonly deleted = new Set<string>();
  private readonly pending = new Map<string, Set<() => void>>();
  private readonly writes = new Map<string, Set<Promise<void>>>();

  isDeleted(owner: string): boolean {
    return this.deleted.has(owner);
  }

  /** Keep cancellation reachable even after the call closes; release when its pipeline finishes. */
  track(owner: string | null, cancel: () => void): () => void {
    if (!owner) return () => {};
    if (this.isDeleted(owner)) {
      cancel();
      return () => {};
    }
    const pending = this.pending.get(owner) ?? new Set<() => void>();
    pending.add(cancel);
    this.pending.set(owner, pending);
    return () => {
      pending.delete(cancel);
      if (!pending.size) this.pending.delete(owner);
    };
  }

  /** Track the actual store promise, including writes a pipeline starts without awaiting. */
  async write(owner: string | null, operation: () => Promise<void>): Promise<void> {
    if (owner && this.isDeleted(owner)) return;
    const done = (async () => { await operation(); })();
    if (!owner) return done;
    const writes = this.writes.get(owner) ?? new Set<Promise<void>>();
    writes.add(done);
    this.writes.set(owner, writes);
    try {
      await done;
    } finally {
      writes.delete(done);
      if (!writes.size) this.writes.delete(owner);
    }
  }

  /** Stop future writes first, cancel all calls' work, then drain writes before the caller purges. */
  async deleteOwner(owner: string): Promise<void> {
    this.deleted.add(owner);
    for (const cancel of this.pending.get(owner) ?? []) cancel();
    await Promise.allSettled([...(this.writes.get(owner) ?? [])]);
  }
}
