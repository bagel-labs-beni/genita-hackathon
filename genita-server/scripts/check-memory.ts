/** Explicitly opt-in. Never used by npm test/eval:memory; no raw vendor errors/keys printed. */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fixtures } from "../evals/memory/runner.ts";
import { metaExtractor } from "../src/memory/extract.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { memoryPrompt } from "../src/memory/call.ts";
import { UsPhotoService, metaPhotoVendors } from "../src/memory/photos.ts";
import { sparkText } from "../src/meta/spark.ts";
import { buildInstructions, avoidRepeatedOpener } from "../src/prompt/persona.ts";

if (!process.argv.includes("--live")) {
  console.error("Opt in explicitly: npm run check:memory -- --live [--photo-face=/path/to/companion.png]"); process.exitCode = 1;
} else {
  try {
    const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    const key = process.env.MODEL_API_KEY;
    if (!key) throw new Error("missing_model_key");
    const extract = metaExtractor(key); let passes = 0;
    for (let n = 0; n < 5; n++) {
      const repo = new InMemoryMemoryRepository(); let now = Date.UTC(2026, 10, 1, 12);
      const memory = new MemoryService({ repository: repo, state: repo, extract, now: () => now });
      await memory.noteMessage("synthetic-eval");
      await memory.extract("synthetic-eval", "groceries", fixtures.turns, 0);
      const items = await memory.list("synthetic-eval"); now += 24 * 3_600_000;
      const opening = await memory.opening("synthetic-eval", "next");
      const instructions = buildInstructions({ persona: { name: "Mina", kind: "human", traits: ["warm"] }, mode: "chat" }) + memoryPrompt(opening ? [opening] : [], true);
      const greeting = avoidRepeatedOpener(await sparkText(key, { input: "Hey", instructions, maxOutputTokens: 150 }, AbortSignal.timeout(30_000)), []);
      await memory.forget("synthetic-eval");
      const deleted = (await memory.recall("synthetic-eval", "kimchi jjigae")).length === 0;
      const pass = items.length >= 3 && /kimchi|jjigae|김치찌개/i.test(greeting) && deleted;
      if (pass) passes++;
      console.log(JSON.stringify({ run: n + 1, extracted: items.length, revisit: /kimchi|jjigae|김치찌개/i.test(greeting), deletedRecallZero: deleted, pass }));
    }
    console.log(`live memory: ${passes}/5`); if (passes !== 5) process.exitCode = 1;
    const faceArg = process.argv.find((a) => a.startsWith("--photo-face="));
    if (faceArg) {
      const companionFace = readFileSync(resolve(faceArg.slice("--photo-face=".length)));
      const repo = new InMemoryMemoryRepository(); const memory = new MemoryService({ repository: repo, state: repo, extract });
      const photos = new UsPhotoService(memory, metaPhotoVendors(key));
      const out = resolve(".memory-vendor"); await mkdir(out, { recursive: true, mode: 0o700 });
      for (const [sceneId, sceneDescription] of [["fridge", "The companion cooks kimchi jjigae beside a generic refrigerator"], ["drama", "The companion watches a comedy on a generic living room couch"], ["outfit", "The companion tries a bright casual jacket in a generic studio"]]) {
        const result = await photos.generate("synthetic-photo-eval", { sceneId, companionFace, sceneDescription, sceneEnded: true, cardClosed: true });
        if (result.status === "ready") await writeFile(join(out, sceneId + ".png"), result.image, { mode: 0o600 });
        console.log(JSON.stringify({ sceneId, status: result.status, humanFaceReview: "required" }));
        if (result.status !== "ready") process.exitCode = 1;
      }
    }
  } catch {
    console.error("Live memory check failed (configuration/vendor error; details suppressed to protect credentials)."); process.exitCode = 1;
  }
}
