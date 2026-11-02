/**
 * F6-L7 · where the owner and epoch live: conversations.active_device / conversations.epoch
 * (migration 001). One live conversation per user: the most recently active row, created on
 * first use. Every claim is one conditional UPDATE, so two devices racing on two server
 * connections still end on the same row state (Postgres re-checks the WHERE under the row lock).
 *
 * `accepted` = "the claiming device holds the sound now". `changed` = the row moved.
 */
import type { Db } from "../db/index.ts";
import { claimWins, MAX_EPOCH, type HandoffDevice, type Ownership } from "./rules.ts";

export type OwnershipRecord = Ownership & { conversationId: string };
export type ClaimOutcome = { accepted: boolean; changed: boolean; state: OwnershipRecord };

export interface OwnershipStore {
  load(userId: string): Promise<OwnershipRecord>;
  /** epoch null = the server assigns current + 1 (a no-op when the device already owns it) */
  claim(userId: string, device: HandoffDevice, epoch: number | null): Promise<ClaimOutcome>;
  /** only the owner can release; epoch, when given, must not be older than the current one */
  release(userId: string, device: HandoffDevice, epoch: number | null): Promise<ClaimOutcome>;
}

export class MemoryOwnershipStore implements OwnershipStore {
  private rows = new Map<string, OwnershipRecord>();
  private seq = 0;
  /** synchronous read-decide-write, like the single UPDATE in Postgres */
  private get(userId: string): OwnershipRecord {
    let r = this.rows.get(userId);
    if (!r) {
      r = { conversationId: `mem-${++this.seq}`, owner: null, epoch: 0 };
      this.rows.set(userId, r);
    }
    return { ...r };
  }
  async load(userId: string): Promise<OwnershipRecord> {
    return this.get(userId);
  }
  async claim(userId: string, device: HandoffDevice, epoch: number | null): Promise<ClaimOutcome> {
    const cur = this.get(userId);
    let next: Ownership | null = null;
    if (epoch === null) {
      if (cur.owner !== device && cur.epoch < MAX_EPOCH) next = { owner: device, epoch: cur.epoch + 1 };
    } else if (claimWins(cur, { owner: device, epoch })) next = { owner: device, epoch };
    if (next) this.rows.set(userId, { ...cur, ...next });
    const state = this.get(userId);
    return { accepted: state.owner === device, changed: !!next, state };
  }
  async release(userId: string, device: HandoffDevice, epoch: number | null): Promise<ClaimOutcome> {
    const cur = this.get(userId);
    const ok = cur.owner === device && (epoch === null || epoch >= cur.epoch) && cur.epoch < MAX_EPOCH;
    if (ok) this.rows.set(userId, { ...cur, owner: null, epoch: cur.epoch + 1 });
    return { accepted: ok, changed: ok, state: this.get(userId) };
  }
}

type Row = { id: string; active_device: HandoffDevice | null; epoch: number };
const record = (r: Row): OwnershipRecord => ({ conversationId: r.id, owner: r.active_device, epoch: Number(r.epoch) });

export class PgOwnershipStore implements OwnershipStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  private async row(userId: string): Promise<Row> {
    const pick = "SELECT id, active_device, epoch FROM conversations WHERE user_id = $1 ORDER BY last_active_at DESC, started_at DESC LIMIT 1";
    const found = await this.db.query<Row>(pick, [userId]);
    if (found.rows[0]) return found.rows[0];
    const made = await this.db.query<Row>("INSERT INTO conversations (user_id) VALUES ($1) RETURNING id, active_device, epoch", [userId]);
    return made.rows[0];
  }
  async load(userId: string): Promise<OwnershipRecord> {
    return record(await this.row(userId));
  }
  async claim(userId: string, device: HandoffDevice, epoch: number | null): Promise<ClaimOutcome> {
    const { id } = await this.row(userId);
    const sql =
      epoch === null
        ? `UPDATE conversations SET active_device = $2, epoch = epoch + 1, last_active_at = now()
             WHERE id = $1 AND active_device IS DISTINCT FROM $2 AND epoch < ${MAX_EPOCH}
             RETURNING id, active_device, epoch`
        : `UPDATE conversations SET active_device = $2, epoch = $3, last_active_at = now()
             WHERE id = $1 AND ($3 > epoch OR ($3 = epoch AND active_device IS DISTINCT FROM $2 AND ($2 = 'mac' OR active_device IS NULL)))
             RETURNING id, active_device, epoch`;
    const r = await this.db.query<Row>(sql, epoch === null ? [id, device] : [id, device, epoch]);
    const state = r.rows[0] ? record(r.rows[0]) : await this.load(userId);
    return { accepted: state.owner === device, changed: r.rows.length > 0, state };
  }
  async release(userId: string, device: HandoffDevice, epoch: number | null): Promise<ClaimOutcome> {
    const { id } = await this.row(userId);
    const r = await this.db.query<Row>(
      `UPDATE conversations SET active_device = NULL, epoch = epoch + 1, last_active_at = now()
         WHERE id = $1 AND active_device = $2 AND ($3::int IS NULL OR $3::int >= epoch) AND epoch < ${MAX_EPOCH}
         RETURNING id, active_device, epoch`,
      [id, device, epoch],
    );
    const state = r.rows[0] ? record(r.rows[0]) : await this.load(userId);
    return { accepted: r.rows.length > 0, changed: r.rows.length > 0, state };
  }
}
