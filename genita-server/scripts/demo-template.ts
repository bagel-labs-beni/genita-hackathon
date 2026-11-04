/**
 * npm run demo:template -- [--image <path>] [--force]
 *
 * Ops-only (D41): prepares the judge demo companion template once. Runs the server's normal
 * prep (photo check → companion → whatever prep pipeline this build has → prefs/persona) for
 * the sample person (--image <path>; default assets/demo/jin.jpg, which is not in the
 * public repository) under the reserved account provider "dev", sub "demo:template",
 * name "Jin", the default voice. Judge sign-ins then copy it (src/prep/demo.ts).
 *
 * Env: DATABASE_URL (the server's DB), MODEL_API_KEY, the server's blob env (GENITA_S3_* or
 * GENITA_DATA_DIR) and prep flags. It never resumes other users' prep, and the routes it calls
 * listen only on 127.0.0.1 for the length of the run.
 * A ready template is kept unless --force; re-run with --force after the prep pipeline changes
 * (e.g. once the Meta face set lands) so new judge accounts get the new assets.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrateUp } from "../src/db/migrate.ts";
import { Accounts } from "../src/auth/accounts.ts";
import { blobStoreFromEnv } from "../src/storage/blob.ts";
import { PgPrepStore } from "../src/prep/pgStore.ts";
import { createPrep } from "../src/prep/index.ts";
import { DEMO_NAME, DEMO_TEMPLATE_SUB } from "../src/prep/demo.ts";

const args = process.argv.slice(2);
const force = args.includes("--force");
const imgArg = args.indexOf("--image");
const imagePath = imgArg >= 0 ? args[imgArg + 1] : join(import.meta.dirname, "../assets/demo/jin.jpg");
const env = process.env;
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required (the server's database)");

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }));

/** The script's own store: the prep runner's boot-time resume must not pick up real users' companions. */
class TemplateOnlyStore extends PgPrepStore {
  async listCompanions() {
    return [];
  }
}

const db = await openDb(env.DATABASE_URL);
await migrateUp(db);
const blobs = blobStoreFromEnv(env, join(env.GENITA_DATA_DIR || join(homedir(), ".genita-data"), "blobs"));
const store = new TemplateOnlyStore(db, blobs);
const { user } = await new Accounts(db).upsertUser({ provider: "dev", sub: DEMO_TEMPLATE_SUB, displayName: "Demo template" });
const tpl = user.id;

try {
  const cur = await store.getCompanion(tpl);
  if (cur?.prep.status === "ready" && !force) {
    log("demo_template.kept", { templateUserId: tpl, companionId: cur.id, hint: "--force to rebuild" });
    process.exitCode = 0;
  } else {
    if (cur) {
      await store.deleteCompanion(tpl);
      log("demo_template.dropped_old", { companionId: cur.id, status: cur.prep.status });
    }
    const prep = createPrep(loadConfig(env), log, env, store);
    const http = createServer((req, res) => void prep.routes.handle(req, res, tpl));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
      const r = await fetch(base + path, { method, headers: { "content-type": raw ? "image/jpeg" : "application/json" }, body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body) });
      const json = (await r.json()) as Record<string, any>;
      if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(json).slice(0, 300)}`);
      return json;
    };
    try {
      const check = await call("POST", "/v1/companion/image?rights=1", undefined, readFileSync(imagePath));
      if (!check.passed) throw new Error(`sample photo did not pass the check: ${JSON.stringify(check.reasons)}`);
      log("demo_template.photo_ok", { type: check.type, ms: check.ms });
      const voiceId = prep.deps.voices[0].id; // the default voice
      const made = await call("POST", "/v1/companion", { imageId: check.imageId, voiceId, name: DEMO_NAME });
      const tPrep = performance.now();
      await prep.runner.run(tpl);
      log("demo_template.prep_done", { ms: Math.round(performance.now() - tPrep) });
      await call("POST", "/v1/companion/prefs", { depth: "quick", answers: { help: "Be there", relationship: "Close companion", presence: ["Warm", "Witty"] } });
      const c = await call("GET", "/v1/companion");
      if (c.prep.status !== "ready") throw new Error(`template prep ended ${c.prep.status}`);
      const files = await blobs.list(`users/${tpl}/companions/${made.id}/`);
      log("demo_template.ready", { templateUserId: tpl, companionId: c.id, name: c.name, voiceId, type: c.type, files: files.length, total_ms: ms() });
    } finally {
      http.close();
    }
  }
} finally {
  await db.close();
}
