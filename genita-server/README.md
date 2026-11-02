# genita-server

Realtime conversation core: Muse Voice Transcribe → Muse Spark 1.3 → ElevenLabs, over one WebSocket per call. Protocol: [PROTOCOL.md](PROTOCOL.md). Ticket F0-L3 (#3).

```sh
cd genita-server && npm ci
npm test            # unit tests (node:test, no network)
npm run typecheck   # tsc --noEmit
npm start           # ws://127.0.0.1:8787/v1/session
npm run smoke -- --turns=20   # real vendors: end-of-speech → first-audio + barge-in timing (needs ffmpeg)
npm run check:meta  # one live call each: Spark JSON, SAM 3.1, files, Muse Image
```

Env (keys are read only from env; locally `~/.config/genita/meta.env` or `GENITA_ENV_FILE` is loaded):
`MODEL_API_KEY`, `ELEVENLABS_API_KEY` (required) · `HOST`/`PORT` · `GENITA_SESSION_TOKEN` (required off loopback) ·
`GENITA_TTS_MODEL` (eleven_v4_turbo) · `GENITA_TTS_FALLBACK_MODEL` (eleven_v3) · `GENITA_DEFAULT_VOICE_ID` ·
`GENITA_WEB_SEARCH` (1) · `GENITA_ASR_LANGUAGES` (English,Korean) · `GENITA_BARGE_IN_MIN_MS` (400) · `GENITA_BARGE_IN_MIN_WORDS` (2) ·
`GENITA_MAX_SESSIONS` (16) · `GENITA_MAX_SESSION_MS` · `GENITA_SPARK_TIMEOUT_MS` (8000) · `GENITA_PETER_URL` (unset = Peter not deployed).

Layout: `src/meta` (Meta APIs), `src/tts` (ElevenLabs), `src/prompt` (persona → instructions, pure), `src/session` (turn machine + session), `src/lips` (visemes, lip source plan), `src/text` (sentence split, tags, language).
