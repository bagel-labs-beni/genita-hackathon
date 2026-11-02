# genita-server

Realtime conversation core: Muse Voice Transcribe → Muse Spark 1.3 → ElevenLabs, over one WebSocket per call. Protocol: [PROTOCOL.md](PROTOCOL.md). Ticket F0-L3 (#3).
Onboarding prep (import, image check, clips, voices, persona, Peter cache): [PREP_API.md](PREP_API.md). Uploads should be ≤1024 px JPEG.

```sh
cd genita-server && npm ci
npm test            # unit tests (node:test, no network)
npm run typecheck   # tsc --noEmit
npm start           # ws://127.0.0.1:8787/v1/session
npm run smoke -- --turns=20   # real vendors: end-of-speech → first say (device, default) or first audio (--tts=server) + barge-in timing (needs ffmpeg)
npm run bench:voice -- --max-containers=1  # first configure Modal max_containers=1, then warm it (`cd ../deploy/modal-voice && python scale.py warm`; this only sets min_containers=1). The benchmark aborts without a single-GPU acknowledgement. Copy the recommendation only with p90 ≤3 s, zero errors, and complete samples.
npm run check:meta  # one live call each: Spark JSON, SAM 3.1, files, Muse Image
npm run db:migrate  # apply migrations to DATABASE_URL (`-- down [n|all]` rolls back)
npm run watch-sim -- --qa            # watch together on the T5 clips: accuracy + question → first audio
npm run watch-sim -- --react a.mp4 … # one long share: proactive reactions and rule checks
npm run watch-sim -- --blank         # black screen: answers that claim to see something
```

Env (keys are read only from env; locally `~/.config/genita/meta.env` or `GENITA_ENV_FILE` is loaded):
`MODEL_API_KEY` (the only required key) · flags, all off by default — `GENITA_SERVER_TTS=1` (ElevenLabs voice, needs `ELEVENLABS_API_KEY`; off = device voice mode, the app speaks `say` text), `GENITA_KLING=1` (fal/Kling in prep, needs `FAL_KEY`), `GENITA_PETER=1` (Peter, needs `GENITA_PETER_URL` + `GENITA_PETER_TOKEN`) · `HOST`/`PORT` · `GENITA_SESSION_TOKEN` (shared dev token; required off loopback unless accounts are on) ·
`GENITA_TTS_MODEL` (eleven_v4_turbo) · `GENITA_TTS_FALLBACK_MODEL` (eleven_v3) · `GENITA_DEFAULT_VOICE_ID` ·
`GENITA_WEB_SEARCH` (1) · `GENITA_ASR_LANGUAGES` (English,Korean) · `GENITA_BARGE_IN_MIN_MS` (400) · `GENITA_BARGE_IN_MIN_WORDS` (2) ·
`GENITA_MAX_SESSIONS` (16) · `GENITA_MAX_SESSION_MS` · `GENITA_SPARK_TIMEOUT_MS` (8000) ·
`GENITA_SPARK_HEDGE` (2; 1 = off) · `GENITA_SPECULATE` (1) · `GENITA_SPECULATE_STABLE_MS` (250) ·
`GENITA_PETER_URL` + `GENITA_PETER_TOKEN` (Peter worker wss URL and WORKER_TOKEN; read only with `GENITA_PETER=1`).

Swift types: `shared/GenitaKit` (`shared/GenitaKit/test.sh` runs its tests, also with Command Line Tools only).

## Optional live-check fixtures

Live-check scripts use your own test media, outside the repository. Set
`GENITA_FIXTURES_DIR` in your environment or `GENITA_ENV_FILE` to that directory.
Scripts fail with a configuration error when required fixture media has no
configured root. No developer-specific path is assumed.

| Script | Paths relative to `GENITA_FIXTURES_DIR` | Input override |
| --- | --- | --- |
| `smoke` | `out/en.mp3`, `suite/t3/u0.mp3` through `u18.mp3` | Audio file arguments |
| `check:meta` | `out/dogf.jpg` | Image file argument |
| `prep:e2e`, `accounts:e2e` | `out/img/p1.jpg` | Image file argument |
| `watch-sim -- --qa` (also the default mode) | `suite/t5.json`, `suite/t5/<clip-key>.mp4` | `--react <files...>` and `--blank` do not require fixtures |
| `smoke:interpret` | `suite/t7/0.mp3` through `9.mp3` | — |
| `finds:e2e` | `suite/t4/ff_0.2.jpg`, `ff_1.4.jpg`, `of_0.6.jpg`, `of_2.0.jpg` | — |

For example, `GENITA_FIXTURES_DIR=/path/to/test-media npm run smoke` uses that
fixture layout; `npm run smoke -- ./sample.wav` uses an explicit input instead.
Provide media you have permission to use. These checks call live vendors and
are separate from `npm test`. Finds reports default to the operating system's
temporary directory under `genita-finds-e2e`; use `--out=<dir>` to change it.

Accounts and storage (F1-L2/L3/L4/L5/L8) turn on with `DATABASE_URL`:
`postgres://…` when deployed, `pglite:memory` or `pglite:<dir>` locally (PGlite = Postgres in WASM, a dev dependency; no Docker needed).
Migrations run on boot (`GENITA_DB_MIGRATE=0` to skip) · `GENITA_JWT_SECRET` (≥32 chars, required off loopback) ·
`GENITA_PUBLIC_URL` (Apple web callback base, default https://genita-api.thebeni.ai) · `GENITA_TRUST_PROXY=1` behind a proxy ·
`APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` (SIWA .p8; only needed for code exchange and revoke on delete) ·
`APPLE_BUNDLE_ID` (ai.thebeni.genita) / `APPLE_SERVICES_ID` (ai.thebeni.genita.web) ·
blobs: `GENITA_S3_BUCKET` + `GENITA_S3_REGION` + optional `GENITA_S3_ENDPOINT` (R2/MinIO, path-style) + `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`; unset = files under `GENITA_DATA_DIR/blobs`.
Without `DATABASE_URL` nothing changes: prep keeps the JSON file store and `/auth/*`, `/me` answer 503.
Tests use PGlite in memory; set `TEST_DATABASE_URL=postgres://…` to run them on a real Postgres (CI does both).

Layout: `src/auth` (Apple sign-in, session JWT, /me), `src/db` (Postgres adapter + SQL migrations), `src/storage` (S3/file blobs, SigV4), `src/meta` (Meta APIs), `src/tts` (ElevenLabs), `src/prompt` (persona → instructions, pure), `src/session` (turn machine + session), `src/lips` (visemes, lip source plan), `src/text` (sentence split, tags, language), `src/watch` (Mac screen share: memo, video sound, reactions, speaker chip — F5).
