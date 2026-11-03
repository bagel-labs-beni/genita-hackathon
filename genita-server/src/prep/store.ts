/**
 * Prep storage. Without DATABASE_URL this is a JSON-file
 * store under GENITA_DATA_DIR (default ~/.genita-data). The interface is
 * what the DB version must keep: user_styles, companion images, companions
 * (+ prep state = clip_jobs), companion_prefs, voice preview cache.
 *
 * Writes are atomic (tmp + rename) and serialized per file, so a crash or a
 * restart mid-prep leaves the last good state on disk; the runner resumes
 * from it (F2-L9 "서버 재시작해도 이어짐").
 * Raw pasted import text is never passed in here.
 */
import { mkdir, readFile, rename, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ImageCheck } from "./classify.ts";
import type { SamBox } from "../meta/sam.ts";
import type { FacePoint, FacePoints } from "./faceGeometry.ts";
import type { StyleCard } from "./importProfile.ts";
import type { CompanionKind, PrepEmotion } from "./prompts.ts";
import type { FaceState } from "./face.ts";
import type { Depth, PersonaResult, SetupAnswers } from "./personaCard.ts";

/** `skipped` = a legacy video/lip step outside the Meta pipeline */
export type StepStatus = "pending" | "running" | "done" | "failed" | "todo" | "skipped";
export type Step = {
  status: StepStatus;
  attempts: number;
  error?: string;
  ms?: number;
  url?: string;
  source?: string;
  /** face: the face set so far (settled keys, scene boxes); a rerun redoes only the missing keys */
  face?: FaceState;
};

export type PrepState = {
  status: "running" | "ready" | "failed";
  /** runner passes; capped by MAX_PREP_ATTEMPTS, reset by POST /companion/prep/retry */
  attempts: number;
  steps: {
    scene: Step;
    videos: Record<PrepEmotion, Step>;
    /** Legacy lip step retained for persisted records. */
    lips: Step;
    /** Meta-only face set (expressions + visemes); absent on older persisted records */
    face?: Step;
  };
  startedAt: string;
  readyAt?: string;
  updatedAt: string;
};

export type ImageRecord = {
  id: string;
  userId: string;
  mime: string;
  bytes: number;
  check: ImageCheck;
  headBox: SamBox | null;
  /** every head SAM found, for the upload answer only (group photo → pick someone else); not kept by the DB store */
  heads?: SamBox[];
  /** V03 face scan (faceGeometry.ts), for the upload answer only; not kept by the DB store */
  faceOutline?: FacePoint[] | null;
  facePoints?: FacePoints | null;
  rightsAck: boolean;
  createdAt: string;
  ms: { check: number; sam: number | null };
};

export type CompanionRecord = {
  id: string;
  userId: string;
  imageId: string;
  type: CompanionKind;
  voiceId: string;
  name: string;
  createdAt: string;
  prep: PrepState;
  prefs?: { depth: Depth; answers: SetupAnswers; updatedAt: string };
  persona?: PersonaResult;
  /** D41: the ready-made "Jin" a judge account starts with (src/prep/demo.ts); POST /v1/companion replaces it */
  demo?: boolean;
};

export interface PrepStore {
  getStyle(userId: string): Promise<StyleCard | null>;
  putStyle(userId: string, card: StyleCard): Promise<void>;
  /** "Forget all of this" (AU-92): the account's profile row goes (import, HISY, corrections, insights) */
  deleteStyle?(userId: string): Promise<void>;
  putImage(rec: ImageRecord, bytes: Buffer): Promise<void>;
  getImage(id: string): Promise<{ rec: ImageRecord; bytes: Buffer } | null>;
  getCompanion(userId: string): Promise<CompanionRecord | null>;
  putCompanion(rec: CompanionRecord): Promise<void>;
  /** serialized read-modify-write; the runner (prep) and prefs (persona) both write the same record */
  patchCompanion(userId: string, fn: (c: CompanionRecord) => CompanionRecord): Promise<CompanionRecord | null>;
  listCompanions(): Promise<CompanionRecord[]>;
  getVoicePreview(voiceId: string, version: string): Promise<Buffer | null>;
  putVoicePreview(voiceId: string, version: string, audio: Buffer): Promise<void>;
  /** removes the user's companion (and, on Postgres, its photo and users/<id>/companions/<cid>/ files); false if none */
  deleteCompanion(userId: string): Promise<boolean>;
  /**
   * D41: swap the user's demo companion `demoId` for `rec` in one step (the old one's photo and files go,
   * unless `rec` reuses the photo). False, with nothing written, when the current companion is not that demo one.
   */
  replaceDemoCompanion(demoId: string, rec: CompanionRecord): Promise<boolean>;
  /** drops one of the user's photos (row + bytes); cleans up a demo seed that failed half-way */
  deleteImage(userId: string, imageId: string): Promise<void>;
  /**
   * Companion images (scene = `neutral`, face set keys), served by GET /v1/companion/face/:key.
   * Kept under the user (blob key users/<userId>/companions/<companionId>/face/<name>), so
   * DELETE /me removes them with the user's other files.
   */
  putAsset(userId: string, companionId: string, name: string, bytes: Buffer): Promise<void>;
  getAsset(userId: string, companionId: string, name: string): Promise<Buffer | null>;
  /** drops every image of a companion, or of every companion of the user when companionId is omitted */
  deleteAssets(userId: string, companionId?: string): Promise<void>;
}

const safe = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("bad id");
  return id;
};

export class FileStore implements PrepStore {
  readonly dir: string;
  private chains = new Map<string, Promise<void>>();
  constructor(dir: string) {
    this.dir = dir;
  }

  private async read<T>(rel: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, rel), "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private write(rel: string, data: string | Buffer): Promise<void> {
    const path = join(this.dir, rel);
    const prev = this.chains.get(path) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await mkdir(join(path, ".."), { recursive: true });
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmp, data);
        await rename(tmp, path);
      });
    this.chains.set(path, next);
    return next;
  }

  async getStyle(userId: string) {
    return this.read<StyleCard>(`styles/${safe(userId)}.json`);
  }
  putStyle(userId: string, card: StyleCard) {
    return this.write(`styles/${safe(userId)}.json`, JSON.stringify(card, null, 1));
  }
  async deleteStyle(userId: string) {
    await rm(join(this.dir, `styles/${safe(userId)}.json`), { force: true });
  }
  async putImage(rec: ImageRecord, bytes: Buffer) {
    await this.write(`images/${safe(rec.id)}.bin`, bytes);
    await this.write(`images/${safe(rec.id)}.json`, JSON.stringify(rec, null, 1));
  }
  async getImage(id: string) {
    const rec = await this.read<ImageRecord>(`images/${safe(id)}.json`);
    if (!rec) return null;
    return { rec, bytes: await readFile(join(this.dir, `images/${safe(id)}.bin`)) };
  }
  async getCompanion(userId: string) {
    return this.read<CompanionRecord>(`companions/${safe(userId)}.json`);
  }
  putCompanion(rec: CompanionRecord) {
    return this.write(`companions/${safe(rec.userId)}.json`, JSON.stringify({ ...rec, prep: { ...rec.prep, updatedAt: new Date().toISOString() } }, null, 1));
  }
  private locks = new Map<string, Promise<unknown>>();
  patchCompanion(userId: string, fn: (c: CompanionRecord) => CompanionRecord): Promise<CompanionRecord | null> {
    const key = safe(userId);
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const cur = await this.getCompanion(key);
        if (!cur) return null;
        const out = fn(cur);
        await this.putCompanion(out);
        return out;
      });
    this.locks.set(key, next);
    return next;
  }
  async listCompanions() {
    let names: string[] = [];
    try {
      names = await readdir(join(this.dir, "companions"));
    } catch {
      return [];
    }
    const out: CompanionRecord[] = [];
    for (const n of names.filter((n) => n.endsWith(".json"))) {
      const r = await this.read<CompanionRecord>(`companions/${n}`);
      if (r) out.push(r);
    }
    return out;
  }
  async getVoicePreview(voiceId: string, version: string) {
    try {
      return await readFile(join(this.dir, `voices/${safe(voiceId)}-${safe(version)}.wav`));
    } catch {
      return null;
    }
  }
  putVoicePreview(voiceId: string, version: string, audio: Buffer) {
    return this.write(`voices/${safe(voiceId)}-${safe(version)}.wav`, audio);
  }
  async deleteCompanion(userId: string) {
    const key = safe(userId);
    await (this.locks.get(key) ?? Promise.resolve()).catch(() => {});
    const c = await this.getCompanion(key);
    if (!c) return false;
    await rm(join(this.dir, `companions/${key}.json`), { force: true });
    await this.deleteAssets(key, c.id);
    return true;
  }
  replaceDemoCompanion(demoId: string, rec: CompanionRecord): Promise<boolean> {
    const key = safe(rec.userId);
    const next = (this.locks.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const cur = await this.getCompanion(key);
        if (!cur || cur.id !== demoId || !cur.demo) return false;
        await this.putCompanion(rec);
        await this.deleteAssets(key, demoId);
        return true;
      });
    this.locks.set(key, next);
    return next;
  }
  async deleteImage(userId: string, imageId: string) {
    const rec = await this.read<ImageRecord>(`images/${safe(imageId)}.json`);
    if (!rec || rec.userId !== userId) return;
    await rm(join(this.dir, `images/${safe(imageId)}.json`), { force: true });
    await rm(join(this.dir, `images/${safe(imageId)}.bin`), { force: true });
  }
  putAsset(userId: string, companionId: string, name: string, bytes: Buffer) {
    return this.write(`assets/${safe(userId)}/${safe(companionId)}/${safe(name)}.bin`, bytes);
  }
  async deleteAssets(userId: string, companionId?: string) {
    await rm(join(this.dir, companionId ? `assets/${safe(userId)}/${safe(companionId)}` : `assets/${safe(userId)}`), { recursive: true, force: true });
  }
  async getAsset(userId: string, companionId: string, name: string) {
    try {
      return await readFile(join(this.dir, `assets/${safe(userId)}/${safe(companionId)}/${safe(name)}.bin`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}
