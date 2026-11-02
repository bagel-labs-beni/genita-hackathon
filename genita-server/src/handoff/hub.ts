/**
 * F6-L7 · the conversation layer in one process. Per user it knows the owner (cached from the
 * store), the devices that are connected on /v1/presence and the calls open on /v1/session.
 *
 *   - Sound and lips go only to the owner: calls ask mayPlay() before every audio frame.
 *   - A claim that will change the owner closes the gate and stops the current device's reply
 *     *before* the store is written; the new owner may play only after the write.
 *   - Opening the app (connect / hello) never claims. hello carries the device's last known
 *     (owner, epoch); a newer one than the server's (a tap made while offline) is applied with
 *     the same rule as a claim, so devices and server converge.
 *   - A lock (setActive false) or a dropped socket never changes the owner; the other device
 *     sees it as a `peer` event (R1-E / R2-E).
 *   - move.request is relayed to the other device, which claims; offline/locked → move.failed.
 *
 * Single process: the cache is the gate. With several server instances the store stays correct,
 * but the gate would need a shared channel (Postgres LISTEN/NOTIFY) — not needed for the demo.
 */
import { claimWins, type HandoffDevice, type Ownership } from "./rules.ts";
import type { ClaimOutcome, OwnershipRecord, OwnershipStore } from "./store.ts";

export type { HandoffDevice } from "./rules.ts";
type Msg = Record<string, unknown>;
type LogFn = (event: string, data: Record<string, unknown>) => void;
export type Trigger = "button" | "touch" | "continue" | "start" | "sync" | "move";

type Conn = { device: HandoffDevice; send: (m: Msg) => void; active: boolean };
type Call = { device: HandoffDevice; stop: () => void; send: (m: Msg) => void };
type UserState = {
  id: string;
  record: OwnershipRecord | null;
  loading: Promise<OwnershipRecord> | null;
  conns: Set<Conn>;
  calls: Set<Call>;
  /** claims in flight that will change the owner; the gate is shut while > 0 */
  switching: number;
  /** after a change the new owner waits until then, so the old device's cancel lands first */
  leaseUntil: number;
  chain: Promise<unknown>;
};

export type PresenceHandle = {
  hello(known: { owner?: unknown; epoch?: unknown }): Promise<void>;
  claim(epoch: number | null, trigger: Trigger): Promise<ClaimOutcome>;
  release(epoch: number | null): Promise<ClaimOutcome>;
  moveRequest(to: HandoffDevice): void;
  setActive(active: boolean): void;
  close(): void;
};

export type CallHandle = {
  mayPlay(): boolean;
  /** the call's `start` was handled: a conversation nobody holds goes to this device */
  started(): Promise<void>;
  close(): void;
};

export class HandoffHub {
  private users = new Map<string, UserState>();
  private store: OwnershipStore;
  private log: LogFn;
  private handoverMs: number;
  /**
   * handoverMs: after the owner changes, the new owner's gate stays shut this long. The old device's
   * `utterance.cancelled` goes out first; the lease covers its delivery and the queue flush, since the
   * apps don't acknowledge it. 250 ms is below anything a person notices next to a ≥1.5 s first reply.
   */
  constructor(store: OwnershipStore, log: LogFn = () => {}, opts: { handoverMs?: number } = {}) {
    this.store = store;
    this.log = log;
    this.handoverMs = opts.handoverMs ?? 250;
  }

  /** cached owner, undefined before the first load */
  ownership(userId: string): Ownership | undefined {
    const r = this.users.get(userId)?.record;
    return r ? { owner: r.owner, epoch: r.epoch } : undefined;
  }

  /** Current owner from the store (loads once). */
  async current(userId: string): Promise<OwnershipRecord> {
    return { ...(await this.load(this.user(userId))) };
  }

  connect(userId: string, opts: { device: HandoffDevice; send: (m: Msg) => void }): PresenceHandle {
    const u = this.user(userId);
    const conn: Conn = { device: opts.device, send: opts.send, active: true };
    for (const other of u.conns) if (other.device !== conn.device) conn.send(this.peer(u, other.device));
    u.conns.add(conn);
    this.peerChanged(u, conn.device);
    void this.load(u).then((r) => conn.send(this.ownershipEvent(r, null, "current")), () => {});
    return {
      hello: async (known) => {
        const owner = known.owner === "phone" ? "iphone" : known.owner;
        const epoch = known.epoch;
        if ((owner === "iphone" || owner === "mac") && typeof epoch === "number" && Number.isInteger(epoch) && epoch > 0) {
          const out = await this.claimFor(userId, owner, epoch, "sync", conn);
          if (out.changed) return;
        }
        conn.send(this.ownershipEvent(await this.load(u), null, "current"));
      },
      claim: (epoch, trigger) => this.claimFor(userId, conn.device, epoch, trigger, conn),
      release: (epoch) => this.releaseFor(userId, conn.device, epoch, conn),
      moveRequest: (to) => {
        if (to === conn.device) return;
        const targets = [...u.conns].filter((c) => c.device === to);
        const reason = !targets.length ? "peer_offline" : !targets.some((c) => c.active) ? "peer_inactive" : null;
        if (reason) {
          conn.send({ type: "move.failed", to, reason });
          this.log("handoff.failed", { reason, from: conn.device, to });
          return;
        }
        this.log("handoff.preparing", { from: conn.device, to, trigger: "button" });
        for (const t of targets) if (t.active) t.send({ type: "move.request", from: conn.device });
      },
      setActive: (active) => {
        if (conn.active === active) return;
        conn.active = active;
        this.peerChanged(u, conn.device);
      },
      close: () => {
        if (!u.conns.delete(conn)) return;
        this.peerChanged(u, conn.device);
      },
    };
  }

  attachCall(userId: string, device: HandoffDevice, opts: { stop: () => void; send: (m: Msg) => void }): CallHandle {
    const u = this.user(userId);
    const call: Call = { device, stop: opts.stop, send: opts.send };
    u.calls.add(call);
    void this.load(u).catch(() => {});
    return {
      mayPlay: () => u.switching === 0 && u.record?.owner === device && Date.now() >= u.leaseUntil,
      started: async () => {
        // Checked again inside the serial section: a claim that lands first wins, the start doesn't steal.
        const out = await this.claimFor(userId, device, null, "start", null, true);
        if (!out.changed) call.send(this.ownershipEvent(out.state, null, "current"));
      },
      close: () => void u.calls.delete(call),
    };
  }

  /** This account has `device` open and active on /v1/presence (app running, not locked). */
  isPresent(userId: string, device: HandoffDevice): boolean {
    for (const c of this.users.get(userId)?.conns ?? []) if (c.device === device && c.active) return true;
    return false;
  }

  /** HTTP: claim/release for a device without a presence socket. */
  claimHttp(userId: string, device: HandoffDevice, epoch: number | null, trigger: Trigger): Promise<ClaimOutcome> {
    return this.claimFor(userId, device, epoch, trigger, null);
  }
  releaseHttp(userId: string, device: HandoffDevice, epoch: number | null): Promise<ClaimOutcome> {
    return this.releaseFor(userId, device, epoch, null);
  }

  /** The account was deleted: forget it (sockets are closed by the server). */
  forget(userId: string): void {
    this.users.delete(userId);
  }

  // ───────────────────────── internals ─────────────────────────

  private user(userId: string): UserState {
    let u = this.users.get(userId);
    if (!u) {
      u = { id: userId, record: null, loading: null, conns: new Set(), calls: new Set(), switching: 0, leaseUntil: 0, chain: Promise.resolve() };
      this.users.set(userId, u);
    }
    return u;
  }

  private load(u: UserState): Promise<OwnershipRecord> {
    if (u.record) return Promise.resolve(u.record);
    u.loading ??= this.store.load(u.id).then(
      (r) => {
        u.record ??= r;
        u.loading = null;
        return u.record;
      },
      (e) => {
        u.loading = null;
        throw e;
      },
    );
    return u.loading;
  }

  /** one store write at a time per user, in arrival order */
  private serial<T>(u: UserState, fn: () => Promise<T>): Promise<T> {
    const run = u.chain.then(fn, fn);
    u.chain = run.catch(() => {});
    return run;
  }

  /** Stop the current owner's sound now, before the claim is written. */
  private shutGate(u: UserState, newOwner: HandoffDevice | null): boolean {
    const old = u.record?.owner ?? null;
    if (old === newOwner) return false;
    u.switching++;
    for (const c of u.calls) if (c.device === old) c.stop();
    return true;
  }

  private claimFor(userId: string, device: HandoffDevice, epoch: number | null, trigger: Trigger, from: Conn | null, onlyIfFree = false): Promise<ClaimOutcome> {
    const u = this.user(userId);
    const t0 = Date.now();
    // Predict from the cache synchronously so the old device stops first, even with queued claims.
    const cur = u.record;
    const willChange = !onlyIfFree && !!cur && (epoch === null ? cur.owner !== device : claimWins(cur, { owner: device, epoch }));
    const shut = willChange && this.shutGate(u, device);
    return this.serial(u, async () => {
      try {
        const before = await this.load(u);
        const prev = before.owner;
        if (onlyIfFree && prev !== null) return { accepted: prev === device, changed: false, state: { ...before } };
        // A claim that was not predicted to change (e.g. cache cold) still stops the old device first.
        const late = !shut && (epoch === null ? before.owner !== device : claimWins(before, { owner: device, epoch })) && this.shutGate(u, device);
        try {
          const out = await this.store.claim(userId, device, epoch);
          u.record = out.state;
          if (out.changed && out.state.owner !== prev && prev !== null) u.leaseUntil = Date.now() + this.handoverMs;
          from?.send({ type: "claim.result", accepted: out.accepted, owner: out.state.owner, epoch: out.state.epoch });
          if (out.changed) {
            if (out.state.owner !== prev) this.log("handoff.committed", { from: prev, to: out.state.owner, total_ms: Date.now() - t0, trigger, epoch: out.state.epoch });
            this.broadcast(u, this.ownershipEvent(out.state, device, trigger));
          }
          return out;
        } finally {
          if (late) u.switching--;
        }
      } finally {
        if (shut) u.switching--;
      }
    });
  }

  private releaseFor(userId: string, device: HandoffDevice, epoch: number | null, from: Conn | null): Promise<ClaimOutcome> {
    const u = this.user(userId);
    return this.serial(u, async () => {
      const before = await this.load(u);
      // only a release that will be accepted stops the reply
      const shut = before.owner === device && (epoch === null || epoch >= before.epoch) && this.shutGate(u, null);
      try {
        const out = await this.store.release(userId, device, epoch);
        u.record = out.state;
        from?.send({ type: "claim.result", accepted: out.accepted, owner: out.state.owner, epoch: out.state.epoch });
        if (out.changed) this.broadcast(u, this.ownershipEvent(out.state, device, "release"));
        return out;
      } finally {
        if (shut) u.switching--;
      }
    });
  }

  private ownershipEvent(r: OwnershipRecord, by: HandoffDevice | null, trigger: string): Msg {
    return { type: "ownership", owner: r.owner, epoch: r.epoch, conversationId: r.conversationId, by, trigger };
  }

  private broadcast(u: UserState, m: Msg) {
    for (const c of u.conns) c.send(m);
    for (const c of u.calls) c.send(m);
  }

  private peer(u: UserState, device: HandoffDevice): Msg {
    const conns = [...u.conns].filter((c) => c.device === device);
    return { type: "peer", device, online: conns.length > 0, active: conns.some((c) => c.active) };
  }

  private peerChanged(u: UserState, device: HandoffDevice) {
    const m = this.peer(u, device);
    for (const c of u.conns) if (c.device !== device) c.send(m);
  }
}
