# genita-server

Realtime conversation core: Muse Voice Transcribe → Muse Spark 1.3 → Meta SeamlessM4T v2 (or on-device speech), over one WebSocket per call. Protocol: [PROTOCOL.md](PROTOCOL.md). Ticket F0-L3 (#3).
Onboarding prep (import, image check, clips, Meta voices, persona): [PREP_API.md](PREP_API.md). Uploads should be ≤1024 px JPEG.

```sh
cd genita-server && npm ci
npm test            # unit tests (node:test, no network)
npm run typecheck   # tsc --noEmit
npm start           # ws://127.0.0.1:8787/v1/session
npm run smoke -- --turns=20   # real vendors: end-of-speech → first say (device, default) or first audio (--tts=server) + barge-in timing (needs ffmpeg)
npm run check:meta  # one live call each: Spark JSON, SAM 3.1, files, Muse Image
npm run db:migrate  # apply migrations to DATABASE_URL (`-- down [n|all]` rolls back)
npm run watch-sim -- --qa            # watch together on the T5 clips: accuracy + question → first audio
npm run watch-sim -- --react a.mp4 … # one long share: proactive reactions and rule checks
npm run watch-sim -- --blank         # black screen: answers that claim to see something
```

Env (keys are read only from env; locally `~/.config/genita/meta.env` or `GENITA_ENV_FILE` is loaded):
`MODEL_API_KEY` (the only required key; without a voice service the app speaks each `say` event) ·
`GENITA_VOICE_URL` + `GENITA_VOICE_TOKEN` (our GPU's Meta voice service; both required to enable server speech) ·
`GENITA_VOICE_SPEAKERS` (`human:0,animal:0,character:0`) · `GENITA_VOICE_MODEL` (`seamless`, or Meta `mms`) ·
`GENITA_VOICE_SPEED` (1) · `GENITA_VOICE_TIMEOUT_MS` (4000; failure falls back to device speech) ·
`GENITA_KLING=1` (temporary fal/Kling clips pending #158; requires `FAL_KEY`) ·
`HOST`/`PORT` · `GENITA_SESSION_TOKEN` (shared dev token; required off loopback unless accounts are on) ·
`GENITA_DEFAULT_VOICE_ID` (`seamless:0`) ·
`GENITA_WEB_SEARCH` (1) · `GENITA_ASR_LANGUAGES` (English,Korean) · `GENITA_BARGE_IN_MIN_MS` (400) · `GENITA_BARGE_IN_MIN_WORDS` (2) ·
`GENITA_MAX_SESSIONS` (16) · `GENITA_MAX_SESSION_MS` · `GENITA_SPARK_TIMEOUT_MS` (8000) ·
`GENITA_SPARK_HEDGE` (2; 1 = off) · `GENITA_SPECULATE` (1) · `GENITA_SPECULATE_STABLE_MS` (250).

Swift types: `shared/GenitaKit` (`shared/GenitaKit/test.sh` runs its tests, also with Command Line Tools only).

Accounts and storage (F1-L2/L3/L4/L5/L8) turn on with `DATABASE_URL`:
`postgres://…` when deployed, `pglite:memory` or `pglite:<dir>` locally (PGlite = Postgres in WASM, a dev dependency; no Docker needed).
Migrations run on boot (`GENITA_DB_MIGRATE=0` to skip) · `GENITA_JWT_SECRET` (≥32 chars, required off loopback) ·
`GENITA_PUBLIC_URL` (Apple web callback base, default https://genita-api.thebeni.ai) · `GENITA_TRUST_PROXY=1` behind a proxy ·
`APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` (SIWA .p8; only needed for code exchange and revoke on delete) ·
`APPLE_BUNDLE_ID` (ai.thebeni.genita) / `APPLE_SERVICES_ID` (ai.thebeni.genita.web) ·
blobs: `GENITA_S3_BUCKET` + `GENITA_S3_REGION` + optional `GENITA_S3_ENDPOINT` (R2/MinIO, path-style) + `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`; unset = files under `GENITA_DATA_DIR/blobs`.
Without `DATABASE_URL` nothing changes: prep keeps the JSON file store and `/auth/*`, `/me` answer 503.
Tests use PGlite in memory; set `TEST_DATABASE_URL=postgres://…` to run them on a real Postgres (CI does both).

Layout: `src/auth` (Apple sign-in, session JWT, /me), `src/db` (Postgres adapter + SQL migrations), `src/storage` (S3/file blobs, SigV4), `src/meta` (Meta APIs), `src/tts` (Meta voice service), `src/prompt` (persona → instructions, pure), `src/session` (turn machine + session), `src/lips` (visemes, lip source plan), `src/text` (sentence split, tags, language), `src/watch` (Mac screen share: memo, video sound, reactions, speaker chip — F5).

ElevenLabs, Peter, MiniMax H3 and gpt-image-2 are not used. Kling/fal removal is tracked in #158; that temporary clip path remains disabled unless explicitly configured.
