# Genita notices

Genita is a free, non-commercial preview. No fee is charged.

Our own code is licensed under Apache-2.0 (see [LICENSE](LICENSE)). The models, libraries, fonts and services below keep their own licenses and terms. Nothing in this repository relicenses them.

## Meta models through the Meta API

Called at runtime through the Meta API and used under the Meta API terms:

| Model | Model id in code | Used for |
| --- | --- | --- |
| Muse Spark 1.3 | `muse-spark-1.3` | Conversation, vision, web search, cards, import, memory, translation |
| Muse Voice Transcribe | `muse-voice-transcribe-1.0` | Live speech recognition, interpretation |
| Muse Image 1.0 | `muse-image-1.0` | Call scene, expressions, mouth shapes, card illustrations |
| SAM 3.1 | `sam-3.1` | Boxes and masks on camera frames and face edits |

Inputs sent with hackathon credits may be used under Meta's terms for those credits.

## Meta open models on our own GPU

The voice service in `deploy/modal-voice/` runs these Meta open models on our own GPU container (Modal):

| Model | Source | Used for | License |
| --- | --- | --- | --- |
| SeamlessM4T v2 | [`facebook/seamless-m4t-v2-large`](https://huggingface.co/facebook/seamless-m4t-v2-large) | The companion's voice | CC-BY-NC-4.0 |
| MMS forced aligner | torchaudio `MMS_FA` ([Scaling Speech Technology to 1,000+ Languages](https://arxiv.org/abs/2305.13516)) | Optional word and phoneme timing | CC-BY-NC-4.0 |
| MMS-TTS | [`facebook/mms-tts-eng`](https://huggingface.co/facebook/mms-tts-eng), [`facebook/mms-tts-kor`](https://huggingface.co/facebook/mms-tts-kor) | Backup voice | CC-BY-NC-4.0 |

CC-BY-NC-4.0: https://creativecommons.org/licenses/by-nc/4.0/. Attribution: Meta AI (FAIR). Because of this license, Genita uses these models only in this free, non-commercial preview. The model weights are not stored in this repository; the voice service downloads them from Hugging Face and the torchaudio model store when its container image is built.

## Open-source software

| Component | Version | Where | License | Copyright / source |
| --- | --- | --- | --- | --- |
| Sparkle | 2.10.0 (Swift Package) | Mac app updates | MIT | Sparkle Project contributors, https://github.com/sparkle-project/Sparkle |
| Three.js | 0.170.0 | Move effect bundle (`package.json`) | MIT | Three.js authors. The license attribution is kept in the built effect output |
| esbuild | 0.25.12 | Builds the move effect bundle (dev) | MIT | Evan Wallace |
| EffectSource | — | `shared/Handoff/EffectSource/` | MIT | © 2026 Akash T, license kept at [`shared/Handoff/EffectSource/LICENSE`](shared/Handoff/EffectSource/LICENSE) |
| pg | ^8.23 | Server Postgres client | MIT | Brian Carlson and contributors |
| ws | ^8.22 | Server WebSocket | MIT | Einar Otto Stangvik and contributors |
| PGlite (`@electric-sql/pglite`) | ^0.5.14 | Local-mode Postgres | Apache-2.0 | ElectricSQL |
| TypeScript | 5.9 | Type checking (dev) | Apache-2.0 | Microsoft |
| PyTorch, torchaudio | 2.6.0 | Voice service | BSD-style | PyTorch contributors |
| Hugging Face Transformers | 4.56.2 | Voice service model loading | Apache-2.0 | Hugging Face |
| sentencepiece, protobuf, numpy | — | Voice service | Apache-2.0, BSD-3-Clause, BSD-3-Clause | Their authors |
| Modal client | — | Voice service deployment | Apache-2.0 | Modal Labs |
| CMU Pronouncing Dictionary | — | `genita-server/src/lips/dict/` (word-to-phoneme lookup) | BSD-style | © 1993-2015 Carnegie Mellon University, license kept at [`genita-server/src/lips/dict/cmudict-LICENSE`](genita-server/src/lips/dict/cmudict-LICENSE) |
| SAM 3.1 mask wire format | — | `genita-server/src/meta/samMask.ts` ports the mask decoder of Meta's `@meta-sam/parser` to read SAM 3.1 output from the Meta API | SAM License | Meta Platforms, Inc. |

## Fonts

| Font | Where | License |
| --- | --- | --- |
| Pretendard | `ios-app/Genita/Resources/PretendardVariable.ttf` | SIL Open Font License 1.1 |
| Noto Serif KR (Latin subset) | `ios-app/Genita/Resources/NotoSerifKR-Regular-Latin.ttf` | SIL Open Font License 1.1 |

## Operating-system features (not AI models)

Sign in with Apple, ARKit, Apple Vision rectangle detection, Multipeer Connectivity, Core Bluetooth, and ScreenCaptureKit are Apple platform features. Genita does not ship or call any other AI model.

## Services

Meta API, Modal, Amazon Web Services, Resend, Apple (Sign in with Apple, TestFlight, notarization) and GitHub Pages are used under their own terms.

## Other assets

App sounds (`ios-app/Genita/Resources/GenitaHandoff*.caf`), the app icon, design assets and photographs keep their owners' rights. This notice does not grant a license to redistribute them.
