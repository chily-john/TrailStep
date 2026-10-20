---
"@trailstep/create-flows": patch
---

Fix `take-it-away` workflow tests that omitted `cwd` on retry `runWorkflow` calls, which made the story auto-commit step run `git add -A` and commit against the ambient repository instead of the test's temporary repo. The retry tests are now scoped to their temp working directory.
