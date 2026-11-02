# genita-server

Realtime conversation core: Muse Voice Transcribe → Muse Spark 1.3 → Meta SeamlessM4T v2 (or on-device speech), over one WebSocket per call. Protocol: [PROTOCOL.md](PROTOCOL.md). Ticket F0-L3 (#3).
Onboarding prep (import, image check, scene and face set, Meta voices, persona): [PREP_API.md](PREP_API.md). Uploads should be ≤1024 px JPEG.

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
`HOST`/`PORT` · `GENITA_SESSION_TOKEN` (shared dev token; required off loopback unless accounts are on) ·
`GENITA_DEFAULT_VOICE_ID` (`seamless:0`) ·
`GENITA_WEB_SEARCH` (1) · `GENITA_ASR_LANGUAGES` (English,Korean) · `GENITA_BARGE_IN_MIN_MS` (400) · `GENITA_APP_CONFIG_FILE` (JSON overrides for `GET /v1/app-config`, PROTOCOL.md) · `GENITA_BARGE_IN_MIN_WORDS` (2) ·
`GENITA_MAX_SESSIONS` (16) · `GENITA_MAX_SESSION_MS` · `GENITA_SPARK_TIMEOUT_MS` (8000) ·
`GENITA_SPARK_HEDGE` (2; 1 = off) · `GENITA_SPECULATE` (1) · `GENITA_SPECULATE_STABLE_MS` (250).

D46 operational controls (SSM env changes take effect after a server restart):

| Environment variable | Default | Effect |
| --- | --- | --- |
| `GENITA_PAUSED` | `0` | `1` rejects generation REST with `503 {"error":"paused"}` and new call WebSockets with `503 Paused`. Config is checked at admission; running calls, health, status, saved Finds, auth and account deletion keep working. |
| `GENITA_PAUSE_FILE` | unset | While this file exists, the same pause applies **without a restart** (checked every 5 s; running calls keep going). On AWS e.g. `/var/lib/genita/PAUSED`: `touch` to pause, `rm` to resume. |
| `GENITA_META_DAILY_CALLS` | `20000` | Global outbound Meta requests per UTC day, including retries, streaming requests, file uploads and each Transcribe socket open. |
| `GENITA_META_DAILY_IMAGES` | `600` | Muse Image generations/edits per UTC day, also counted as Meta calls. |
| `GENITA_USER_DAILY_TURNS` | `300` | Accepted final user turns per UTC day across sessions; shared dev sessions without an explicit user are exempt. |

A cap of `0` or less is unlimited. REST admission returns `429 {"error":"limit_reached","limit":"meta_calls"}`
(or `meta_images` for an image route); every outbound Meta request is checked again
before sending. Failed vendor requests still count. Global counters and the no-DB
user counters live in memory on the single EC2 host: **a restart resets them**
(accepted worst case: one extra day's budget). User turns are admitted from memory
without waiting on the database; with accounts enabled each accepted turn is also
written to `usage_daily` (UTC date) in the background and the stored total flows back,
so a restart allows at most one extra turn. A DB error is logged (`ops.turn_error`)
and the in-memory count still enforces the cap. Session caps use the existing `spark_unavailable` code
with `retryable:false`. Chat speculation checks available turns first; interpreter
speculation is disabled for capped users so partial transcripts do not spend turns.
CloudWatch events: `ops.paused` once per kind/minute, `limit.reached` once per
limit/day, and nonzero `ops.usage` at most once per 10 minutes when requests occur.
The pause switch blocks new work at admission; background prep already started
and calls already running finish subject to the budgets. A paused restart leaves
persisted prep jobs queued; they resume on the next unpaused restart.

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
email code sign-in (`POST /auth/email/start` → `/auth/email/verify`): `RESEND_API_KEY` + `GENITA_MAIL_FROM` (a sender on a domain verified in that Resend account); unset on a loopback dev server = the code is printed in the server log (`auth.email_code_dev`), unset when deployed = 503 ·
blobs: `GENITA_S3_BUCKET` + `GENITA_S3_REGION` + optional `GENITA_S3_ENDPOINT` (R2/MinIO, path-style) + `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`; unset = files under `GENITA_DATA_DIR/blobs`.
Without `DATABASE_URL` nothing changes: prep keeps the JSON file store and `/auth/*`, `/me` answer 503.
Tests use PGlite in memory; set `TEST_DATABASE_URL=postgres://…` to run them on a real Postgres (CI does both).

Layout: `src/auth` (Apple sign-in, session JWT, /me), `src/db` (Postgres adapter + SQL migrations), `src/storage` (S3/file blobs, SigV4), `src/meta` (Meta APIs), `src/tts` (Meta voice service), `src/prompt` (persona → instructions, pure), `src/session` (turn machine + session), `src/lips` (visemes, lip source plan), `src/handoff` (F6-L7 conversation owner: active_device + epoch, presence socket, audio gate), `src/text` (sentence split, tags, language), `src/watch` (Mac screen share: memo, video sound, reactions, speaker chip — F5).

ElevenLabs, Kling, fal, Peter, MiniMax H3 and gpt-image-2 are not used.
