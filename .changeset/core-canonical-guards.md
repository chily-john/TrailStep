---
"@trailstep/core": minor
---

Add canonical shared guards and the TrailStep directory-name constant.

`@trailstep/core` now exports `isRecord`, `isPlainObject`, `isNodeError` and
`errorMessage` from a single canonical module (`packages/core/src/json/guards.ts`)
plus the `TRAILSTEP_DIR_NAME` constant (`.trailstep`) from the run-storage
module. The package internals were de-duplicated to use these exports instead
of the previously duplicated local helper copies, and the scattered `.trailstep`
path literals now use the shared constant. This is a behavior-preserving
refactor: the strict "plain object" definition (object, not `null`, prototype
`Object.prototype` or `null`) is now the single canonical one.
