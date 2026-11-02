# genita-server

Realtime conversation core: Muse Voice Transcribe → Muse Spark 1.3 → ElevenLabs, over one WebSocket per call. Protocol: [PROTOCOL.md](PROTOCOL.md). Ticket F0-L3 (#3).

```sh
cd genita-server && npm ci
npm test            # unit tests (node:test, no network)
npm run typecheck   # tsc --noEmit
npm start           # ws://127.0.0.1:8787/v1/session
npm run smoke -- --turns=20   # real vendors: end-of-speech → first-audio + barge-in timing (needs ffmpeg)
npm run check:meta  # one live call each: Spark JSON, SAM 3.1, files, Muse Image
npm run watch-sim -- --qa            # watch together on the T5 clips: accuracy + question → first audio
npm run watch-sim -- --react a.mp4 … # one long share: proactive reactions and rule checks
npm run watch-sim -- --blank         # black screen: answers that claim to see something
```

Env (keys are read only from env; locally `~/.config/genita/meta.env` or `GENITA_ENV_FILE` is loaded):
`MODEL_API_KEY`, `ELEVENLABS_API_KEY` (required) · `HOST`/`PORT` · `GENITA_SESSION_TOKEN` (required off loopback) ·
`GENITA_TTS_MODEL` (eleven_v4_turbo) · `GENITA_TTS_FALLBACK_MODEL` (eleven_v3) · `GENITA_DEFAULT_VOICE_ID` ·
`GENITA_WEB_SEARCH` (1) · `GENITA_ASR_LANGUAGES` (English,Korean) · `GENITA_BARGE_IN_MIN_MS` (400) · `GENITA_BARGE_IN_MIN_WORDS` (2) ·
`GENITA_MAX_SESSIONS` (16) · `GENITA_MAX_SESSION_MS` · `GENITA_SPARK_TIMEOUT_MS` (8000) ·
`GENITA_SPARK_HEDGE` (2; 1 = off) · `GENITA_SPECULATE` (1) · `GENITA_SPECULATE_STABLE_MS` (250) ·
`GENITA_PETER_URL` + `GENITA_PETER_TOKEN` (Peter worker wss URL and WORKER_TOKEN; unset = Peter not deployed).

Swift types: `shared/GenitaKit` (`shared/GenitaKit/test.sh` runs its tests, also with Command Line Tools only).

Layout: `src/meta` (Meta APIs), `src/tts` (ElevenLabs), `src/prompt` (persona → instructions, pure), `src/session` (turn machine + session), `src/lips` (visemes, lip source plan), `src/text` (sentence split, tags, language), `src/watch` (Mac screen share: memo, video sound, reactions, speaker chip — F5).
