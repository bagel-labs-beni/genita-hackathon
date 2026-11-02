/**
 * npm run peter:bake -- <neutral.mp4 URL> <avatar id>
 *
 * Runs only the F2-L22 step through the same ModalPeterBaker the prep runner
 * uses: POST /prepare on the Modal API, poll until done, print bundle id and
 * timings. Needs GENITA_PETER_PREPARE_URL and GENITA_PETER_TOKEN (or the
 * WORKER_TOKEN line in ~/.config/genita/peter-modal.env). One bake, then exit.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModalPeterBaker } from "../src/prep/lips.ts";

const peterEnv = join(homedir(), ".config/genita/peter-modal.env");
const token = process.env.GENITA_PETER_TOKEN || (existsSync(peterEnv) ? readFileSync(peterEnv, "utf8").match(/^WORKER_TOKEN=(.+)$/m)?.[1]?.trim() : undefined);
const url = process.env.GENITA_PETER_PREPARE_URL;
const [video, avatarId] = process.argv.slice(2);
if (!url || !token || !video || !avatarId) throw new Error("usage: GENITA_PETER_PREPARE_URL=… npm run peter:bake -- <video url> <avatar id>");

const baker = new ModalPeterBaker(url, token, { pollMs: 5000 });
const t0 = performance.now();
const r = await baker.bake(
  { companionId: avatarId, kind: "human", sceneUrl: "", videos: { neutral: video }, voiceId: "" },
  { onSubmitted: async (id) => console.log(`submitted ${id} after ${Math.round(performance.now() - t0)} ms`) },
);
console.log(JSON.stringify(r));
console.log(`wall ${Math.round(performance.now() - t0)} ms`);
