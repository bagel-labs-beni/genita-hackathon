/**
 * Postgres access (F1-L4). One tiny interface so the same repositories run on
 *   - `pg` (node-postgres) Pool        DATABASE_URL=postgres://…   (deployed)
 *   - PGlite (Postgres in WASM)        DATABASE_URL=pglite:memory | pglite:/path/dir
 * PGlite is a devDependency: local dev and unit tests get a real Postgres
 * without Docker. Production installs only `pg`.
 *
 * jsonb parameters are always passed as JSON strings with an explicit
 * `::jsonb` cast (node-postgres turns JS arrays into Postgres arrays).
 */
export type Row = Record<string, any>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface Db extends Queryable {
  /** multi-statement SQL without parameters (migrations) */
  exec(sql: string): Promise<void>;
  /** BEGIN … COMMIT on one connection; ROLLBACK when fn throws */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "pg" | "pglite";
}

type PgPool = import("pg").Pool;

class PgDb implements Db {
  readonly kind = "pg" as const;
  private pool: PgPool;
  constructor(pool: PgPool) {
    this.pool = pool;
  }
  async query<T extends Row = Row>(sql: string, params: unknown[] = []) {
    const r = await this.pool.query(sql, params as any[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }
  async exec(sql: string) {
    await this.pool.query(sql);
  }
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const q: Queryable = {
        query: async <R extends Row = Row>(sql: string, params: unknown[] = []) => {
          const r = await client.query(sql, params as any[]);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
        },
      };
      const out = await fn(q);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  close() {
    return this.pool.end();
  }
}

type PGliteLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  private pg: PGliteLike;
  constructor(pg: PGliteLike) {
    this.pg = pg;
  }
  async query<T extends Row = Row>(sql: string, params: unknown[] = []) {
    const r = await this.pg.query(sql, params);
    return { rows: r.rows as T[], rowCount: r.affectedRows ?? r.rows.length };
  }
  async exec(sql: string) {
    await this.pg.exec(sql);
  }
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction((t) =>
      fn({
        query: async <R extends Row = Row>(sql: string, params: unknown[] = []) => {
          const r = await t.query(sql, params);
          return { rows: r.rows as R[], rowCount: r.affectedRows ?? r.rows.length };
        },
      }),
    );
  }
  close() {
    return this.pg.close();
  }
}

/** Opens DATABASE_URL. `pglite:memory` / `pglite:<dir>` load PGlite lazily (dev only). */
export async function openDb(url: string): Promise<Db> {
  if (url.startsWith("pglite:")) {
    const where = url.slice("pglite:".length);
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = where === "memory" || where === "" ? new PGlite() : new PGlite(where);
    await pg.waitReady;
    return new PgliteDb(pg as unknown as PGliteLike);
  }
  const { default: pg } = await import("pg");
  const ssl = /[?&]sslmode=(require|verify-full|verify-ca)\b/.test(url) || process.env.DATABASE_SSL === "1" ? { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== "1" } : undefined;
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 5), ssl });
  pool.on("error", () => {}); // idle client errors must not crash the process; the next query reconnects
  return new PgDb(pool);
}

export const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
export const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
