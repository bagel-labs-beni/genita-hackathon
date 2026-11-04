/**
 * 11/4 (handover b9-6): the cold-GPU lines (seamless.ts HOLD_LINE, RECOVER_LINE) kept on disk per speaker, so a
 * restarted server can say them in the companion's own voice before the voice GPU is warm. PCM s16le 24 kHz, one file
 * per cache key (hashed). Small: a few seconds per line per speaker.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VoiceClips } from "./seamless.ts";

export function fileClips(dir: string): VoiceClips {
  const path = (key: string) => join(dir, `${createHash("sha1").update(key).digest("hex")}.pcm`);
  return {
    load(key) {
      try { return readFileSync(path(key)); } catch { return null; }
    },
    save(key, pcm) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${path(key)}.tmp`;
      writeFileSync(tmp, pcm);
      renameSync(tmp, path(key));
    },
  };
}
