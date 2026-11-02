import { readFileSync } from "node:fs";

export type LogRecord = Record<string, unknown> & { event: string };
type Seconds = number | null;
type CompanionTiming = { companionId: string; uploadToSceneS: Seconds; sceneToFaceS: Seconds; faceToReadyS: Seconds; readyToGreetedS: Seconds; uploadToMovingFaceMs: number | null };
type Percentiles = { p50: number | null; p90: number | null };
const FUNNEL = ["auth.signed_in", "import.applied", "face.checked", "voice.selected", "companion.named", "setup.summary_viewed", "call.greeted"];

export function parseLogLines(text: string): LogRecord[] {
  const output: LogRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const brace = line.indexOf("{");
    if (brace < 0) continue;
    try {
      const value = JSON.parse(line.slice(brace));
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.event === "string") output.push(value as LogRecord);
    } catch { /* CloudWatch and non-JSON lines are intentionally ignored. */ }
  }
  return output;
}

function timestamp(record: LogRecord): number | null {
  const raw = record.t ?? record.at;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") { const parsed = Date.parse(raw); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}

function percentile(values: number[]): Percentiles {
  if (!values.length) return { p50: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!;
  return { p50: at(0.5), p90: at(0.9) };
}

const elapsedSeconds = (a: number | undefined, b: number | undefined): Seconds => a === undefined || b === undefined ? null : Math.round((b - a) / 100) / 10;

export function buildReport(records: LogRecord[]) {
  const companionForUser = new Map<string, string>();
  const companionForImage = new Map<string, string>();
  for (const record of records) {
    if (typeof record.companionId !== "string") continue;
    if (typeof record.userId === "string") companionForUser.set(record.userId, record.companionId);
    if (record.event === "companion.created" && typeof record.imageId === "string") companionForImage.set(record.imageId, record.companionId);
  }
  const byCompanion = new Map<string, Map<string, number>>();
  for (const record of records) {
    const id = typeof record.companionId === "string" ? record.companionId
      : typeof record.companion === "string" ? record.companion
        : typeof record.imageId === "string" ? companionForImage.get(record.imageId) ?? null
          : typeof record.userId === "string" ? companionForUser.get(record.userId) ?? null : null;
    const at = timestamp(record);
    if (!id || at === null || !["face.uploaded", "scene.done", "face.done", "onboarding.ready", "prep.completed", "call.greeted"].includes(record.event)) continue;
    const events = byCompanion.get(id) ?? new Map<string, number>();
    if (!events.has(record.event)) events.set(record.event, at);
    byCompanion.set(id, events);
  }
  const companions: CompanionTiming[] = [...byCompanion.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([companionId, events]) => {
    const uploaded = events.get("face.uploaded");
    const scene = events.get("scene.done");
    const face = events.get("face.done");
    const ready = events.get("onboarding.ready") ?? events.get("prep.completed");
    const greeted = events.get("call.greeted");
    return { companionId, uploadToSceneS: elapsedSeconds(uploaded, scene), sceneToFaceS: elapsedSeconds(scene, face), faceToReadyS: elapsedSeconds(face, ready), readyToGreetedS: elapsedSeconds(ready, greeted), uploadToMovingFaceMs: uploaded === undefined || face === undefined ? null : face - uploaded };
  });
  const moving = companions.flatMap((x) => x.uploadToMovingFaceMs === null ? [] : [x.uploadToMovingFaceMs]);
  const firstAudio = records.flatMap((x) => x.event === "turn.answered" && typeof x.first_audio_ms === "number" && Number.isFinite(x.first_audio_ms) ? [x.first_audio_ms] : []);
  const funnel = FUNNEL.map((event) => ({ event, count: records.filter((x) => x.event === event && (event !== "face.checked" || x.passed === true)).length }));
  const uploadToMovingFaceP = percentile(moving);
  return {
    companions,
    prep: { uploadToMovingFaceMs: uploadToMovingFaceP },
    gates: { uploadToMovingFaceP50Ms: uploadToMovingFaceP.p50, uploadToMovingFace: uploadToMovingFaceP.p50 !== null && uploadToMovingFaceP.p50 <= 120_000 ? "PASS" : "FAIL" },
    turns: { firstAudioMs: percentile(firstAudio), ttsFallbackDevice: records.filter((x) => x.event === "tts.fallback_device").length, voiceCapacityFallback: records.filter((x) => x.event === "voice.capacity_fallback").length },
    funnel,
  };
}

const seconds = (ms: number | null) => ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`;
const step = (value: Seconds) => value === null ? "n/a" : `${value.toFixed(1)} s`;

export function renderReport(report: ReturnType<typeof buildReport>): string {
  const lines = ["Companions"];
  for (const c of report.companions) lines.push(`${c.companionId}: upload → scene ${step(c.uploadToSceneS)} | scene → face ${step(c.sceneToFaceS)} | face → ready ${step(c.faceToReadyS)} | ready → greeted ${step(c.readyToGreetedS)}`);
  lines.push(`upload → moving face p50 ≤ 120 s: ${report.gates.uploadToMovingFace} (${seconds(report.gates.uploadToMovingFaceP50Ms)})`);
  lines.push(`turn first_audio_ms p50/p90: ${report.turns.firstAudioMs.p50 ?? "n/a"} / ${report.turns.firstAudioMs.p90 ?? "n/a"}`);
  lines.push(`tts.fallback_device: ${report.turns.ttsFallbackDevice}`);
  lines.push(`voice.capacity_fallback: ${report.turns.voiceCapacityFallback}`);
  lines.push("Core funnel");
  for (const item of report.funnel) lines.push(`${item.event}: ${item.count}`);
  return lines.join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args[0] === "--json";
  const path = args.find((x) => x !== "--json");
  const input = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  const report = buildReport(parseLogLines(input));
  console.log(json ? JSON.stringify(report, null, 2) : renderReport(report));
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
