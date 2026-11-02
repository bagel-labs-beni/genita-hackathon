import { InMemoryMemoryRepository, JsonMemoryRepository } from "./repository.ts";
import { metaExtractor, metaMemorySafety } from "./extract.ts";
import { SeenCropStore } from "./crops.ts";
import { dirname, join } from "node:path";
import { MemoryService } from "./service.ts";
import { UsPhotoService, metaPhotoVendors } from "./photos.ts";

export { MemoryService } from "./service.ts";
export { MemoryCall } from "./call.ts";
export { UsPhotoService } from "./photos.ts";
export type { UserResolver } from "./routes.ts";
export function createMemory(key: string, log: (event: string, data: Record<string, unknown>) => void) {
  const repo = process.env.GENITA_MEMORY_FILE ? new JsonMemoryRepository(process.env.GENITA_MEMORY_FILE) : new InMemoryMemoryRepository();
  const gap = Number(process.env.REVISIT_GAP_HOURS ?? 6);
  const crops = new SeenCropStore(process.env.GENITA_MEMORY_FILE ? join(dirname(process.env.GENITA_MEMORY_FILE), "memory-assets") : undefined);
  const memory = new MemoryService({ repository: repo, state: repo, extract: metaExtractor(key), isSafe: (text) => metaMemorySafety(key, text), deleteCrop: (user, ref) => crops.delete(user, ref), verifyCrop: (user, crop) => crops.verify(user, crop), revisitGapHours: Number.isFinite(gap) && gap >= 0 ? gap : 6, log });
  return { memory, crops, photos: new UsPhotoService(memory, metaPhotoVendors(key)) };
}
