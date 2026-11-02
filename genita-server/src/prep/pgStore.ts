/**
 * PrepStore on Postgres + blob storage (F1-L4). Same contract as FileStore:
 *   user_styles            ← getStyle/putStyle
 *   companion_images       ← putImage/getImage (bytes in blobs at users/<uid>/images/<id>)
 *   companions + clip_jobs (+ companion_emotions, companion_prefs)  ← companion record
 *   blobs cache/voices/…   ← voice preview cache (not personal data)
 * patchCompanion is a SELECT … FOR UPDATE transaction, so the runner and the
 * prefs route can write the same companion without losing either update.
 */
import { iso, json, type Db, type Queryable } from "../db/index.ts";
import type { BlobStore } from "../storage/blob.ts";
import type { StyleCard } from "./importProfile.ts";
import { PREP_EMOTIONS } from "./prompts.ts";
import type { CompanionRecord, ImageRecord, PrepStore } from "./store.ts";

const imageKey = (userId: string, id: string) => `users/${userId}/images/${id}`;

export class PgPrepStore implements PrepStore {
  readonly db: Db;
  readonly blobs: BlobStore;
  constructor(db: Db, blobs: BlobStore) {
    this.db = db;
    this.blobs = blobs;
  }

  async getStyle(userId: string) {
    const r = await this.db.query("SELECT style_json FROM user_styles WHERE user_id = $1", [userId]);
    return (r.rows[0]?.style_json as StyleCard | undefined) ?? null;
  }

  async putStyle(userId: string, card: StyleCard) {
    await this.db.query(
      `INSERT INTO user_styles (user_id, source, style_json) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET source = EXCLUDED.source, style_json = EXCLUDED.style_json, updated_at = now()`,
      [userId, (card as { source?: string }).source ?? "import", json(card)],
    );
  }

  async putImage(rec: ImageRecord, bytes: Buffer) {
    const key = imageKey(rec.userId, rec.id);
    await this.blobs.put(key, bytes, rec.mime);
    try {
      await this.db.query(
        `INSERT INTO companion_images (id, user_id, mime, bytes, blob_key, check_json, head_box, rights_ack, ms_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10)`,
        [rec.id, rec.userId, rec.mime, rec.bytes, key, json(rec.check), json(rec.headBox), rec.rightsAck, json(rec.ms), rec.createdAt],
      );
    } catch (err) {
      // e.g. the account was deleted while the upload waited on the AI check (FK fails): no orphan photo
      await this.blobs.deletePrefix(key).catch(() => {});
      throw err;
    }
  }

  async getImage(id: string) {
    const r = await this.db.query("SELECT * FROM companion_images WHERE id = $1", [id]);
    const row = r.rows[0];
    if (!row) return null;
    const bytes = await this.blobs.get(row.blob_key);
    if (!bytes) return null;
    const rec: ImageRecord = {
      id: row.id,
      userId: row.user_id,
      mime: row.mime,
      bytes: row.bytes,
      check: row.check_json,
      headBox: row.head_box ?? null,
      rightsAck: row.rights_ack,
      createdAt: iso(row.created_at)!,
      ms: row.ms_json ?? { check: 0, sam: null },
    };
    return { rec, bytes };
  }

  private async read(q: Queryable, userId: string, lock = false): Promise<CompanionRecord | null> {
    const r = await q.query(
      `SELECT c.*, j.state_json, p.depth, p.answers_json, p.updated_at AS prefs_updated_at
       FROM companions c
       JOIN clip_jobs j ON j.companion_id = c.id
       LEFT JOIN companion_prefs p ON p.companion_id = c.id
       WHERE c.user_id = $1${lock ? " FOR UPDATE OF c" : ""}`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    const out: CompanionRecord = {
      id: row.id,
      userId: row.user_id,
      imageId: row.image_id,
      type: row.type,
      voiceId: row.voice_id,
      name: row.name,
      createdAt: iso(row.created_at)!,
      prep: row.state_json,
    };
    if (row.depth) out.prefs = { depth: row.depth, answers: row.answers_json, updatedAt: iso(row.prefs_updated_at)! };
    if (row.persona_card) out.persona = row.persona_card;
    return out;
  }

  private async write(q: Queryable, rec: CompanionRecord) {
    const prep = { ...rec.prep, updatedAt: new Date().toISOString() };
    await q.query(
      `INSERT INTO companions (id, user_id, image_id, type, source_image, voice_id, name, prep_status, persona_card, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (id) DO UPDATE SET voice_id = EXCLUDED.voice_id, name = EXCLUDED.name, prep_status = EXCLUDED.prep_status,
         persona_card = EXCLUDED.persona_card, updated_at = now()`,
      [rec.id, rec.userId, rec.imageId, rec.type, imageKey(rec.userId, rec.imageId), rec.voiceId, rec.name, prep.status, json(rec.persona), rec.createdAt],
    );
    await q.query(
      `INSERT INTO clip_jobs (companion_id, user_id, status, attempts, state_json, started_at, ready_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (companion_id) DO UPDATE SET status = EXCLUDED.status, attempts = EXCLUDED.attempts, state_json = EXCLUDED.state_json,
         ready_at = EXCLUDED.ready_at, updated_at = now()`,
      [rec.id, rec.userId, prep.status, prep.attempts, json(prep), prep.startedAt, prep.readyAt ?? null],
    );
    for (const e of PREP_EMOTIONS) {
      const url = prep.steps.videos[e]?.url;
      if (url)
        await q.query(
          `INSERT INTO companion_emotions (companion_id, emotion, video_url) VALUES ($1, $2, $3)
           ON CONFLICT (companion_id, emotion) DO UPDATE SET video_url = EXCLUDED.video_url`,
          [rec.id, e, url],
        );
      else await q.query("DELETE FROM companion_emotions WHERE companion_id = $1 AND emotion = $2", [rec.id, e]);
    }
    if (rec.prefs)
      await q.query(
        `INSERT INTO companion_prefs (companion_id, depth, answers_json, updated_at) VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (companion_id) DO UPDATE SET depth = EXCLUDED.depth, answers_json = EXCLUDED.answers_json, updated_at = EXCLUDED.updated_at`,
        [rec.id, rec.prefs.depth, json(rec.prefs.answers), rec.prefs.updatedAt],
      );
  }

  getCompanion(userId: string) {
    return this.read(this.db, userId);
  }

  putCompanion(rec: CompanionRecord) {
    return this.db.tx((q) => this.write(q, rec));
  }

  patchCompanion(userId: string, fn: (c: CompanionRecord) => CompanionRecord) {
    return this.db.tx(async (q) => {
      const cur = await this.read(q, userId, true);
      if (!cur) return null;
      const out = fn(cur);
      await this.write(q, out);
      return out;
    });
  }

  async listCompanions() {
    const r = await this.db.query("SELECT user_id FROM companions ORDER BY created_at");
    const out: CompanionRecord[] = [];
    for (const row of r.rows) {
      const c = await this.read(this.db, row.user_id);
      if (c) out.push(c);
    }
    return out;
  }

  getVoicePreview(voiceId: string, version: string) {
    return this.blobs.get(`cache/voices/${voiceId}-${version}.mp3`).catch(() => null);
  }

  putVoicePreview(voiceId: string, version: string, mp3: Buffer) {
    return this.blobs.put(`cache/voices/${voiceId}-${version}.mp3`, mp3, "audio/mpeg");
  }
}
