import { EventEmitter } from "node:events";
import { loadConfig } from "../../src/config.ts";
import { Session, type SessionDeps } from "../../src/session/session.ts";
import type { ServerEvent } from "../../src/protocol.ts";
import type { AsrEvent } from "../../src/meta/transcribe.ts";
import { checkServerEvent } from "../../src/protocol.ts";
import { OpsLimits } from "../../src/ops/limits.ts";
import assert from "node:assert/strict";

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Real Session pipeline, fake vendors only; no sockets, credentials or playback wait. */
export async function turn(deps: Partial<SessionDeps>, opts: { history?: string | { role: "user" | "assistant"; text: string }[]; speculative?: boolean; beforeFinal?: (session: Session) => void; text?: string } = {}) {
  const events: ServerEvent[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: true, async connect() {}, sendAudio() {}, end() {} });
  let resolve!: () => void;
  const terminal = new Promise<void>((r) => { resolve = r; });
  const session = new Session("empty-regression", {
    sendJson(e) { assert.deepEqual(checkServerEvent(e), [], JSON.stringify(e)); events.push(e); if (e.type === "reply" || (e.type === "error" && e.code === "spark_unavailable")) resolve(); },
    sendBinary() {}, close() {},
  }, {
    // Each fixture is independent even when it reuses the memory user "fake".
    // Preserve real admission checks without consuming the process-wide quota.
    ops: new OpsLimits(deps.config),
    config: { ...loadConfig({ MODEL_API_KEY: "fake" }), serverTts: false, webSearch: false, sparkHedge: 3, speculate: !!opts.speculative },
    openAsr: () => asr,
    async *spark() { yield { type: "text", delta: "Okay." }; },
    async *tts() {},
    log(event, data) { logs.push({ event, data }); },
    ...deps,
  });
  try {
    await session.onClientText(JSON.stringify({ type: "start", persona: { name: "Mina" }, mic: !!opts.speculative,
      history: typeof opts.history === "string" ? [{ role: "assistant", text: opts.history }] : opts.history }));
    if (opts.speculative) {
      asr.emit("event", { type: "partial", text: "Tell me." } satisfies AsrEvent);
      for (let i = 0; i < 12; i++) await tick();
      opts.beforeFinal?.(session);
      asr.emit("event", { type: "speechComplete", turnId: 0, text: "Tell me." } satisfies AsrEvent);
    } else await session.onClientText(JSON.stringify({ type: "text", text: opts.text ?? "Tell me." }));
    const timer = setTimeout(resolve, 1500);
    await terminal;
    clearTimeout(timer);
    await tick();
    return { events, logs };
  } finally { session.close(); }
}
