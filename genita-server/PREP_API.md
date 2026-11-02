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

## Image, voices, companion (F2-L20, F2-L8, F2-L3)

| call | body | answer |
|---|---|---|
| `POST /v1/companion/image?rights=1` | raw image bytes (`content-type: image/jpeg`), or JSON `{image: base64, rightsAck}` | `{imageId, passed, type: human\|animal\|character\|null, checks:{oneFaceFrontFacing, sharpAndLit, noText}, reasons:[{code,label}], headBox, ms}`. `checks` = V02's three rows; `reasons` = V02-F |
| `GET /v1/companion/voices?imageId=` | | `{voices:[…], suggested}`, already in Spark's recommended order (see below) |
| `GET /v1/companion/voices/{id}/preview` | | `audio/wav` from Meta voice service; device voices → `404 {error:"device_preview"}` |
| `POST /v1/companion` | `{imageId, voiceId, name?}` | `201` companion (name defaults to the voice card name; a given name follows the rule below, else `400 bad_name`). Starts prep in the background ("Use this image"). `409 companion_exists` |
| `GET /v1/companion` | | companion + `prep` + `persona` + `session` (fields for the realtime `start` message) |

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
  "images": { "neutral": "/v1/companion/face/neutral", "blink": "/v1/companion/face/blink", "smile": "…/smile", "warm": "…/warm" },
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
- Image URLs are relative to this host: **`GET /v1/companion/face/{key}`** with the same `Authorization` + `x-genita-user` headers as every prep call. `key` ∈ `neutral`, `blink`, `smile`, `warm`, `MBP`, `FV`, `TH`, `L`, `WQ`, `O`, `EI`, `A`, `U`, `CDG`. Answers the image bytes (`image/webp` today; check `content-type`), `cache-control: private, max-age=86400`. `404 no_companion` / `no_image` (not made yet, or rejected) / `not_found` (unknown key). Only the caller's own companion is served. `sceneUrl` on this pipeline is `/v1/companion/face/neutral`.
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
