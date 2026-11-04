# Run Genita locally

Part of the [Genita README](../README.md).

Local mode needs **one key**: a Meta API key (`MODEL_API_KEY`). It uses no AWS, no GPU, no mail provider and no Apple keys. Data stays on your machine (PGlite, which is Postgres in WebAssembly, plus plain files). Without your own voice GPU, the server sends each reply as text and the apps show it as captions; the apps never use the system voice.

### Requirements

| Tool | Version | Source |
| --- | --- | --- |
| Node.js | 22.6 or newer (with npm) | `genita-server/package.json` `engines` |
| Xcode | 26 | `.github/workflows/apple-build.yml` (macOS 15 runner, Xcode 26) |
| iOS simulator | iOS 18.0 or newer | `IPHONEOS_DEPLOYMENT_TARGET` |
| macOS (Mac app) | 15.0 or newer | `MACOSX_DEPLOYMENT_TARGET` |
| Docker | optional, for Postgres instead of PGlite | `genita-server/docker-compose.yml` |

### Environment variables

Copy `.env.example` to `.env` at the repository root. Only `MODEL_API_KEY` is required. `npm run local` keeps only the local settings below and drops every cloud or vendor setting.

| Name | Required | Used in local mode | What it is |
| --- | --- | --- | --- |
| `MODEL_API_KEY` | **yes** | yes | Meta API key (Muse Spark, Muse Voice Transcribe, Muse Image, SAM 3.1) |
| `PORT` | no | yes | Server port, default `8787` |
| `GENITA_DATA_DIR` | no | yes | Data folder, default `genita-server/.genita-data` |
| `DATABASE_URL` | no | yes | `pglite:<dir>` (default) or a loopback Postgres URL |
| `GENITA_LOCAL_VOICE`, `GENITA_VOICE_URL`, `GENITA_VOICE_TOKEN` | no | only with `GENITA_LOCAL_VOICE=1` | Your own voice GPU (see `deploy/modal-voice/`) |
| `GENITA_VOICE_ALIGN`, `GENITA_VOICE_MODEL` | no | only with `GENITA_LOCAL_VOICE=1` | MMS timing on, or the `mms` backup voice |
| `BASETEN_API_KEY` | no | no | Muse Spark Open on Baseten; tried, never available in our runs (see Meta AI integration notes) |
| `GENITA_JWT_SECRET` | deployment | no | Session signing secret (32+ characters) |
| `GENITA_JUDGE_CODES` | deployment | no | Judge access codes (kept in AWS SSM, not in this repository) |
| `RESEND_API_KEY`, `GENITA_MAIL_FROM` | deployment | no | Email sign-in codes. Locally the code is printed in the server terminal |
| `GENITA_S3_BUCKET`, `GENITA_S3_REGION`, AWS credentials | deployment | no | Image storage. Locally, files go to `GENITA_DATA_DIR/blobs` |
| `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_BUNDLE_ID`, `APPLE_SERVICES_ID` | deployment | no | Sign in with Apple |

### 1. Server

```sh
git clone https://github.com/bagel-labs-beni/genita-hackathon.git genita
cd genita
cp .env.example .env            # put your Meta API key after MODEL_API_KEY=
cd genita-server
npm ci
npm run local
```

The server listens on `http://127.0.0.1:8787` (WebSocket `ws://127.0.0.1:8787/v1/session`). Check it with `curl -s http://127.0.0.1:8787/healthz`. Delete `genita-server/.genita-data/` to reset. Tests need no keys: `npm test`. For Docker Postgres instead of PGlite, run `docker compose up -d` in `genita-server/` and set `DATABASE_URL=postgres://genita:genita@127.0.0.1:5432/genita` (we did not test the Docker path on our development machine). More: [`genita-server/README.md`](../genita-server/README.md).

### 2. iOS simulator

Open `ios-app/Genita.xcodeproj`, scheme **Genita**, any iPhone simulator. In Product > Scheme > Edit Scheme > Run > Arguments > Environment Variables, add:

```
GENITA_API_URL    = http://127.0.0.1:8787
GENITA_SERVER_URL = ws://127.0.0.1:8787/v1/session
```

Run, choose **Continue with email**, type any address, and copy the six-digit code from the server terminal (no mail is sent). Accept the data notice and set up a companion. The simulator has no camera; use the simulator microphone.

### 3. Mac app

Same project, scheme **GenitaMac** (it builds `Genita.app`), with the same two environment variables. Sign in with the same email. See [`mac-app/README.md`](../mac-app/README.md) for screen sharing and moving a call.

### Sample input to try

- In setup, paste a profile reply. Synthetic samples: [`genita-server/evals/import/samples/`](../genita-server/evals/import/samples/).
- Use a photo you own of a face, a pet or a drawn character.
- In a call, say "Can you find me a kimchi fried rice recipe?" or "Find me a light jacket for this weekend."

### What costs money

| Part | Needed for | Paid |
| --- | --- | --- |
| Meta API (`MODEL_API_KEY`) | Everything AI, including local mode | Billed by Meta under its API terms |
| Voice GPU on Modal | The companion's own voice (optional in local mode; otherwise captions) | GPU time on your Modal account |
| AWS (EC2, RDS, S3, CloudFront) | The hosted deployment only | Yes |
| Resend, Apple Developer Program | Email codes and Sign in with Apple in the hosted deployment | Resend plan; Apple membership |
