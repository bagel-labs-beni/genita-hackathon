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
| `GET /v1/import/prompt` | | `{prompt, chars}`, the text I01 copies |
| `POST /v1/import` | `{text}` | `200 {status:"ready", style, profile}` (Spark 4–8 s) · `400 import_too_short/too_long/empty` → I02-E · `422 import_empty` |
| `POST /v1/import` | `{text, background:true}` | `202 {status:"processing"}` ("Continue in the background") |
| `GET /v1/import` | | `{status:"none"\|"processing"\|"failed"\|"ready", style?, profile?}` |

`style.display` = I04's six rows in order `communication` Communication style · `response` Response preferences · `help` How Genita can help · `interests` Interests · `likes` Likes & dislikes · `boundaries` Boundaries, each `{key, title, items:[{text, label}]}` (max 3 items). `label` ∈ `explicit` (You said so) · `observed` (Your AI noticed) · `memory` (Your AI's memory) · `suggested` (My suggestion). An empty row shows "Not enough information yet". `style.partial` = I04-P. `style.toConfirm` = "I'll ask N more things on our first call". `profile` goes into the session's `start.user.profile`. The pasted text is never stored.

## Image, voices, companion (F2-L20, F2-L8, F2-L3)

| call | body | answer |
|---|---|---|
| `POST /v1/companion/image?rights=1` | raw image bytes (`content-type: image/jpeg`), or JSON `{image: base64, rightsAck}` | `{imageId, passed, type: human\|animal\|character\|null, checks:{oneFaceFrontFacing, sharpAndLit, noText}, reasons:[{code,label}], headBox, ms}`. `checks` = V02's three rows; `reasons` = V02-F |
| `GET /v1/companion/voices?imageId=` | | `{voices:[{id, name, blurb, previewUrl}], suggested}`, already in Spark's recommended order |
| `GET /v1/companion/voices/{id}/preview` | | `audio/mpeg`, ~8 s |
| `POST /v1/companion` | `{imageId, voiceId, name?}` | `201` companion (name defaults to the voice card name; a given name follows the rule below, else `400 bad_name`). Starts prep in the background ("Use this image"). `409 companion_exists` |
| `GET /v1/companion` | | companion + `prep` + `persona` + `session` (fields for the realtime `start` message) |

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

`GET /v1/companion/prep` → `{status: running|ready|failed, progress:{done,total}, sceneUrl, emotionVideos:{neutral, happy, warm}, lips:{status, peter:{avatarId, bundleId, nBase}|null}}`.

- A human companion takes about 7 min to clips (three 10 s Kling clips in parallel), then the Peter cache bake. Until `ready`, call with the photo (S09-P). On `failed`, the photo keeps breathing (S09-PF) and `POST /v1/companion/prep/retry` starts again.
- `emotionVideos` are 1080×1920 mp4 URLs keyed by the session's `speaking.emotion`.
- `lips.peter.avatarId` goes in the Peter worker HELLO (`{"type":"HELLO", token, avatar_id}`). The worker's READY `bundle_id` equals `lips.peter.bundleId`.

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
