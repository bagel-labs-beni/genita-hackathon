import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validCropRef, type SeenCandidate } from "./seen.ts";
import { imageMime } from "./photos.ts";

type Crop = SeenCandidate["crop"];
const owner = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 20);
/** Header dimensions are checked so a full camera frame cannot be mislabeled
 * as a 480px crop. Pixel safety/actual SAM cropping belongs to the trusted F5 adapter. */
export function imageDimensions(b: Buffer): { width: number; height: number } | null {
  if (imageMime(b) === "image/png" && b.length >= 24 && b.toString("ascii", 12, 16) === "IHDR") return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (imageMime(b) !== "image/jpeg") return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const size = b.readUInt16BE(i + 2);
    if (size < 2 || i + 2 + size > b.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 7) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += size + 2;
  }
  return null;
}

/** Only cropped bytes enter this store. Pass a directory for persistence;
 * otherwise images and their provenance live only in this runtime. */
export class SeenCropStore {
  private readonly directory?: string;
  private entries = new Map<string, { bytes: Buffer; crop: Crop }>();
  constructor(directory?: string) { this.directory = directory; }
  async put(userId: string, bytes: Buffer, metadata: Omit<Crop, "image_ref" | "width" | "height">): Promise<Crop> {
    const dimensions = imageDimensions(bytes);
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0 || Math.max(dimensions.width, dimensions.height) > 480 || bytes.length > 1_500_000 || metadata.source !== "sam-3.1" || !metadata.safeObject) throw new Error("invalid_seen_crop");
    const image_ref = `sam-crops/${owner(userId)}_${randomUUID()}.${imageMime(bytes) === "image/png" ? "png" : "jpg"}`;
    const crop = { ...metadata, ...dimensions, image_ref };
    if (this.directory) {
      await mkdir(join(this.directory, "sam-crops"), { recursive: true, mode: 0o700 });
      await writeFile(join(this.directory, image_ref), bytes, { mode: 0o600, flag: "wx" });
      await writeFile(join(this.directory, image_ref + ".json"), JSON.stringify(crop), { mode: 0o600, flag: "wx" });
    } else this.entries.set(image_ref, { bytes: Buffer.from(bytes), crop: structuredClone(crop) });
    return crop;
  }
  private owned(userId: string, ref: string): boolean { return validCropRef(ref) && ref.startsWith(`sam-crops/${owner(userId)}_`); }
  async verify(userId: string, crop: Crop): Promise<boolean> {
    if (!this.owned(userId, crop.image_ref)) return false;
    try {
      const saved: Crop | undefined = this.directory ? JSON.parse(await readFile(join(this.directory, crop.image_ref + ".json"), "utf8")) : this.entries.get(crop.image_ref)?.crop;
      const bytes = this.directory ? await readFile(join(this.directory, crop.image_ref)) : this.entries.get(crop.image_ref)?.bytes;
      const dimensions = bytes && imageDimensions(bytes);
      return !!saved && !!dimensions && saved.image_ref === crop.image_ref && saved.source === crop.source && saved.safeObject === crop.safeObject
        && saved.width === crop.width && saved.height === crop.height && saved.box.every((n, i) => n === crop.box[i])
        && dimensions.width === crop.width && dimensions.height === crop.height;
    } catch { return false; }
  }
  async delete(userId: string, ref: string): Promise<void> {
    if (!this.owned(userId, ref)) throw new Error("invalid_crop_ref");
    if (this.directory) {
      for (const path of [ref, ref + ".json"]) await unlink(join(this.directory, path)).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
    } else this.entries.delete(ref);
  }
}
