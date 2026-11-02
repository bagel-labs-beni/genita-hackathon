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
    const lines = ["Can you be more direct with me?", "Just get to the point please.", "Less detail from now on.", "TL;DR please"];
    let caught = 0, applied = 0;
    for (const line of lines) {
      if (!mightBeCorrection(line)) continue;
      caught++;
      const r = await p.voiceCorrection("eval-style", line, "Sure, here's a long explanation with a few options for you.");
      if (r?.applied.some((a) => a.field === "communication" || a.field === "response")) applied++;
      console.log(JSON.stringify({ line, fields: r?.applied.map((a) => a.field) ?? [], events: r?.events.map((e) => e.text) ?? [] }));
    }
    // no stated preference: the user just keeps coming back to it with excitement (observed, times >= 2)
    const n = await p.endCall("eval-style", [
      { role: "user", text: "I went trail running before work, the fog on the ridge was unreal!" },
      { role: "assistant", text: "That sounds beautiful. How far did you go?" },
      { role: "user", text: "Like eight kilometers, and halfway up I saw two deer right on the trail!" },
      { role: "assistant", text: "Wow." },
      { role: "user", text: "Okay what should I make for dinner?" },
      { role: "assistant", text: "How about a quick stir fry?" },
      { role: "user", text: "Sure. Oh, and the trail run tomorrow is going to be at sunrise, I can't wait." },
    ], null);
    const card = await store.getStyle("eval-style");
    const items = (card?.sections?.interests ?? []) as Array<{ text: string; label?: string }>;
    const lit = items.find((i) => /trail|running/i.test(i.text));
    const observed = lit?.label === "observed";
    console.log(`adaptive style: prefilter ${caught}/${lines.length} · stored as a style line ${applied}/${caught} · post-call updates ${n} · lit-up topic stored as an observed interest: ${observed} (${lit ? JSON.stringify(lit.text) : "none"})`);
    console.log(styleProfileText(card!).split("\n").filter((l) => /direct|point|short|sentence|small talk|trail/i.test(l)).slice(0, 6).join("\n"));
    // pass = every style line reached the check, at least one became a style line, the lit-up topic was observed
    if (caught !== lines.length || applied < 1 || !observed) process.exitCode = 1;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
