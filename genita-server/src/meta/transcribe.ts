/**
 * Muse Voice Transcribe realtime client (wss://api.meta.ai/v1/asr/realtime).
 *
 * Handshake: first text frame carries auth + format (not an HTTP header).
 * Then binary PCM s16le mono 24 kHz, paced in real time by the caller (the
 * app's mic is real time already). Events observed 11/2:
 *   {sessionId} → speechStart{turnId,audioProcessedMs}
 *   → transcript{transcript,final:false} (cumulative partials)
 *   → speechEnd{turnId} → speechComplete{turnId,transcript}
 * DIARIZATION adds {type:"speaker",label:"A"} just before each speechEnd
 * (one label per turn; labels reset per connection).
 * Close: {"type":"endStream"} → server closes 1000.
 * 1013 (try again later) → reconnect after 1 s (F4-L5).
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export const ASR_URL = "wss://api.meta.ai/v1/asr/realtime";

export type AsrEvent =
  | { type: "speechStart"; turnId: number }
  | { type: "partial"; text: string }
  | { type: "speechEnd"; turnId: number }
  | { type: "speechComplete"; turnId: number; text: string }
  | { type: "speaker"; label: string };

export type TranscribeOptions = {
  key: string;
  languages: string[];
  mode?: "ENDPOINTING" | "DIARIZATION";
  url?: string;
  maxReconnects?: number;
};

export interface TranscribeEvents {
  event: [AsrEvent];
  status: ["connected" | "reconnecting" | "closed"];
  error: [Error];
}

export class TranscribeStream extends EventEmitter<TranscribeEvents> {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private reconnects = 0;
  private ready = false;
  private readonly opts: TranscribeOptions;

  constructor(opts: TranscribeOptions) {
    super();
    this.opts = opts;
  }

  get isOpen(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Resolves when the handshake frame has been sent. */
  connect(): Promise<void> {
    this.closedByUs = false;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url ?? ASR_URL, { maxPayload: 1 << 20 });
      this.ws = ws;
      let settled = false;
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            authorization: { accessToken: `Bearer ${this.opts.key}` },
            audioEncoding: "PCM_24KHZ",
            model: "muse-voice-transcribe-1.0",
            mode: this.opts.mode ?? "ENDPOINTING",
            partialMode: "CUMULATIVE",
            languageBias: this.opts.languages,
            emitAudioProgress: false,
          }),
        );
        this.ready = true;
        this.reconnects = 0;
        settled = true;
        this.emit("status", "connected");
        resolve();
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let e: { type?: string; turnId?: number; transcript?: string; final?: boolean; message?: string; label?: string };
        try {
          e = JSON.parse(data.toString());
        } catch {
          return;
        }
        switch (e.type) {
          case "speechStart":
            this.emit("event", { type: "speechStart", turnId: e.turnId ?? 0 });
            break;
          case "transcript":
            if (!e.final && e.transcript) this.emit("event", { type: "partial", text: e.transcript });
            break;
          case "speechEnd":
            this.emit("event", { type: "speechEnd", turnId: e.turnId ?? 0 });
            break;
          case "speechComplete":
            this.emit("event", { type: "speechComplete", turnId: e.turnId ?? 0, text: e.transcript ?? "" });
            break;
          case "speaker":
            if (e.label) this.emit("event", { type: "speaker", label: String(e.label).slice(0, 8) });
            break;
          case "error":
            this.emit("error", new Error(`asr error: ${e.message ?? JSON.stringify(e).slice(0, 200)}`));
            break;
        }
      });
      ws.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else this.emit("error", err);
      });
      ws.on("close", (code) => {
        this.ready = false;
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.closedByUs) return void this.emit("status", "closed");
        // unexpected close (1013 = busy, or network): reconnect once per second
        if (this.reconnects < (this.opts.maxReconnects ?? 5)) {
          this.reconnects++;
          this.emit("status", "reconnecting");
          setTimeout(() => {
            if (!this.closedByUs) this.connect().catch((err) => this.emit("error", err));
          }, code === 1013 ? 1000 : 300);
        } else this.emit("status", "closed");
      });
    });
  }

  /** PCM s16le 24 kHz mono. Dropped while (re)connecting — audio is live. */
  sendAudio(pcm: Buffer): void {
    if (this.isOpen) this.ws!.send(pcm);
  }

  end(): void {
    this.closedByUs = true;
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "endStream" }));
      setTimeout(() => ws.terminate(), 3000).unref();
    } else ws.terminate();
  }
}
