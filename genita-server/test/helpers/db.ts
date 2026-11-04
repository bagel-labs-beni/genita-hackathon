/**
 * Test database: a real Postgres when TEST_DATABASE_URL is set (e.g. Docker
 * `postgres:16`), otherwise PGlite in memory (Postgres compiled to WASM, same
 * SQL engine). Each call returns a fresh, migrated database.
 */
import { openDb, type Db } from "../../src/db/index.ts";
import { migrateUp } from "../../src/db/migrate.ts";

export async function testDb(migrate = true): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  let db: Db;
  if (url) {
    db = await openDb(url);
    await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } else db = await openDb("pglite:memory");
  if (migrate) await migrateUp(db);
  return db;
}

/** Every table in public except the migration ledger, with its row count. */
export async function tableCounts(db: Db, userId?: string): Promise<Record<string, number>> {
  const t = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name");
  const out: Record<string, number> = {};
  for (const { table_name } of t.rows) {
    const cols = await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'user_id'", [table_name]);
    const where = userId && cols.rows.length ? " WHERE user_id = $1" : userId && table_name === "users" ? " WHERE id = $1" : "";
    const r = await db.query(`SELECT count(*)::int AS n FROM ${table_name}${where}`, where ? [userId] : []);
    out[table_name] = Number(r.rows[0].n);
  }
  return out;
}
