# Built during the hackathon (Oct 27 – Nov 5, 2026)

Everything in this demo was built during the hackathon on Meta models; none of our earlier products' code is used.

Everything we wrote was built during the hackathon, from the kickoff on Oct 26, 12:00 ET (Oct 27, 01:00 KST) to the deadline on Nov 4, 21:00 ET (Nov 5, 11:00 KST). The first commit is dated **Oct 31, 2026, 00:56 KST**, and no commit is older than the kickoff. Open-source dependencies are listed in Credits ([CREDITS.md](CREDITS.md)) and at the end of this section.

| # | Feature | What we built | Where in the repo | First commit (KST) |
| --- | --- | --- | --- | --- |
| F1 | Sign-in and consent | Email-code and Sign in with Apple accounts, consent, account deletion, Judge access login with rate limits | `genita-server/src/auth/`, `ios-app/`, `mac-app/` | Nov 2 |
| F2 | Start already knowing you (import) | The import prompt, parsing, and a taste card that keeps learning from calls | `docs/profile-import/`, `genita-server/src/personalize/` | Nov 1 (prompt), Nov 2 (server) |
| F3 | Face, voice and name from one photo | Photo check, a Muse Image scene, expressions and mouth shapes, SAM 3.1 drift checks, voice list, name suggestion | `genita-server/src/prep/`, `deploy/modal-voice/` | Nov 2 |
| F4 | Companion setup questions and summary | Setup questions that shape how the companion talks, and the companion card | `genita-server/src/prep/`, `ios-app/` | Nov 2 |
| F5 | Video call | Realtime loop (Transcribe → Spark → voice), speculative replies, barge-in, the mouth engine (TS/Swift), the expression renderer, speak-first rules, guardrails | `genita-server/src/session/`, `genita-server/src/convo/`, `genita-server/src/lips/`, `shared/Call/`, `shared/GenitaKit/Sources/GenitaKit/Lips/` | Nov 2 (core), Nov 3 (conversation engine) |
| F6 | Look together with the iPhone camera | Camera questions, SAM 3.1 boxes and masks on what the companion sees | `genita-server/src/observe/`, `genita-server/src/perception/`, `shared/Call/` | Nov 3 |
| F7 | Result sheets, product search, Finds | Recipe, product, answer and "what's this" cards with real links and pictures | `genita-server/src/finds/` | Nov 2 |
| F8 | iPhone → Mac move | Server conversation ownership (`active_device` + epoch), pairing, proximity, ARKit and LiDAR screen registration, the move effect | `genita-server/src/handoff/`, `shared/Handoff/`, `ios-app/Genita/LidarWorldTracker.swift` | Nov 1 |
| F9 | Mac call and watching together | Mac call client, window share, a running story memo so it can answer "who's that?" | `mac-app/`, `genita-server/src/watch/` | Oct 31 (Mac app), Nov 2 (watch) |
| F10 | Live interpretation (in person) | Transcribe → Spark translation → voice, with the language picked automatically | `genita-server/src/interpret/` | Nov 2 |
| F11 | Memory | Memory extraction with Muse Spark, storage, recall, and forgetting things during a call | `genita-server/src/memory/` | Nov 2 |
| F12 | Coming back | A greeting for return visits, and the same companion and context on both devices | `genita-server/src/memory/`, `genita-server/src/handoff/` | Nov 2 |
| — | Running it | Voice service on our GPU (SeamlessM4T v2, MMS), AWS deployment, daily cost caps and a pause switch, local mode with one Meta key | `deploy/modal-voice/`, `deploy/aws/server/`, `genita-server/src/ops/`, `genita-server/src/localMode.ts` | Nov 2–3 |

All AI that Genita calls at runtime is a Meta model: Muse Spark 1.3, Muse Voice Transcribe, Muse Image 1.0, SAM 3.1, SeamlessM4T v2 and MMS. Speech is Meta too: Muse Voice Transcribe powers both the call and the "hold to say" field for editing your profile card. We also tried Muse Spark Open on Baseten, but it was never available, so it is not used. Genita never calls ChatGPT, Claude or any other non-Meta AI. The profile you import is text you chose to copy. Our earlier lip-sync engine is not used in this submission.

Some early commits have voice and image adapters for non-Meta providers. We replaced them during the hackathon to follow the Meta-only rule, so the latest commit calls only Meta models.

### How to verify

```sh
git log --reverse --date=iso --format='%ad  %an  %s' | head -5     # first commits: Oct 31, 2026
git log --no-merges --date=short --format='%ad' | sort | uniq -c   # commits per day, Oct 31 – Nov 5
git log --reverse --date=short --format='%ad %s' -- genita-server/src/finds | head -1   # first commit of any feature folder
git log --format='%an' | sort | uniq -c                            # authors: our two team members
```

The history is our real working history, filtered for publishing. We removed files that are not part of this submission from every commit, and we changed author emails to public addresses. Commit dates are unchanged.

**Dependencies (open source, under their own licenses):** EffectSource's Duo blur shader and sampler (MIT, © 2026 Akash T, [license](../shared/Handoff/EffectSource/LICENSE)), the base of the move effect, with Genita's compositor written on top of it; Three.js, esbuild, Sparkle, `pg`, `ws`, PGlite, PyTorch, torchaudio, Transformers; the CMU Pronouncing Dictionary; the SAM 3.1 mask decoder ported from Meta's `@meta-sam/parser`; and the Pretendard and Noto Serif KR fonts. See [NOTICE.md](../NOTICE.md) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Back to the [Genita README](../README.md).
