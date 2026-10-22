---
"@trailstep/core": minor
"@trailstep/cli": patch
---

Harden the remaining unguarded parses, swallowed promises and failure inspection.

- `@trailstep/core` now exports `isFailureLikeError` and `readFailureCode` from
  the failure contract, so consumers no longer hand-roll duplicate
  failure-shape checks.
- Step control and interactive agent execution no longer discard a detached
  promise rejection. Abort and cancellation rejections stay quiet, while an
  unexpected failure is reported (injectable via `onUnexpectedError`).
- `trailstep watch` reports and skips malformed or torn event lines instead of
  aborting the watcher.
