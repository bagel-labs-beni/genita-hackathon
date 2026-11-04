/**
 * npm run db:migrate                 apply pending migrations to DATABASE_URL
 * npm run db:migrate -- down [n|all] roll back the last n (default 1)
 * Loads GENITA_ENV_FILE (default ~/.config/genita/meta.env) like main.ts.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { loadMigrations, migrateDown, migrateUp } from "../src/db/migrate.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const [dir = "up", n = "1"] = process.argv.slice(2);
const db = await openDb(url);
try {
  const ran = dir === "down" ? await migrateDown(db, n === "all" ? (await loadMigrations()).length : Number(n)) : await migrateUp(db);
  console.log(JSON.stringify({ direction: dir, ran }));
} finally {
  await db.close();
}
