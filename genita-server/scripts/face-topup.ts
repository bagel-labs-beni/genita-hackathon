/**
 * npm run face:topup -- (--companion <userId> … | --demo) [--dry-run]
 *
 * Ops-only (11/3 night, expression layer): adds the face keys a prepped companion is missing (surprised /
 * concerned, Muse Image + SAM, ~30 s and two image edits per companion) without redoing its face set.
 * --demo = the judge demo template (D41) and every demo companion copied from it. Idempotent: a complete set is left
 * alone. --dry-run only lists what would be made. No "--all": this runs outside the server process, so it can't take
 * part in DELETE /me; each write is re-checked 10 s later and dropped if the companion is gone (codex P1), and it
 * is meant for the ops-owned demo set and named companions only.
 *
 * Env: DATABASE_URL (the server's DB), MODEL_API_KEY, the server's blob env (GENITA_S3_* or GENITA_DATA_DIR).
 * Prints one JSON line per companion; never prints keys.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { blobStoreFromEnv } from "../src/storage/blob.ts";
import { PgPrepStore } from "../src/prep/pgStore.ts";
import { faceKeysFor } from "../src/prep/face.ts";
import { topUpFaceKeys } from "../src/prep/faceTopUp.ts";
import { museImageEdit, samDetect } from "../src/meta/media.ts";

const args = process.argv.slice(2);
const env = process.env;
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required (the server's database)");
if (!env.MODEL_API_KEY && !args.includes("--dry-run")) throw new Error("MODEL_API_KEY is required");
const ids = args.flatMap((a, i) => (a === "--companion" ? [args[i + 1]] : []));
const demo = args.includes("--demo"), dry = args.includes("--dry-run");
if (!ids.length && !demo) throw new Error("say which: --companion <userId> | --demo");

const db = await openDb(env.DATABASE_URL);
const store = new PgPrepStore(db, blobStoreFromEnv(env, join(env.GENITA_DATA_DIR || join(homedir(), ".genita-data"), "blobs")));
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }));
try {
  const list = (await store.listCompanions()).filter((c) => ids.includes(c.userId) || (demo && c.demo === true));
  if (demo) {
    const { DEMO_TEMPLATE_SUB } = await import("../src/prep/demo.ts");
    const { Accounts } = await import("../src/auth/accounts.ts");
    const tplId = await new Accounts(db).findUserId("dev", DEMO_TEMPLATE_SUB);
    const tpl = tplId ? await store.getCompanion(tplId) : null;
    if (tpl && !list.some((c) => c.id === tpl.id)) list.unshift(tpl);
  }
  log("face_topup.plan", { companions: list.length, dry });
  for (const c of list) {
    const f = c.prep.steps.face?.face;
    const missing = f ? faceKeysFor(c.type, f.profile, env).filter((k) => !f.items[k]) : [];
    if (dry) { log("face_topup.would", { userId: c.userId, companionId: c.id, status: c.prep.steps.face?.status, missing }); continue; }
    try {
      const r = await topUpFaceKeys({ store, media: { imageEdit: museImageEdit, samDetect }, metaKey: env.MODEL_API_KEY!, companion: c, env, log });
      log("face_topup.done", r);
    } catch (err) {
      log("face_topup.failed", { userId: c.userId, companionId: c.id, error: String(err).slice(0, 200) });
    }
  }
} finally {
  await db.close();
}
