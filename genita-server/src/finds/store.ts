/**
 * F10-L6 · Finds storage. Every card a call makes is kept (closing the sheet
 * never loses it); the Finds tab lists saved cards first, then the rest,
 * newest first. Delete is soft for UNDO_MS so "Undo" works, then purged.
 * Camera frames are never stored — only the card (names, boxes, text) and
 * the illustrations we generated.
 *
 * Narrow interface so the Postgres lane (F1-L4) can swap the JSON-file
 * implementation without touching callers.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FindCard } from "../protocol.ts";
import { FindsWork } from "./work.ts";

export const UNDO_MS = 24 * 3600_000;

export type StoredFind = { card: FindCard; owner: string; updatedAt: number; deletedAt?: number };

export interface FindsStore {
  readonly work: FindsWork;
  put(owner: string, card: FindCard): Promise<void>;
  list(owner: string): Promise<FindCard[]>;
  get(owner: string, id: string): Promise<FindCard | null>;
  remove(owner: string, id: string): Promise<boolean>;
  restore(owner: string, id: string): Promise<boolean>;
  setSaved(owner: string, id: string, saved: boolean): Promise<boolean>;
  /** account deletion: cards and images gone */
  removeOwner(owner: string): Promise<number>;
  putImage(id: string, slot: string, bytes: Buffer): Promise<void>;
  getImage(id: string, slot: string): Promise<{ bytes: Buffer; mime: string } | null>;
}

export function sniffMime(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

const SLOT_RE = /^[a-z0-9-]{1,24}$/;
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

function sortForTab(rows: StoredFind[]): FindCard[] {
  return rows
    .filter((r) => !r.deletedAt)
    .sort((a, b) => Number(!!b.card.saved) - Number(!!a.card.saved) || b.card.createdAt.localeCompare(a.card.createdAt))
    .map((r) => r.card);
}

export class MemoryFindsStore implements FindsStore {
  readonly work = new FindsWork();
  protected rows = new Map<string, StoredFind>();
  protected images = new Map<string, Buffer>();
  /** ids of cards purged with their owner (account deletion) */
  protected removedIds = new Set<string>();
  protected now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  protected purge(): void {
    const t = this.now();
    for (const [id, r] of this.rows) {
      if (r.deletedAt && t - r.deletedAt > UNDO_MS) {
        this.rows.delete(id);
        for (const k of [...this.images.keys()]) if (k.startsWith(id + "/")) this.images.delete(k);
      }
    }
  }
  protected changed(): void {}
  async put(owner: string, card: FindCard) {
    if (this.work.isDeleted(owner)) return;
    const prev = this.rows.get(card.id);
    if (prev && prev.owner !== owner) return;
    this.rows.set(card.id, { card: { ...card, saved: prev?.card.saved ?? card.saved }, owner, updatedAt: this.now(), deletedAt: prev?.deletedAt });
    this.purge();
    this.changed();
  }
  async list(owner: string) {
    this.purge();
    return sortForTab([...this.rows.values()].filter((r) => r.owner === owner));
  }
  async get(owner: string, id: string) {
    const r = this.rows.get(id);
    return r && r.owner === owner && !r.deletedAt ? r.card : null;
  }
  async remove(owner: string, id: string) {
    const r = this.rows.get(id);
    if (!r || r.owner !== owner || r.deletedAt) return false;
    r.deletedAt = this.now();
    this.changed();
    return true;
  }
  async restore(owner: string, id: string) {
    const r = this.rows.get(id);
    if (!r || r.owner !== owner || !r.deletedAt) return false;
    if (this.now() - r.deletedAt > UNDO_MS) return false; // the 24 h Undo window is over
    delete r.deletedAt;
    this.changed();
    return true;
  }
  async setSaved(owner: string, id: string, saved: boolean) {
    const r = this.rows.get(id);
    if (!r || r.owner !== owner || r.deletedAt) return false;
    r.card = { ...r.card, saved };
    this.changed();
    return true;
  }
  async removeOwner(owner: string) {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.owner !== owner) continue;
      this.removedIds.add(id); // a late image for this card must not come back after the purge
      this.rows.delete(id);
      for (const k of [...this.images.keys()]) if (k.startsWith(id + "/")) this.images.delete(k);
      n++;
    }
    this.changed();
    return n;
  }
  async putImage(id: string, slot: string, bytes: Buffer) {
    if (!ID_RE.test(id) || !SLOT_RE.test(slot)) throw new Error("bad image key");
    if (!this.canWriteImage(id)) return;
    this.images.set(`${id}/${slot}`, bytes);
  }
  protected canWriteImage(id: string): boolean {
    // An image may arrive before its card row (the pipeline renders while the card is being saved): allow it.
    // A deleted owner's late image is stopped by the runner (owner known there) and by this check once the row exists.
    const row = this.rows.get(id);
    return row ? !this.work.isDeleted(row.owner) : !this.removedIds.has(id);
  }
  async getImage(id: string, slot: string) {
    if (!ID_RE.test(id) || !SLOT_RE.test(slot)) return null;
    const b = this.images.get(`${id}/${slot}`);
    return b ? { bytes: b, mime: sniffMime(b) } : null;
  }
}

/** Same behavior, persisted to <dir>/finds.json and <dir>/images/<id>/<slot>. Fine for one server instance. */
export class FileFindsStore extends MemoryFindsStore {
  private readonly dir: string;
  constructor(dir: string, now: () => number = Date.now) {
    super(now);
    this.dir = dir;
    mkdirSync(join(dir, "images"), { recursive: true });
    const f = join(dir, "finds.json");
    if (existsSync(f)) {
      try {
        for (const r of JSON.parse(readFileSync(f, "utf8")) as StoredFind[]) this.rows.set(r.card.id, r);
      } catch {
        /* a broken file starts empty rather than crashing the server */
      }
    }
  }
  protected override changed(): void {
    const f = join(this.dir, "finds.json");
    writeFileSync(f + ".tmp", JSON.stringify([...this.rows.values()]));
    renameSync(f + ".tmp", f);
    // drop image folders whose find is gone
    for (const id of readdirSync(join(this.dir, "images"))) if (!this.rows.has(id)) rmSync(join(this.dir, "images", id), { recursive: true, force: true });
  }
  override async putImage(id: string, slot: string, bytes: Buffer) {
    await super.putImage(id, slot, bytes);
    // The owner may have been tombstoned/purged across the await above.
    if (!this.canWriteImage(id)) return;
    mkdirSync(join(this.dir, "images", id), { recursive: true });
    writeFileSync(join(this.dir, "images", id, slot), bytes);
    this.images.delete(`${id}/${slot}`); // disk is the copy; keep memory small
  }
  override async getImage(id: string, slot: string) {
    if (!ID_RE.test(id) || !SLOT_RE.test(slot)) return null;
    const p = join(this.dir, "images", id, slot);
    if (!existsSync(p)) return null;
    const b = readFileSync(p);
    return { bytes: b, mime: sniffMime(b) };
  }
}

/** Owner key as stored: a hash, so the raw device/user id never sits in the file. */
export function ownerKey(raw: string): string {
  return createHash("sha256").update("genita-finds:" + raw).digest("hex").slice(0, 32);
}
