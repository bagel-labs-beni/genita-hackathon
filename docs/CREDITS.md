# Credits and licenses

Part of the [Genita README](../README.md).

**Meta models.** Muse Spark 1.3, Muse Voice Transcribe, Muse Image 1.0 and SAM 3.1 through the Meta API, under the Meta API terms. SeamlessM4T v2, the MMS forced aligner and MMS-TTS (Meta AI, FAIR), CC-BY-NC-4.0. Details and links: [NOTICE.md](../NOTICE.md).

**Open source.**

| Component | Use | License |
| --- | --- | --- |
| Sparkle 2.10.0 | Mac app updates | MIT |
| Three.js 0.170.0 | Move effect bundle | MIT |
| esbuild 0.25.12 | Builds the move effect bundle | MIT |
| EffectSource | Move effect source | MIT, © 2026 Akash T ([license](../shared/Handoff/EffectSource/LICENSE)) |
| `pg`, `ws` | Postgres client, WebSocket server | MIT |
| PGlite (`@electric-sql/pglite`) | Local-mode Postgres | Apache-2.0 |
| TypeScript | Type checking | Apache-2.0 |
| PyTorch 2.6, torchaudio 2.6 | Voice service | BSD-style |
| Hugging Face Transformers 4.56.2 | Loads SeamlessM4T v2 and MMS-TTS | Apache-2.0 |
| CMU Pronouncing Dictionary | Word-to-phoneme lookup for mouth timing | BSD-style ([license](../genita-server/src/lips/dict/cmudict-LICENSE)) |
| SAM 3.1 mask wire format | [`meta/samMask.ts`](../genita-server/src/meta/samMask.ts) ports the decoder in Meta's `@meta-sam/parser` | SAM License (Meta Platforms, Inc.) |
| Pretendard, Noto Serif KR | App fonts | SIL Open Font License 1.1 |

**Services.** Meta API, Modal, AWS, Resend, Apple (Sign in with Apple, TestFlight, notarization), GitHub Pages.

**Data sources.** Web pages that Muse Spark finds and opens with its search tool during a call (recipes, products, answers); each card links its sources. Your own photo, imported profile text, camera frames and shared window, which you choose to give. No third-party dataset is bundled.

**License.** Our code is licensed under Apache-2.0 ([LICENSE](../LICENSE)). Models, libraries, fonts and services keep their own licenses, listed above and in [NOTICE.md](../NOTICE.md). Because the voice models are CC-BY-NC-4.0, any use of the voice service must be non-commercial.
