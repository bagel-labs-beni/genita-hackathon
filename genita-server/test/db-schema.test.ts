import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateDown, migrateUp } from "../src/db/migrate.ts";
import { Accounts } from "../src/auth/accounts.ts";
import { tableCounts, testDb } from "./helpers/db.ts";

const USER_TABLES = [
  "auth_codes",
  "auth_sessions",
  "clip_jobs",
  "companion_emotions",
  "companion_images",
  "companion_prefs",
  "companions",
  "consents",
  "conversations",
  "finds",
  "memories",
  "messages",
  "usage_daily",
  "user_styles",
  "users",
];

/** tables with no user_id: email_codes is keyed by address (the user may not exist yet) */
const ALL_TABLES = [...USER_TABLES, "email_codes"].sort();

test("F1-L4: migrations go up and down on an empty database", async () => {
  const db = await testDb(false);
  try {
    assert.deepEqual(await migrateUp(db), ["001_init", "003_email_login"]);
    assert.deepEqual(await migrateUp(db), [], "second up is a no-op");
    assert.deepEqual(Object.keys(await tableCounts(db)), ALL_TABLES);
    assert.deepEqual(await migrateDown(db), ["003_email_login"]);
    assert.deepEqual(Object.keys(await tableCounts(db)), USER_TABLES);
    assert.deepEqual(await migrateDown(db), ["001_init"]);
    assert.deepEqual(Object.keys(await tableCounts(db)), []);
    assert.deepEqual(await migrateUp(db), ["001_init", "003_email_login"], "up again after down");
  } finally {
    await db.close();
  }
});

test("F1-L4: deleting a user leaves 0 rows in every table (cascade)", async () => {
  const db = await testDb();
  try {
    const accounts = new Accounts(db);
    const { user: u } = await accounts.upsertUser({ provider: "apple", sub: "000123.abc", email: "a@privaterelay.appleid.com", displayName: "Chel" });
    const { user: other } = await accounts.upsertUser({ provider: "apple", sub: "000999.zzz" });
    for (const id of [u.id, other.id]) {
      await accounts.consent(id, "ai_data", "v1", "iphone");
      const s = await accounts.createSession(id, "iphone");
      assert.ok(s.sid);
      await accounts.createCode(id, "mac", "x".repeat(43), false);
      await db.query("INSERT INTO user_styles (user_id, style_json) VALUES ($1, '{}'::jsonb)", [id]);
      const img = `img-${id.slice(0, 8)}`;
      const comp = `c-${id.slice(0, 8)}`;
      await db.query("INSERT INTO companion_images (id, user_id, mime, bytes, blob_key, check_json) VALUES ($1, $2, 'image/jpeg', 3, $3, '{}'::jsonb)", [img, id, `users/${id}/images/${img}`]);
      await db.query("INSERT INTO companions (id, user_id, image_id, type, voice_id, name) VALUES ($1, $2, $3, 'human', 'v', 'Jin')", [comp, id, img]);
      await db.query("INSERT INTO clip_jobs (companion_id, user_id, status, state_json) VALUES ($1, $2, 'running', '{}'::jsonb)", [comp, id]);
      await db.query("INSERT INTO companion_emotions (companion_id, emotion, video_url) VALUES ($1, 'happy', 'https://x/v.mp4')", [comp]);
      await db.query("INSERT INTO companion_prefs (companion_id, depth, answers_json) VALUES ($1, 'right', '{}'::jsonb)", [comp]);
      const conv = (await db.query("INSERT INTO conversations (user_id, companion_id, active_device, epoch) VALUES ($1, $2, 'iphone', 1) RETURNING id", [id, comp])).rows[0].id;
      await db.query("INSERT INTO messages (conversation_id, user_id, role, text) VALUES ($1, $2, 'user', 'hi'), ($1, $2, 'assistant', 'hey')", [conv, id]);
      await db.query("INSERT INTO memories (user_id, companion_id, conversation_id, kind, text) VALUES ($1, $2, $3, 'fact', 'likes tteok')", [id, comp, conv]);
      await db.query("INSERT INTO memories (user_id, companion_id, kind, text, image_ref, box_json) VALUES ($1, $2, 'seen', 'a red mug on the desk', $3, '{\"x1\":1}'::jsonb)", [id, comp, `users/${id}/memories/m1.jpg`]);
      await db.query("INSERT INTO finds (user_id, conversation_id, kind, title, sources) VALUES ($1, $2, 'recipe', 'Kimchi fried rice', '[\"https://a\"]'::jsonb)", [id, conv]);
      await db.query("INSERT INTO usage_daily (user_id, day, turns) VALUES ($1, current_date, 3)", [id]);
    }

    const before = await tableCounts(db, u.id);
    for (const t of USER_TABLES) assert.ok(before[t] > 0 || t === "companion_emotions" || t === "companion_prefs" || t === "messages", `${t} seeded`);

    assert.equal(await accounts.deleteUser(u.id), true);
    const after = await tableCounts(db, u.id);
    // tables without user_id (emotions, prefs, messages) are checked globally below
    for (const [t, n] of Object.entries(after)) if (!["companion_emotions", "companion_prefs"].includes(t)) assert.equal(n, 0, `${t} empty for deleted user`);
    const all = await tableCounts(db);
    assert.equal(all.users, 1, "the other user is untouched");
    assert.equal(all.companion_emotions, 1);
    assert.equal(all.companion_prefs, 1);
    assert.equal(all.messages, 2);
  } finally {
    await db.close();
  }
});

test("seen memories must keep a crop reference, never only text", async () => {
  const db = await testDb();
  try {
    const { user } = await new Accounts(db).upsertUser({ provider: "dev", sub: "x" });
    await assert.rejects(db.query("INSERT INTO memories (user_id, kind, text) VALUES ($1, 'seen', 'no crop')", [user.id]));
  } finally {
    await db.close();
  }
});

test("upsertUser: same Apple sub → same user; name only fills a blank; email refreshes", async () => {
  const db = await testDb();
  try {
    const a = new Accounts(db);
    const first = await a.upsertUser({ provider: "apple", sub: "s1", email: "e1@x", displayName: "Jin Lee" });
    assert.equal(first.isNew, true);
    const again = await a.upsertUser({ provider: "apple", sub: "s1", email: null, displayName: "Other" });
    assert.equal(again.isNew, false);
    assert.equal(again.user.id, first.user.id);
    assert.equal(again.user.displayName, "Jin Lee");
    assert.equal(again.user.email, "e1@x");
    const code = await a.createCode(first.user.id, "mac", "c".repeat(43), true);
    assert.ok(await a.takeCode(code));
    assert.equal(await a.takeCode(code), null, "one-time");
  } finally {
    await db.close();
  }
});
