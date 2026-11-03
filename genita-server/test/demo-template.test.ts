/** D41: the server builds the judge demo template itself at boot (src/prep/demoTemplate.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createAccounts, type AccountsService } from "../src/auth/index.ts";
import { createPrep } from "../src/prep/index.ts";
import { newPrepState } from "../src/prep/runner.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import { DEMO_NAME, DEMO_TEMPLATE_SUB, seedDemoCompanion } from "../src/prep/demo.ts";
import { demoTemplateVersion, demoTemplateWanted, ensureDemoTemplate, startDemoTemplate, type DemoTemplateDeps } from "../src/prep/demoTemplate.ts";
import { testDb } from "./helpers/db.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const CHECK = interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false });

async function boot(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "genita-demo-tpl-"));
  const env: NodeJS.ProcessEnv = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "t".repeat(40) };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const log = (event: string, data: Record<string, unknown>) => events.push({ event, data });
  const accounts = (await createAccounts(env, log, { loopback: true, db: await testDb() })) as AccountsService;
  const prep = createPrep(loadConfig({ MODEL_API_KEY: "m" }), log, env, accounts.prepStore);
  t.after(async () => {
    await accounts.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  let builds = 0;
  /** what the prep routes leave behind: a ready companion with face files under the template account */
  const build: DemoTemplateDeps["build"] = async (tpl) => {
    builds++;
    const id = `tpl${builds}`;
    await accounts.prepStore.putImage({ id: `img${builds}`, userId: tpl, mime: "image/jpeg", bytes: JPEG.length, check: CHECK, headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 1, sam: 1 } } as any, JPEG);
    await accounts.prepStore.putCompanion({
      id, userId: tpl, imageId: `img${builds}`, type: "human", voiceId: prep.deps.voices[0].id, name: DEMO_NAME,
      createdAt: new Date().toISOString(), prep: { ...newPrepState(), status: "ready" as const },
      persona: { card: { name: DEMO_NAME }, rules: [], summary: { why: "a", energy: "b", initiative: "c", never: "d" }, depth: "quick" } as any,
    });
    await accounts.blobs.put(`users/${tpl}/companions/${id}/face/blink`, Buffer.from(`BLINK${builds}`), "image/webp");
    return id;
  };
  const deps = (over: Partial<DemoTemplateDeps> = {}): DemoTemplateDeps => ({
    templateUser: async () => (await accounts.accounts.upsertUser({ provider: "dev", sub: DEMO_TEMPLATE_SUB, displayName: "Demo template" })).user.id,
    prep, blobs: accounts.blobs, log, image: JPEG, build, ...over,
  });
  return { accounts, prep, events, deps, builds: () => builds };
}

test("boot seeding: first run builds and stamps the template; the next boot keeps it (idempotent)", async (t) => {
  const { accounts, events, deps, builds } = await boot(t);
  const first = await ensureDemoTemplate(deps());
  assert.equal(first.status, "seeded");
  assert.equal(builds(), 1);
  assert.ok(events.some((e) => e.event === "demo.template.seeded" && e.data.companionId === "tpl1" && e.data.files === 1));
  const again = await ensureDemoTemplate(deps());
  assert.equal(again.status, "current");
  assert.equal(builds(), 1, "a ready template with the same version is not rebuilt");
  assert.ok(events.some((e) => e.event === "demo.template.current"));
  // judges get it: the existing sign-in seed copies this template
  const { user } = await accounts.accounts.upsertUser({ provider: "dev", sub: "judge:alpha" });
  const seeded = await seedDemoCompanion({ store: accounts.prepStore, blobs: accounts.blobs, templateUserId: () => accounts.accounts.findUserId("dev", DEMO_TEMPLATE_SUB), log: () => {} }, user.id);
  assert.equal(seeded.seeded, true);
});

test("a new version (photo or DEMO_TEMPLATE_VERSION) drops the old template and rebuilds it", async (t) => {
  const { accounts, events, deps, builds } = await boot(t);
  await ensureDemoTemplate(deps());
  const tpl = (await accounts.accounts.findUserId("dev", DEMO_TEMPLATE_SUB))!;
  const r = await ensureDemoTemplate(deps({ image: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7]) }));
  assert.equal(r.status, "seeded");
  assert.equal(builds(), 2);
  assert.equal((await accounts.prepStore.getCompanion(tpl))!.id, "tpl2");
  assert.deepEqual(await accounts.blobs.list(`users/${tpl}/companions/tpl1/`), [], "old template files dropped");
  assert.ok(events.some((e) => e.event === "demo.template.dropped" && e.data.companionId === "tpl1"));
  assert.notEqual(demoTemplateVersion(JPEG, "v"), demoTemplateVersion(Buffer.from([1]), "v"));
});

test("a template that is not ready (half-built before a restart) is rebuilt", async (t) => {
  const { accounts, deps, builds } = await boot(t);
  await ensureDemoTemplate(deps());
  const tpl = (await accounts.accounts.findUserId("dev", DEMO_TEMPLATE_SUB))!;
  await accounts.prepStore.patchCompanion(tpl, (c) => ({ ...c, prep: { ...c.prep, status: "running" } }));
  assert.equal((await ensureDemoTemplate(deps())).status, "seeded");
  assert.equal(builds(), 2);
});

test("a failed build is only logged (no throw), leaves no stamp, and the boot hook retries once", async (t) => {
  const { events, deps, builds } = await boot(t);
  let fail = true;
  const flaky: DemoTemplateDeps["build"] = async (tpl, img) => {
    if (fail) { fail = false; throw new Error("spark 504"); }
    return deps().build!(tpl, img);
  };
  const r = await ensureDemoTemplate(deps({ build: flaky }));
  assert.equal(r.status, "failed");
  assert.ok(events.some((e) => e.event === "demo.template.failed" && String(e.data.message).includes("spark 504")));
  // boot hook: fails once, retries after the delay, then seeds
  fail = true;
  const hook = startDemoTemplate(deps({ build: flaky }), 20);
  for (let i = 0; i < 100 && !events.some((e) => e.event === "demo.template.seeded"); i++) await new Promise((res) => setTimeout(res, 20));
  hook.stop();
  assert.ok(events.some((e) => e.event === "demo.template.seeded"), "the retry seeded it");
  assert.equal(builds(), 1);
});

test("on only for the hosted server: Postgres + Judge access codes; GENITA_DEMO_TEMPLATE=0/1 overrides", () => {
  assert.equal(demoTemplateWanted({ GENITA_JUDGE_CODES: "a=b" }, "pg"), true);
  assert.equal(demoTemplateWanted({}, "pg"), false, "no judge codes: nobody to copy it to");
  assert.equal(demoTemplateWanted({ GENITA_JUDGE_CODES: "a=b" }, "pglite"), false, "local mode / tests never call Meta at boot");
  assert.equal(demoTemplateWanted({ GENITA_JUDGE_CODES: "a=b", GENITA_DEMO_TEMPLATE: "0" }, "pg"), false);
  assert.equal(demoTemplateWanted({ GENITA_DEMO_TEMPLATE: "1" }, "pglite"), true);
});
