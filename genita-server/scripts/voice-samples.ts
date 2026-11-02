/**
 * Render the voice bench lines through the production voice path (normalise → clause split → Meta voice
 * service → pauses), one mp3 per line. Needs GENITA_VOICE_URL + GENITA_VOICE_TOKEN (never printed) and ffmpeg.
 *   node --experimental-strip-types scripts/voice-samples.ts --out=DIR [--speaker=72]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseSpeakers } from "../src/config.ts";
import { createSeamless } from "../src/tts/seamless.ts";
import { SentenceSplitter } from "../src/text/sentences.ts";
import { parseTaggedSentence } from "../src/text/tags.ts";

const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith("--out="))?.slice(6) ?? ".smoke/voice-samples";
const url = process.env.GENITA_VOICE_URL;
const token = process.env.GENITA_VOICE_TOKEN;
if (!url || !token) throw new Error("set GENITA_VOICE_URL and GENITA_VOICE_TOKEN");
const speakers = parseSpeakers(process.env.GENITA_VOICE_SPEAKERS, { human: 72, animal: 16, character: 68 });
const speaker = Number(args.find((a) => a.startsWith("--speaker="))?.slice(10) ?? speakers.human);

const LINES: Record<string, string> = {
  "1-casual": "Hey! Oh wow, you're back already? How was the rest of your day?",
  "2-comfort": "Hey... that sounds really hard. I'm right here, okay? Take your time. We can just sit with it for a bit.",
  "3-laugh": "Wait, you put the pineapple in the fridge door? Haha, okay, that's honestly kind of genius.",
  "4-question": "So, what are you thinking for dinner tonight? Want me to take a look at what's in your fridge?",
  "5-interp-en": "Hi, is there a good gukbap place around here? It's my first time in this area.",
};

const voice = createSeamless({ url, token, speakers, speed: 1, timeoutMs: 10_000, model: "seamless" });
mkdirSync(out, { recursive: true });
for (const [name, text] of Object.entries(LINES)) {
  const split = new SentenceSplitter({ eagerFirstClause: true, clauseMaxChars: 140 });
  const clauses = [...split.push(text + " "), ...split.flush()];
  const pcm: Buffer[] = [];
  const t0 = performance.now();
  let first = 0;
  for (const c of clauses) {
    for await (const ch of voice.speak({ voiceId: `seamless:${speaker}`, text: parseTaggedSentence(c).ttsText, emotion: null, model: "x", lang: "en-US" })) {
      first ||= performance.now() - t0;
      pcm.push(ch.audio);
    }
  }
  const file = join(out, `seamless-final-${name}.mp3`);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "-", "-b:a", "96k", file], { input: Buffer.concat(pcm) });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  console.log(`${file}  clauses=${JSON.stringify(clauses)}  first chunk ${Math.round(first)} ms (from this machine)`);
}
