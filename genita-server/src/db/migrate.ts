/**
 * Plain-SQL migrations: src/db/migrations/NNN_name.up.sql + NNN_name.down.sql,
 * applied in order inside one transaction each, tracked in schema_migrations.
 *
 *   npm run db:migrate            up to latest
 *   npm run db:migrate -- down    roll back the last one (down all: `down all`)
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./index.ts";

const DIR = join(import.meta.dirname, "migrations");

export type Migration = { id: string; up: string; down: string };

export async function loadMigrations(dir = DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".up.sql")).sort();
  return Promise.all(
    files.map(async (f) => {
      const id = f.replace(/\.up\.sql$/, "");
      return { id, up: await readFile(join(dir, f), "utf8"), down: await readFile(join(dir, `${id}.down.sql`), "utf8") };
    }),
  );
}

async function applied(db: Db): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  return (await db.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id")).rows.map((r) => r.id);
}

/** Splits on `;` at line ends — enough for our DDL (no functions/DO blocks). */
const statements = (sql: string) =>
  sql
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);

export async function migrateUp(db: Db, migrations?: Migration[]): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  const done = new Set(await applied(db));
  const ran: string[] = [];
  for (const m of all) {
    if (done.has(m.id)) continue;
    await db.tx(async (q) => {
      for (const s of statements(m.up)) await q.query(s);
      await q.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    });
    ran.push(m.id);
  }
  return ran;
}

export async function migrateDown(db: Db, steps = 1, migrations?: Migration[]): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  const done = (await applied(db)).reverse().slice(0, steps);
  const ran: string[] = [];
  for (const id of done) {
    const m = all.find((x) => x.id === id);
    if (!m) throw new Error(`migration ${id} is applied but its files are missing`);
    await db.tx(async (q) => {
      for (const s of statements(m.down)) await q.query(s);
      await q.query("DELETE FROM schema_migrations WHERE id = $1", [id]);
    });
    ran.push(id);
  }
  return ran;
}
