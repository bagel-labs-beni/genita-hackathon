/** Live (memory lane, QA 11/3 P2): a call where she asks to forget something → no memory or summary line may carry it. node … --live [--runs=5] */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { metaExtractor } from "../src/memory/extract.ts";
import { metaSummarizer } from "../src/memory/summaries.ts";
const TURNS = [
  { user: "I've been really into leather accessories lately, like belts and bags.", assistant: "Ooh, leather is such a good look on you." },
  { user: "Actually forget the leather accessories thing, I don't want you to remember that.", assistant: "Got it, consider it forgotten." },
  { user: "Anyway, I need a warm jacket for Saturday.", assistant: "Let's find you something cozy." },
  { user: "Green or navy, I can't decide.", assistant: "Navy feels right for you." },
];
if (!process.argv.includes("--live")) { console.error("--live"); process.exitCode = 1; }
else {
  const f = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env"); if (existsSync(f)) process.loadEnvFile(f);
  const key = process.env.MODEL_API_KEY; if (!key) { console.error("missing key"); process.exit(1); }
  const runs = Number(process.argv.find((a) => a.startsWith("--runs="))?.slice(7) ?? 5);
  const leak = /leather|forget|forgot|remember/i;
  let leaks = 0, keptJacket = 0;
  for (let i = 1; i <= runs; i++) {
    const [mems, sum] = await Promise.all([metaExtractor(key)(TURNS).catch(() => []), metaSummarizer(key)(TURNS).catch(() => null)]);
    const text = JSON.stringify([mems.map((m) => m.text), sum]);
    const leaked = leak.test(text);
    if (leaked) leaks++; if (/jacket|navy|green/i.test(text)) keptJacket++;
    console.log(JSON.stringify({ run: i, leaked, memories: mems.map((m) => m.text), summary: sum }));
  }
  console.log(`forget echo: leaked ${leaks}/${runs} · the rest of the call kept ${keptJacket}/${runs}`);
  if (leaks) process.exitCode = 1;
}
