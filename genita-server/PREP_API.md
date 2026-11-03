# Genita onboarding prep API (v1)

HTTP JSON on the same host as the realtime session (`PROTOCOL.md`). Code: `src/prep/`.

```
Authorization: Bearer <GENITA_SESSION_TOKEN>    (same token as the session; replaced by the user JWT in F1-L5)
x-genita-user: <user id>                        (until login lands; [A-Za-z0-9_-]{1,64}, default "demo")
```

Errors are `{error, message?}` with a 4xx status. A vendor failure is `502 {error:"upstream_failed", retryable:true}`.

## Uploads: send a downscaled JPEG

**Upload the companion image as a JPEG of at most 1024 px on the long side (quality ~0.8, usually 150–300 KB).** The image check runs time on Spark's image size: 2.1–2.7 s for a 512 px copy vs 3.2–5.6 s for the 1.2 MB original (11/2). The call scene comes out at 1024×1820 anyway, so a larger upload adds no quality. The server accepts JPEG/PNG/WebP up to 8 MB and does not resize.

## Import (F3-L2, screens I01–I04)

| call | body | answer |
|---|---|---|
| `GET /v1/import/prompt` | | `{prompt, chars}`, the text I01 copies (prompt v3, 10 sections; same bytes as `docs/profile-import/prompt-v3.txt` and the app's bundled `import-prompt.txt` offline fallback, a test keeps all three identical) |
| `POST /v1/import` | `{text}` | `200 {status:"ready", style, profile}` (Spark 5–11 s, n=4 on 11/2) · `400 import_too_short/too_long/empty` → I02-E · `422 import_empty` |
| `POST /v1/import` | `{text, background:true}` | `202 {status:"processing"}` ("Continue in the background") |
| `POST /v1/import/skip` | `{interests: string[≤8, each ≤40], replies: "Talk it out"\|"Show me options"\|"Start with the answer"\|"Ask me questions"\|null, avoid: string[≤8, each ≤60]}` (N1–N3, no Spark call) | `200 {status:"ready", style, profile}` with `style.source:"skip"` · `400 bad_skip`. Answers are `explicit`; unanswered rows stay empty and `toConfirm` lists them |
| `GET /v1/import` | | `{status:"none"\|"processing"\|"failed"\|"ready", style?, profile?}` |

Prompt v3 has 10 sections: 1 Thinking style, 2 Communication style, 3 Response preferences, 4 How Genita can help, 5 Support/feedback/disagreement, 6 Interests, 7 Likes and dislikes, 8 Boundaries and initiative, 9 Recommended companion approach ("When …, Genita should …" rules), 10 Preferences still to confirm. Replies to the old 8-section prompt are still accepted: the server reads the headings and maps old "3 Useful help and explanations" to both Response preferences (how to answer) and How Genita can help (tasks), old 5's concrete tastes to Likes & dislikes. `style.sections` keys: `tendencies communication response help support interests likes boundaries approach` (cards saved before v3 may lack `response`/`likes`).

`style.display` = I04's six rows in order `communication` Communication style (section 2) · `response` Response preferences (3, then rules fill free slots) · `help` How Genita can help (4) · `interests` Interests (6) · `likes` Likes & dislikes (7; when there is a dislike, one of the 3 slots shows it) · `boundaries` Boundaries (8), each `{key, title, items:[{text, label}]}` (max 3 items). Sections 1, 5, 9 are not rows; they go into `profile`. `label` ∈ `explicit` (You said so) · `observed` (Your AI noticed) · `memory` (Your AI's memory) · `suggested` (My suggestion). An empty row shows "Not enough information yet". `style.partial` = I04-P. `style.toConfirm` = "I'll ask N more things on our first call". `profile` goes into the session's `start.user.profile` (≤2,000 chars): Likes & dislikes first as `- Taste:` lines (Finds' outfit and recipe cards read its first 800 chars), then the other five rows' fields, every boundary, the rules, the to-confirm line, then support/thinking/suggestions. The pasted text is never stored.

## How I see you + corrections (D47 HISY v2, lane 개인화)

Screens: Figma rp1wR9pxV0IsgyjvOcwo92 HISY-0~7 (import), S0~S4 (skip), C1~C3 (That's not me). HISY-0 and HISY-7 are the app's own copy; the server sends the cards between them.

| call | body | answer |
|---|---|---|
| `POST /v1/import` | as above | now also `story`: the cards (written from the same paste **in parallel** with the parse; `null` if it isn't ready 1.5 s after the parse — then it's saved when it lands, read it with `GET /v1/profile/story?wait=8`) |
| `GET /v1/profile/story?wait=s` | | `{status:"ready"\|"processing"\|"none", source:"import"\|"skip", cards, ms?}`. Not written yet (skip users, or the import's story failed) → the server writes it from the stored style (+ SUM lines once saved); `wait` (0–10 s) holds the answer that long. `processing` = still writing, ask again |
| `PATCH /v1/profile` | `{cardId, items?: string[], text?: string}` (≤2 KB; `items` = texts the user marked on C1, each must be one of the card's own: item texts, tag texts — a dislike tag is `"Not for you: <tag lowercased>"` —, help labels, unknown topics; `text` ≤200 chars; at least one) | `200 {card, ack:"Got it. I'll remember that.", changed, profile, rows}`: `card` = the same card rewritten (C3; `null` if the correction emptied it), `changed` = its texts that are new (draw them with the blue border), `rows` = the six I04 rows, updated · `400 bad_correction` · `404 no_profile` · `409 card_not_shown` · `429 rate_limited` (10/min) · `502 upstream_failed`. On `unknowns`, `items:[topic]` + `text` answers that topic and it leaves the list |

Card `{id, eyebrow, headline, subline?, items, promise?, evidence, tags?, note?, help?, unknowns?}`, in this order, each only when the profile has something for it (otherwise its topic joins `unknowns`):

| id | eyebrow | shows |
|---|---|---|
| `think` | How you think | `headline` + 1–2 `items` |
| `talk` | How you like to talk | `headline` + 1–2 `items` + `promise` ("So I'll …", the blue box) |
| `taste` | What you're into | `headline` + `tags [{group: style\|food\|watch\|interest, text, dislike}]` (dislikes dashed with ✕) + card `evidence`; `note` "No favorites yet. Tell me one anytime, or show me on camera." when there are no likes. Skip users (S2, Figma 269:228): tags are exactly the N1 tiles (`interest`, "You said this") and the N3 Clothes / Food like (blue) and no (dashed) chips (legend "From your answers") — Spark only words the headline |
| `help` | How I can help | headline "Where I'll actually be useful." + `help [{label, sub, mode: ask_first\|just_do_it}]` (≤3) + card `evidence` |
| `lines` | Lines I won't cross | headline "Some things I'll leave alone." + 1–4 `items` (the app adds "And always: I won't buy, book, or message anyone for you.") |
| `unknowns` | Still getting to know you | `headline` + `subline` (import / skip copy) + `unknowns [{item, topic, sub}]` (≤4; shrinks as calls answer them) |

`items[].evidence` / card `evidence` ∈ `explicit` (You said this) · `observed` (You did this often) · `memory` (From your memories). Never stronger than the profile lines behind the card; a `[Suggested]` line is never shown as a fact. Server checks: no personality labels, diagnosis or flattery, no injection/sensitive text (a failing card falls back to the profile's own lines).

In calls (with an account): the server uses the stored profile; each of the first 3 calls asks one `unknowns` topic (first 3 turns; `profile.asking` when the reply asks it, then the next line is checked for the answer → `profile.updated` "Noted: …"); corrections said in the call → `profile.updated` "Updated: …"; after the call, explicit statements and repeated patterns from it are saved. Finds cards get `reasons` (PROTOCOL.md).

## Insight report (SUM, Chelsea 11/4 — data model 춘식이 r01 + r02)

What Genita noticed about the user, written in the background (Muse Spark) so SUM opens with it:
the import starts it on the redacted paste (saved after the card), N1–N3 on the picks, and the app sends the setup
answers when the last P screen opens. Stored in `user_styles.style_json.insights`; the pasted reply is kept in
memory only (2 h) and never stored. `GENITA_INSIGHTS=0` → 404 (the app keeps the old SUM).
`GENITA_INSIGHTS_PROFILE=0` keeps it out of the call profile.

| Call | Body | Answer |
|---|---|---|
| `GET /v1/profile/insights?wait=s` (0–8, 30/min) | — | `{status: ready\|pending\|failed\|none, report}`; `pending` may carry the previous report |
| `POST /v1/profile/insights` (6/min) | `{answers}` — the prefs keys, partial is fine | `202 {status:"pending"}`; `400 bad_answers` |
| `POST /v1/profile/insights/:id/verdict` (10/min) | `{verdict: right\|not_me, correction?≤200}` | the report; `404 not_found`, `400 bad_verdict / bad_correction` |

`report`: `headline`, `observations[]` (3–5: `id, category, claim` "You …", `evidence[]{source import|answer, quote, source_label, highlight?}`,
`confidence high|medium` (medium → the app writes "I think"), `score, surprise, use_in_call` "I'll …", `chips?`, `verdict`),
`type {name, line, signature[3], basis[]}|null`, `mix[] {id, left, right, position 0–4, evidence}` (picks only),
`strengths[] {text, basis}`, `watchouts[] {text, fix, basis}`, `chain {you_are, so_you, so_ill}|null`,
`share {title "{name} is …", lines}|null`, `learning[] {id, label}`, `usage` "In our calls …",
`settings {why, energy, initiative, never}|null` (the old SUM four lines), `at, from, ms`.
Server checks: an import quote must be in the paste word for word, an answer quote must be a pick; generic /
horoscope lines, labels, flattery, sensitive or creepy inferences and minors' details are dropped; low
confidence → `learning`. `not_me` removes the observation (→ `learning`, and "not true" in the call profile).

## Image, voices, companion (F2-L20, F2-L8, F2-L3)

| call | body | answer |
|---|---|---|
| `POST /v1/companion/image?rights=1` | raw image bytes (`content-type: image/jpeg`), or JSON `{image: base64, rightsAck}` | `{imageId, passed, type: human\|animal\|character\|null, checks:{oneFaceFrontFacing, sharpAndLit, noText}, reasons:[{code,label}], headBox, ms}`. `checks` = V02's three rows; `reasons` = V02-F. Additive (11/4): `polish` (true = run the photo-polish confirm step below) and `heads:[{x1,y1,x2,y2}]` (every head SAM found, pixels of the uploaded image, largest first, max 6). Additive (11/4, V03 face scan): `faceOutline:[[x,y]×32]\|null` (SAM 3.1 face mask traced from the top, clockwise) and `facePoints:{leftEye,rightEye,leftBrow,rightBrow,nose,lips}\|null` (each a list of `[x,y]`; from SAM "eyes"/"mouth" boxes). All fractions of the uploaded image (0 = left/top). Both null on a failed check |
| `POST /v1/companion/image/polish` | `{imageId}` (the upload's id; "Try again" sends it again) | `200 {imageId, sourceImageId, passed, type, checks, reasons, headBox, attempt, retriesLeft, ms:{polish, check}}`. See "Photo polish" |
| `GET /v1/companion/image/{imageId}` | | the uploaded or polished image bytes (this user's only, else `404 unknown_image`) |
| `GET /v1/companion/voices?imageId=` | | `{voices:[{id, name, blurb, label, gender, previewUrl}], suggested, available}`: 4 curated Seamless speakers for the image's look (human/animal/character), recommended default first (72 / 16 / 68), `label` = "Tara · warm"; `gender` = "female" \| "male" \| "neutral" as measured (median pitch + an offline classifier, 11/3), every look has women and men; `available` = voice service answers /healthz (cached 15 s) |
| `GET /v1/companion/voices/{id}/preview` | | `audio/wav` from the Meta voice service, cached; `503 voice_unavailable` without it; device voices → `404 {error:"device_preview"}` |
| `PUT /v1/companion/voice` | `{voiceId}` | saves the V04 pick on the companion + persona card; `400 unknown_voice`, `404 no_companion` |
| `POST /v1/companion` | `{imageId, voiceId, name?}` | `201` companion (name defaults to the voice card name; a given name follows the rule below, else `400 bad_name`). Starts prep in the background ("Use this image"). `409 companion_exists`, except over a `demo:true` companion, which this replaces (below) |
| `GET /v1/companion` | | companion + `demo` + `prep` + `persona` + `session` (fields for the realtime `start` message) |

### Photo polish (11/4, flag `GENITA_PHOTO_POLISH`, default on)

Users bring any photo. Before the face set is made, one Muse Image edit turns it into a clean reference
(one subject centered, face to the viewer, mouth closed, even light, plain background, same identity, species and art
style) and V02-T shows it for confirmation. One prompt for every subject: no human / animal / character branch.

- Order: upload check first (a public figure is refused there and never edited, D26) → polish → the same Spark + SAM
  check on the result, which must pass and keep the subject type (else `reasons:[style_changed]`, `passed:false`).
- Polished: side view, poor light / blur, text over the image, a group photo (the largest subject is kept; the app can
  crop the upload to another `heads` box and upload that), a half-covered face. Refused: `public_figure`, `no_face`
  (`422 not_polishable`).
- `passed` on the upload stays strict, so a build without the confirm step works as before. V02-T offers "Use this image"
  (`POST /v1/companion {imageId}` with the polished id) and "Try again" (Chelsea 11/4: no "Use my original"; after two
  retries: the last good result or "Choose another photo").
- The confirmed polished picture is the call scene itself (scene step `source: "polish"`, no second Muse edit).
- Limits: 3 polishes per upload (first + two "Try again", then `429 polish_limit`), 6 per user per minute
  (`429 rate_limited`). `502 polish_failed {retryable, retriesLeft}` when Muse Image fails (the attempt counts).
- `GENITA_PHOTO_POLISH=0`: the upload answers `polish:false`, this route `404 polish_off`: today's flow.

### Judge demo companion (D41)

A Judge access account (`POST /auth/judge`) that has no companion gets one at sign-in: **Jin**, ready to call (prep `ready`, persona set, face files copied), so the judge skips the prep wait. `GET /v1/companion` → `demo: true` (every other companion `demo: false`); `/me` and the sign-in body → `companionDemo: true`. The app shows a small "Demo companion" label from either flag.

- **Making their own:** the judge goes through the normal flow (image → voice → name → `POST /v1/companion`). Over a `demo:true` companion, `POST /v1/companion` deletes the demo one (rows, its photo copy, its files) and creates the new one: `201`, `demo: false`. A bad request (unknown image/voice, failed check) keeps the demo companion. From then on B7 applies as usual (`409`), and signing in again does not bring Jin back.
- **Template:** `npm run demo:template` (ops only, see `scripts/demo-template.ts`) prepares Jin once from `assets/demo/jin.jpg` (Muse Image-generated, `ios-app/ASSET-SOURCES.md`) under a reserved account (`dev` / `demo:template`, not reachable by any login or `x-genita-user`). Re-run with `--force` after the prep pipeline changes so new judge accounts get the new face set. No template = judges onboard like any new user (log `demo.skipped {reason:"no_template"}`).

### Make a new companion (companion reset, 11/4)

`POST /v1/companion/reset` (session + AI consent, no body) → `200 {ok: true, removed}`. Settings → "Make a new companion" on the iPhone; also the QA way to test a new human / animal / character companion **without a new email per test**: reset, then onboard again from V01 on the same account.

- **Removed:** the companion (row + prep job, prefs/persona, voice, name, emotions), its photo and every uploaded photo no companion uses, all face files under `users/<id>/companions/` (and legacy `avatars/<cid>/`), call memory (memories, call summaries, recent openers; same as Forget all). Live calls close `4410 companion_reset`.
- **Kept:** login and sessions, consent, display name, the import / HISY profile (`GET /v1/import` stays `ready`), memory settings, reports, Finds, judge daily-turn counters.
- **Order:** like `DELETE /me`, prep, face top-up and reflow are cancelled and their in-flight writes drained first; no new prep starts until the erase is done. Afterwards `/me` → `hasCompanion: false, prepStatus: "none"`, and `POST /v1/companion` works again.
- **Limits:** 10 resets that removed a companion per account per 24 h (`429 rate_limited`; a reset with nothing to remove is `removed: false` and not counted), one at a time per account (`409 reset_in_progress`), `502 reset_failed` = retry (every step runs again). The demo template account is refused (`403 demo_template`); a judge's reset removes only the judge's own Jin copy, and the next judge sign-in brings Jin back.
- Log: `companion.reset {ok, removed, demo, photos, ms}` (or `{ok:false, reason}`).

### Voices: device vs server TTS

- **Server TTS off (default, Meta voice service unset):** the device speaks, so the four cards are device voice descriptors:
  `{id:"device:en-US:f1", name:"Mira", blurb:"Warm, steady", locale:"en-US", gender:"female"|"male"|"neutral", style:"warm", previewUrl:null}`.
  The app maps each to the best installed system voice for `locale` + `gender` (Premium/Enhanced first) and previews it locally; the preview endpoint answers `404 {error:"device_preview"}`. `POST /v1/companion {voiceId}` takes the `device:…` id. Same names, blurbs and Spark ordering as before.
- **Meta voice service configured:** the Meta voice list `{id, name, blurb, previewUrl:"/v1/companion/voices/{id}/preview"}` as before.

## Companion name (F2-L26, NM01, D21)

| call | body | answer |
|---|---|---|
| `POST /v1/companion/name/suggest` | `{imageId}` (the checked image from `POST /v1/companion/image`; works before the companion exists) | `200 {name, ms, suggested}`. Spark 1.3 looks at the photo + the imported style card and proposes one first name for NM01. `suggested:false` = Spark failed or timed out (4 s) and `name` is a neutral fallback (never a 5xx for that). `404 unknown_image` (not yours / unknown) · `429 rate_limited` (10 per user per minute) |
| `PATCH /v1/companion` | `{name}` | `200` companion (same shape as `GET`); `name`, `persona.card.name` and `session.persona.name` all carry the new name. `400 bad_name` · `404 no_companion` |

Name rule (PATCH, POST, rename by voice): trimmed, 1–20 characters, letters/digits/spaces/`.` `'` `-`,
at least one letter. Empty, whitespace-only and 21+ characters are `400 bad_name` — keep NM01's
Continue disabled for those. A suggestion is letters/spaces/hyphens/apostrophes only and never "Genita".
Renaming in a call ("Call yourself Max") saves the same way and sends `companion.named` (PROTOCOL.md).

## Prep progress (F2-L9, F2-L22)

`GET /v1/companion/prep` → `{status: running|ready|failed, progress:{done,total}, sceneUrl, face, emotionVideos:{}, lips:{status:"skipped", detail:null, url:null, ms:null}, steps:{scene, videos, face:{status, settled, total, ms}|null}}`.

### Meta-only pipeline

scene (Muse Image, retried once on failure) → **face set** (13 Muse Image edits of the scene + SAM 3.1 checks). For response compatibility, `emotionVideos` is `{}`, `lips.status` and every `steps.videos.*.status` are `"skipped"`, and video timing/lip URL fields are `null`, including for older stored records. Old video/lip job keys are ignored when resuming prep. `progress.total` = 14 (scene + 13 face images; a rejected image counts as settled). Measured 11/2 (`npm run face:e2e`, real API, n=1 per type): photo → face ready **85 s** person (check 4 s, scene 15 s, face set 66 s), **72 s** animal (5 / 18 / 49 s), **69 s** character (4 / 13 / 52 s). One Muse Image edit ≈ 11–21 s; it answers WebP 1152×2048.

`face` is `null` until the face step is done, then:

```json
{
  "version": 1,
  "size": [1152, 2048],
  "faceBox": [0.3655, 0.3203, 0.7431, 0.6104],
  "mouthBox": [0.5269, 0.5303, 0.651, 0.5586],
  "images": { "neutral": "/v1/companion/face/neutral", "blink": "/v1/companion/face/blink", "smile": "…/smile", "warm": "…/warm", "surprised": "…/surprised", "concerned": "…/concerned" },
  "visemes": { "MBP": "/v1/companion/face/MBP", "FV": "…", "TH": "…", "L": "…", "WQ": "…", "O": "…", "EI": "…", "A": "…", "U": "…", "CDG": "…" },
  "boxes": { "neutral": { "face": [..], "mouth": [..] }, "blink": { "face": [..], "mouth": [..] }, "…": {} },
  "rejected": [{ "key": "TH", "reason": "face_moved", "retried": true }],
  "ms": { "total": 65575, "edits": 260734, "sam": 35754 }
}
```

- `size` = the scene's real pixel size (Muse Image answers 1152×2048 WebP for the 1024x1820 request). Every edit has the same aspect ratio.
- Boxes are normalised `[x1, y1, x2, y2]` (0–1) of the image's own size, from SAM 3.1 (`"the person's face"` / `"the person's mouth"`; `animal` / `character` for the other types). `faceBox`/`mouthBox` = the scene's.
- `rest` = `neutral` (the scene, unedited). A viseme or expression in `rejected` is absent from `images`/`visemes`/`boxes`; fall back to the nearest shape.
- `rejected[].reason`: `face_moved` (face-box centre moved > 3 % of the width), `face_resized` (linear size changed > 6 %), `no_face`, `no_mouth`, `size_mismatch` (aspect ratio differs), `content_policy` (Muse Image refused the prompt), `edit_failed` (vendor error). Each rejected key was retried once with a stricter prompt.
- Image URLs are relative to this host: **`GET /v1/companion/face/{key}`** with the same `Authorization` + `x-genita-user` headers as every prep call. `key` ∈ `neutral`, `blink`, `smile`, `warm`, `surprised`, `concerned` (expression layer stills, 11/3 night; a set prepped before gets them in the background on its next `GET /v1/companion/prep` and serves them from the fetch after — `GENITA_FACE_TOPUP=0` stops that), `MBP`, `FV`, `TH`, `L`, `WQ`, `O`, `EI`, `A`, `U`, `CDG`. Answers the image bytes (`image/webp` today; check `content-type`), `cache-control: private, max-age=86400`. `404 no_companion` / `no_image` (not made yet, or rejected) / `not_found` (unknown key). Only the caller's own companion is served. `sceneUrl` on this pipeline is `/v1/companion/face/neutral`.
- A server restart during the face step resumes it: kept and rejected images are saved one by one, and only the missing ones are redone. If every edit fails (vendor down) the attempt fails and the runner retries (`MAX_PREP_ATTEMPTS`), then `failed`; `POST /v1/companion/prep/retry` resumes from the saved images.
- Session `lip` in `GET /v1/companion` → `session` is `"none"` for humans, animals and characters (the device animates the face set).

## Setup answers → persona (F2-L14, screens D01, P1–P7, SUM)

`POST /v1/companion/prefs {depth: quick|right|deep, answers}` → `{summary:{why, energy, initiative, never}, persona, rules, session}`

| key | depth | value |
|---|---|---|
| `help` | all | `Think with me` · `Keep me moving` · `Be there` · `Work beside me` |
| `relationship` | all | `Close companion` · `Trusted partner` · `Creative co-pilot` · `Quiet operator` |
| `presence` | all | 1–2 of `Calm` · `Witty` · `Grounded` · `Warm` |
| `challenge` | right, deep | 1 (Gentle) … 5 (Direct) |
| `pace` | right, deep | 1 (Reflective) … 5 (Quick) |
| `reachOut` | deep | 1 (Only when asked) … 5 (Anticipate) |
| `never` | deep | any of `Message anyone for me` · `Use sensitive memories` · `Interrupt focus time` · `Mirror my mood` |

Send exactly the keys of the chosen depth; a missing or extra key is `400 bad_prefs`.

## Device QA test photos (V01 "Use a test photo", 11/4)

QA drives a TestFlight iPhone over macOS iPhone Mirroring and must never open the owner's photo library. A QA account gets a small **Use a test photo** link under V01's rights line; it opens a sheet of five bundled, synthetic pictures (`ios-app/Genita/Resources/qa-sample-{human,dog,clay,anime,drawing}.jpg`: the demo companion Jin, plus the photo-polish probe set's dog, clay figure, 2D character and hand drawing). A pick goes through the same path as a library pick (`accept` → rights line → `POST /v1/companion/image` → V03 → polish / V02), so the test is real end to end.

- **Gate (server only):** env `GENITA_QA_SAMPLE_PHOTOS` = comma list of account ids (`users.id`) and/or email addresses. A listed account's `/me` and sign-in body carry `qaSamplePhotos: true`; for everyone else the key is absent. An email entry matches only an address the provider verified and never a `dev` row (Judge access / shared token). Unset = off for all. The app keeps the flag in memory only (set at sign-in and each launch `/me`, cleared at sign-out); judges and users never see the link.
- **Accessibility ids** for the QA agent: `qaSamplePhotoEntry` (the link), `qaSamplePhoto-human|dog|clay|anime|drawing` (sheet tiles). Then `rightsAck` and `primaryCTA` as usual.
- **Turn it on for an account (prod, lead / Chelsea runs it — lanes don't write SSM):**
  1. Find the account id (or use its verified email): `psql "$DATABASE_URL" -c "SELECT id, provider, email, email_verified FROM users WHERE email ILIKE '<qa email>'"`.
  2. `aws ssm put-parameter --name /genita/server/GENITA_QA_SAMPLE_PHOTOS --type SecureString --overwrite --value '<id-or-email>,<id-or-email>'`
  3. Restart so `start.mjs` re-reads SSM: `deploy/aws/server/deploy.sh <deployed ref>` (or `sudo systemctl restart genita-server` on the box via SSM). Check: the account's `GET /me` has `"qaSamplePhotos": true`; a normal account's has no such key.
  4. On the phone: sign out and in again (or relaunch) so the app reads `/me`.
- Off again: delete the parameter (`aws ssm delete-parameter --name /genita/server/GENITA_QA_SAMPLE_PHOTOS`) and restart.
