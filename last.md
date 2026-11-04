DONE: b8f94f28 PR #691

- Red on exact `origin/main` archive: D95 test failed because stored insights contained `usually asks for two or three options`.
- Green: `npx tsc --noEmit` passed.
- Green: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test test/insights*.test.ts test/personalize*.test.ts test/prep-routes.test.ts` passed (141/141).
