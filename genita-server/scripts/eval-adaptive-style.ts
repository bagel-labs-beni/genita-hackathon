/**
 * Live adaptive-style check (memory lane 11/3). Opt in: node … scripts/eval-adaptive-style.ts --live
 * Real Muse Spark: how-to-talk-to-me lines said in a call → the How I see you profile (communication /
 * response), and one post-call growth pass over a call where the user lit up on a topic twice → interests
 * (observed). Synthetic account in a temp FileStore; keys never printed.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/prep/store.ts";
import { skipStyleCard, styleProfileText, type StyleCard } from "../src/prep/importProfile.ts";
import { Personalize } from "../src/personalize/service.ts";
import { mightBeCorrection } from "../src/personalize/corrections.ts";

if (!process.argv.includes("--live")) { console.error("Opt in: --live"); process.exitCode = 1; }
else {
  const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const key = process.env.MODEL_API_KEY;
  if (!key) { console.error("missing MODEL_API_KEY"); process.exit(1); }
  const dir = mkdtempSync(join(tmpdir(), "genita-adaptive-"));
  try {
    const store = new FileStore(dir);
    const p = new Personalize({ store, metaKey: key });
    const sk = skipStyleCard({ interests: ["Cooking"], avoid: [] });
    if (!sk.ok) throw new Error("skip card");
    await store.putStyle("eval-style", (sk as { card: StyleCard }).card);
    const lines = ["Can you be more direct with me?", "Just get to the point please.", "Skip the small talk today.", "Give it to me in one sentence."];
    let caught = 0, applied = 0;
    for (const line of lines) {
      if (!mightBeCorrection(line)) continue;
      caught++;
      const r = await p.voiceCorrection("eval-style", line, "Sure, here's a long explanation with a few options for you.");
      if (r?.applied.some((a) => a.field === "communication" || a.field === "response")) applied++;
      console.log(JSON.stringify({ line, fields: r?.applied.map((a) => a.field) ?? [], events: r?.events.map((e) => e.text) ?? [] }));
    }
    const n = await p.endCall("eval-style", [
      { role: "user", text: "Okay so I've been getting really into trail running lately, it's my favorite thing." },
      { role: "assistant", text: "Oh nice, where do you run?" },
      { role: "user", text: "Mostly the hills near my place! Honestly trail running is the best part of my week, I could talk about it all day." },
      { role: "assistant", text: "Love that." },
      { role: "user", text: "Anyway, what should I make for dinner?" },
    ], null);
    const card = await store.getStyle("eval-style");
    const profile = card ? styleProfileText(card) : "";
    const litUp = /trail running/i.test(JSON.stringify(card?.sections?.interests ?? []));
    console.log(`adaptive style: prefilter ${caught}/${lines.length} · applied to communication/response ${applied}/${caught} · post-call updates ${n} · lit-up topic stored as interest: ${litUp}`);
    console.log(profile.split("\n").filter((l) => /direct|point|short|sentence|small talk|trail/i.test(l)).slice(0, 6).join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
