/**
 * npm run reflow:masks -- [--user <userId>]   (read-only)
 *
 * Ops report (11/4): which faces still have a blend mask from before the SAM face silhouette (flow.maskVersion < 2,
 * the see-through jaw line). Read-only: the server re-flows them itself in the background when they are loaded
 * (runner.reflowMask, log face.reflow) — an out-of-process run could race DELETE /me (codex P1), so there is no
 * --apply here.
 *
 * Env: DATABASE_URL, the blob env (GENITA_S3_* or GENITA_DATA_DIR).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { blobStoreFromEnv } from "../src/storage/blob.ts";
import { PgPrepStore } from "../src/prep/pgStore.ts";
import { needsReflow } from "../src/prep/reflow.ts";

const args = process.argv.slice(2);
const userArg = args.indexOf("--user");
const onlyUser = userArg >= 0 ? args[userArg + 1] : null;
const env = process.env;
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required (the server's database)");
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }));

const db = await openDb(env.DATABASE_URL);
try {
  const blobs = blobStoreFromEnv(env, join(env.GENITA_DATA_DIR || join(homedir(), ".genita-data"), "blobs"));
  const store = new PgPrepStore(db, blobs);
  const all = await store.listCompanions();
  const targets = all.filter((c) => needsReflow(c) && (!onlyUser || c.userId === onlyUser));
  const byKind: Record<string, number> = {};
  for (const c of targets) byKind[c.type] = (byKind[c.type] ?? 0) + 1;
  log("reflow.plan", { companions: all.length, targets: targets.length, byKind });
  for (const c of targets) log("reflow.target", { userId: c.userId, companionId: c.id, type: c.type, name: c.name });
} finally {
  await db.close();
}
