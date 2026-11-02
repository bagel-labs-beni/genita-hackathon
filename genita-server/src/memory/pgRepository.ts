/**
 * Postgres adapter for long-term memory (migration 005_memory_store). Same contract as
 * InMemoryMemoryRepository: put upserts by memoryId(text) and keeps the first created_at,
 * false = a Forget tombstone blocked it; delete tombstones (one id or all) and removes rows;
 * list never returns tombstoned rows. Every statement is scoped by user_id.
 *
 * The service's per-user locks are in-process, so this is for ONE server process (the AWS box).
 */
import type { Db } from "../db/index.ts";
import { emptyCallState, memoryId, type CallState, type CallStateRepository, type Memory, type MemoryRepository } from "./repository.ts";

const json = (v: unknown) => JSON.stringify(v);

export class PgMemoryRepository implements MemoryRepository, CallStateRepository {
  readonly kind = "pg" as const;
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async put(userId: string, memory: Memory): Promise<boolean> {
    if (memory.id !== memoryId(memory.text)) throw new Error("memory id must match its text");
    return this.db.tx(async (q) => {
      const dead = await q.query("SELECT 1 FROM memory_tombstones WHERE user_id = $1 AND id = $2", [userId, memory.id]);
      if (dead.rows.length) return false;
      await q.query(
        `INSERT INTO memory_items (user_id, id, item_json) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (user_id, id) DO UPDATE
           SET item_json = jsonb_set(EXCLUDED.item_json, '{created_at}', memory_items.item_json->'created_at'), updated_at = now()`,
        [userId, memory.id, json(memory)],
      );
      return true;
    });
  }

  async list(userId: string): Promise<Memory[]> {
    const r = await this.db.query<{ item_json: Memory }>(
      "SELECT item_json FROM memory_items WHERE user_id = $1 ORDER BY created_at, id",
      [userId],
    );
    return r.rows.map((row) => (typeof row.item_json === "string" ? JSON.parse(row.item_json) : row.item_json) as Memory);
  }

  async delete(userId: string, id?: string): Promise<void> {
    await this.db.tx(async (q) => {
      if (id) {
        await q.query("INSERT INTO memory_tombstones (user_id, id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, id]);
        await q.query("DELETE FROM memory_items WHERE user_id = $1 AND id = $2", [userId, id]);
      } else {
        await q.query("INSERT INTO memory_tombstones (user_id, id) SELECT user_id, id FROM memory_items WHERE user_id = $1 ON CONFLICT DO NOTHING", [userId]);
        await q.query("DELETE FROM memory_items WHERE user_id = $1", [userId]);
      }
    });
  }

  async getState(userId: string): Promise<CallState> {
    const r = await this.db.query<{ state_json: CallState | string }>("SELECT state_json FROM memory_state WHERE user_id = $1", [userId]);
    const raw = r.rows[0]?.state_json;
    if (!raw) return emptyCallState();
    const s = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<CallState>;
    const base = emptyCallState();
    return { ...base, ...s, settings: { ...base.settings, ...s.settings } };
  }

  async putState(userId: string, state: CallState): Promise<void> {
    await this.db.query(
      `INSERT INTO memory_state (user_id, state_json) VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = now()`,
      [userId, json(state)],
    );
  }
}
