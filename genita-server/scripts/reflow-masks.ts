/**
 * npm run reflow:masks -- [--apply] [--limit N] [--user <userId>]
 *
 * Ops one-off (11/4, build 7): faces prepped before the SAM face-silhouette mask (flow.maskVersion < 2) showed a
 * see-through double jaw line under the chin. This re-runs only their flow step (keys kept), one face at a time
 * (one account after another: never two runs at once). Default is a dry run that lists the targets and counts;
 * --apply runs them. The judge demo template (provider dev, sub demo:template) is a normal companion here, so it is
 * included; judges copied from it before the run are their own companions and are included too.
 *
 * Env: DATABASE_URL, MODEL_API_KEY (SAM), the blob env (GENITA_S3_* or GENITA_DATA_DIR), GENITA_PYFLOW (python with
 * OpenCV; the AWS box has /opt/genita/pyflow). Run on the server box after the deploy.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { blobStoreFromEnv } from "../src/storage/blob.ts";
import { PgPrepStore } from "../src/prep/pgStore.ts";
import { needsReflow, reflowFace } from "../src/prep/reflow.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limArg = args.indexOf("--limit");
const limit = limArg >= 0 ? Math.max(1, Number(args[limArg + 1]) || 1) : Infinity;
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
  log("reflow.plan", { companions: all.length, targets: targets.length, byKind, apply, limit: Number.isFinite(limit) ? limit : null });
  if (!apply) {
    for (const c of targets) log("reflow.target", { userId: c.userId, companionId: c.id, type: c.type, name: c.name });
  } else {
    const config = loadConfig(env);
    const d = { metaKey: config.metaKey, store, log, python: env.GENITA_PYFLOW === "0" ? null : env.GENITA_PYFLOW || "python3" } as unknown as PrepDeps;
    let done = 0, failed = 0, n = 0;
    for (const c of targets) {   // sequential on purpose: one SAM + faceflow run at a time
      if (n++ >= limit) break;
      const r = await reflowFace(d, c).catch((e) => ({ status: "failed" as const, reason: String(e).slice(0, 200) }));
      if (r.status === "done") done++;
      else if (r.status === "failed") failed++;
      log("reflow.face", { userId: c.userId, companionId: c.id, type: c.type, ...r });
    }
    log("reflow.summary", { done, failed, ran: Math.min(n, targets.length), left: targets.length - done });
    process.exitCode = failed ? 1 : 0;
  }
} finally {
  await db.close();
}
