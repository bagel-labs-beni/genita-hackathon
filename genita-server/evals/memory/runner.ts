import { readFileSync } from "node:fs";
import { createExtractor, type ExtractedMemory, type Turn } from "../../src/memory/extract.ts";
import { InMemoryMemoryRepository } from "../../src/memory/repository.ts";
import { MemoryService } from "../../src/memory/service.ts";
import { MemoryCall, memoryPrompt } from "../../src/memory/call.ts";

export const fixtures = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8")) as {
  turns: Turn[];
  expected: Array<{ kind: string; keywords: string[] }>;
  cases: Array<{ name: string; model_output: ExtractedMemory[] }>;
};
export async function evaluateMemory() {
  const results = [];
  for (const fixture of fixtures.cases) {
    const repo = new InMemoryMemoryRepository(); let now = Date.UTC(2026, 10, 1, 12);
    // Synthetic model outputs exercise the actual schema/filter/batch/storage paths offline.
    const extract = createExtractor(async <T>() => ({ memories: fixture.model_output } as T));
    const memory = new MemoryService({ repository: repo, state: repo, extract, now: () => now });
    const call = new MemoryCall(memory, "fixture-user", "groceries"); await call.open(); call.userMessage();
    for (const turn of fixtures.turns) call.completedTurn(turn.user, turn.assistant);
    call.close(); await memory.drain();
    const items = await memory.list("fixture-user");
    const matches = (m: { text: string; kind: string }, expected: typeof fixtures.expected[number]) => m.kind === expected.kind && expected.keywords.every((w) => m.text.toLowerCase().includes(w));
    const relevant = items.filter((m) => fixtures.expected.some((e) => matches(m, e))).length;
    const covered = fixtures.expected.filter((e) => items.some((m) => matches(m, e))).length;
    const precision = items.length ? relevant / items.length : 0;
    const recall = covered / fixtures.expected.length;
    now += 24 * 3_600_000;
    const next = new MemoryCall(memory, "fixture-user", "next"); const opening = await next.open();
    const revisit = !!opening && /kimchi.*jjigae/i.test(memoryPrompt([opening], true));
    next.close();
    await memory.forget("fixture-user");
    // Replay the same extraction after deletion as well as recall/opening.
    await memory.extract("fixture-user", "replayed", fixtures.turns, (await repo.getState("fixture-user")).revision);
    now += 24 * 3_600_000;
    const resurfaced = (await memory.list("fixture-user")).length + (await memory.recall("fixture-user", "kimchi tofu spicy")).length + Number(!!await memory.opening("fixture-user", "after-forget"));
    results.push({ name: fixture.name, memories: items.length, precision, recall, revisit, deletedResurfaced: resurfaced, pass: items.length >= 3 && precision === 1 && recall === 1 && revisit && resurfaced === 0 });
  }
  return results;
}
