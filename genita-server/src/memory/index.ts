import { InMemoryMemoryRepository, JsonMemoryRepository } from "./repository.ts";
import { metaExtractor, metaMemorySafety } from "./extract.ts";
import { metaSummarizer } from "./summaries.ts";
import { metaReranker } from "./rerank.ts";
import { SeenCropStore } from "./crops.ts";
import { dirname, join } from "node:path";
import { MemoryService } from "./service.ts";
import { UsPhotoService, metaPhotoVendors } from "./photos.ts";

export { MemoryService } from "./service.ts";
export { MemoryCall } from "./call.ts";
export { PgMemoryRepository } from "./pgRepository.ts";
export { UsPhotoService } from "./photos.ts";
export type { UserResolver } from "./routes.ts";
/**
 * D40 (PRD v12, 11/2): Us photo (US-1~5) and seen memory (SM-1~3) are cut for the hackathon build.
 * Both stay in the code behind env flags that default off; general memory and the revisit greeting stay on.
 */
export function memoryFeatures(env: NodeJS.ProcessEnv = process.env) {
  // Session memory (per-thread call summaries, memory lane 11/3): on unless GENITA_SESSION_MEMORY=0
  return { usPhotos: env.GENITA_US_PHOTOS === "1", seenMemory: env.GENITA_SEEN_MEMORY === "1", sessionMemory: env.GENITA_SESSION_MEMORY !== "0", rerank: env.GENITA_MEMORY_RERANK !== "0" };
}
export function createMemory(key: string, log: (event: string, data: Record<string, unknown>) => void) {
  const repo = process.env.GENITA_MEMORY_FILE ? new JsonMemoryRepository(process.env.GENITA_MEMORY_FILE) : new InMemoryMemoryRepository();
  const gap = Number(process.env.REVISIT_GAP_HOURS ?? 6);
  const crops = new SeenCropStore(process.env.GENITA_MEMORY_FILE ? join(dirname(process.env.GENITA_MEMORY_FILE), "memory-assets") : undefined);
  const features = memoryFeatures();
  const memory = new MemoryService({ repository: repo, state: repo, seenMemory: features.seenMemory, extract: metaExtractor(key), isSafe: (text) => metaMemorySafety(key, text), deleteCrop: (user, ref) => crops.delete(user, ref), verifyCrop: (user, crop) => crops.verify(user, crop), revisitGapHours: Number.isFinite(gap) && gap >= 0 ? gap : 6, ephemeral: !process.env.GENITA_MEMORY_FILE, summarize: metaSummarizer(key), sessionMemory: features.sessionMemory, ...(features.rerank ? { rerank: metaReranker(key) } : {}), log });
  return { memory, crops, photos: features.usPhotos ? new UsPhotoService(memory, metaPhotoVendors(key)) : undefined };
}
