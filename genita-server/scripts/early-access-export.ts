/**
 * Early-access waitlist → CSV on stdout (email, created_at, source), oldest first. Read-only.
 *
 *   DATABASE_URL=postgres://… npm run early-access:export > early-access.csv
 *   npm run early-access:export -- --since 2026-11-05     only signups on/after that date (UTC)
 *
 * Loads GENITA_ENV_FILE (default ~/.config/genita/meta.env) like main.ts. A row count goes to stderr,
 * so the redirected file holds only the CSV. Never prints the connection string.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { toCsv } from "../src/earlyAccess/routes.ts";

const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const args = process.argv.slice(2);
const sinceAt = args.indexOf("--since");
const since = sinceAt >= 0 ? args[sinceAt + 1] : undefined;
if (since !== undefined && Number.isNaN(Date.parse(since ?? ""))) throw new Error("--since needs a date, e.g. 2026-11-05");

const db = await openDb(url);
try {
  const r = await db.query<{ email: string; created_at: Date; source: string | null }>(
    since
      ? "SELECT email, created_at, source FROM early_access WHERE created_at >= $1 ORDER BY created_at, email"
      : "SELECT email, created_at, source FROM early_access ORDER BY created_at, email",
    since ? [new Date(since).toISOString()] : [],
  );
  process.stdout.write(toCsv(r.rows));
  console.error(`early-access: ${r.rows.length} row(s)`);
} finally {
  await db.close();
}
