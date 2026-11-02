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

## How I see you + corrections (D47, lane 개인화)

| call | body | answer |
|---|---|---|
| `POST /v1/import` | as above | now also `story`: the seven cards (written from the same paste **in parallel** with the parse; `null` if it isn't ready 1.5 s after the parse — then it's saved when it lands, read it with `GET /v1/profile/story?wait=8`) |
| `GET /v1/profile/story?wait=s` | | `{status:"ready"\|"processing"\|"none", source:"import"\|"skip", cards, ms?}`. Not written yet (skip users, or the import's story failed) → the server writes it from the stored style (+ SUM lines once saved); `wait` (0–10 s) holds the answer that long. `processing` = still writing, ask again |
| `PATCH /v1/profile` | `{cardId, pick?, text?}` (≤2 KB, `text` ≤200 chars, `pick` ∈ that card's `picks`, at least one) | `200 {card, ack:"Got it. I'll remember that.", changed, profile, rows}` (`rows` = the six I04 rows, updated) · `400 bad_correction` · `404 no_profile` · `429 rate_limited` (10/min) · `502 upstream_failed`. Spark turns the pick/text into explicit profile lines (newer wins), then rewrites that one card. `unknowns` + "Don't ask about these" clears the open items without Spark |

Card: `{id, title, observation, promise, evidence, later, picks, tags?, help?, unknowns?}` in this order: `opener` How I see you · `think` How you think things through · `talk` How you like to talk · `taste` Your taste (`tags: {style, food, watch, dislikes}`, ≤4 each) · `help` How I can help (`help: [{label, mode: ask_first|just_do_it}]`, ≤4) · `lines` Your lines · `unknowns` Still getting to know you (`unknowns: [items]`, shrinks as calls fill them). `observation` ≤2 short sentences in the companion's voice ("You …"), `promise` starts "So I'll". `later: true` = nothing to say yet (show it as "tell me later"). `evidence` is never stronger than the profile lines behind the card. Server checks: no personality labels, diagnosis or flattery, no injection/sensitive text (a failing card falls back to the profile's own line).

In calls (with an account): the server uses the stored profile, asks one `unknowns` item in each of the first 3 calls (first 3 turns), saves corrections said in the call (`profile.updated` event, PROTOCOL.md) and, after the call, explicit statements and repeated patterns from it.

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
