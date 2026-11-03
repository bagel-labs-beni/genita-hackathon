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
import { demoTemplateVersion, demoTemplateWanted, ensureDemoTemplate, readDemoPointer, startDemoTemplate, templateSub, type DemoTemplateDeps } from "../src/prep/demoTemplate.ts";
import { configureOps } from "../src/ops/limits.ts";
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
    templateUser: async (sub) => (await accounts.accounts.upsertUser({ provider: "dev", sub, displayName: "Demo template" })).user.id,
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
  const pointer = (await readDemoPointer(accounts.blobs))!;
  assert.equal(pointer.companionId, "tpl1");
  const seeded = await seedDemoCompanion({ store: accounts.prepStore, blobs: accounts.blobs, templateUserId: async () => (await readDemoPointer(accounts.blobs))?.userId ?? null, log: () => {} }, user.id);
  assert.equal(seeded.seeded, true);
});

test("a new version is built in its own account; the old template stays until the pointer moves (nothing a judge copies is deleted)", async (t) => {
  const { accounts, deps, builds } = await boot(t);
  await ensureDemoTemplate(deps());
  const old = (await readDemoPointer(accounts.blobs))!;
  const img2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7]);
  const r = await ensureDemoTemplate(deps({ image: img2 }));
  assert.equal(r.status, "seeded");
  assert.equal(builds(), 2);
  const now = (await readDemoPointer(accounts.blobs))!;
  assert.notEqual(now.userId, old.userId, "one account per version");
  assert.equal(now.companionId, "tpl2");
  assert.equal((await accounts.prepStore.getCompanion(old.userId))!.id, "tpl1", "old template kept");
  assert.equal((await accounts.blobs.list(`users/${old.userId}/companions/tpl1/`)).length, 1, "old files kept");
  assert.notEqual(templateSub(demoTemplateVersion(JPEG, "v")), templateSub(demoTemplateVersion(img2, "v")));
});

test("another process building this version (running, not ours, fresh) is left alone; the pointer is not moved", async (t) => {
  const { accounts, prep, deps, builds, events } = await boot(t);
  const version = demoTemplateVersion(JPEG, prep.deps.voices[0].id);
  const tpl = (await accounts.accounts.upsertUser({ provider: "dev", sub: templateSub(version) })).user.id;
  await deps().build!(tpl, JPEG);
  await accounts.prepStore.patchCompanion(tpl, (c) => ({ ...c, prep: { ...c.prep, status: "running" } }));
  const r = await ensureDemoTemplate(deps());
  assert.equal(r.status, "busy");
  assert.equal(builds(), 1, "no second build");
  assert.equal(await readDemoPointer(accounts.blobs), null);
  assert.ok(events.some((e) => e.event === "demo.template.busy"));
  // it finished elsewhere: the next run only moves the pointer
  await accounts.prepStore.patchCompanion(tpl, (c) => ({ ...c, prep: { ...c.prep, status: "ready" } }));
  assert.equal((await ensureDemoTemplate(deps())).status, "seeded");
  assert.equal(builds(), 1);
  assert.equal((await readDemoPointer(accounts.blobs))!.userId, tpl);
});

test("ops pause: nothing is generated at boot", async (t) => {
  const { accounts, deps, builds, events } = await boot(t);
  configureOps({ paused: true });
  t.after(() => { configureOps({}); });
  const r = await ensureDemoTemplate(deps());
  assert.equal(r.status, "failed");
  assert.equal(builds(), 0);
  assert.equal(await readDemoPointer(accounts.blobs), null);
  assert.ok(events.some((e) => e.event === "demo.template.failed" && e.data.message === "Error: paused"));
});

test("a judge copy refuses an empty template (never a ready companion without a face)", async (t) => {
  const { accounts } = await boot(t);
  const tpl = (await accounts.accounts.upsertUser({ provider: "dev", sub: "demo:template:empty" })).user.id;
  await accounts.prepStore.putImage({ id: "e1", userId: tpl, mime: "image/jpeg", bytes: JPEG.length, check: CHECK, headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 1, sam: 1 } } as any, JPEG);
  await accounts.prepStore.putCompanion({ id: "empty", userId: tpl, imageId: "e1", type: "human", voiceId: "x", name: DEMO_NAME, createdAt: new Date().toISOString(), prep: { ...newPrepState(), status: "ready" as const } } as any);
  const { user } = await accounts.accounts.upsertUser({ provider: "dev", sub: "judge:e" });
  const r = await seedDemoCompanion({ store: accounts.prepStore, blobs: accounts.blobs, templateUserId: async () => tpl, log: () => {} }, user.id);
  assert.equal(r.reason, "template_empty");
  assert.equal(await accounts.prepStore.getCompanion(user.id), null);
});

test("a failed template in this version's account is rebuilt", async (t) => {
  const { accounts, deps, builds } = await boot(t);
  await ensureDemoTemplate(deps());
  const tpl = (await readDemoPointer(accounts.blobs))!.userId;
  // crashed build: failed status in this version's own account → rebuilt
  await accounts.prepStore.patchCompanion(tpl, (c) => ({ ...c, prep: { ...c.prep, status: "failed" } }));
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
