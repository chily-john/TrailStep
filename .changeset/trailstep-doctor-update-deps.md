---
"@trailstep/core": patch
"@trailstep/authoring": patch
"@trailstep/cli": patch
---

`authoring` and `cli` now declare an explicit peerDependency on `@trailstep/core`'s version. `core` gains a deprecation-manifest module (`deprecationManifest`, `findDeprecationsAsOf`) backing the new `trailstep doctor` and `trailstep update` CLI commands. `trailstep update` can now update TrailStep packages, registered workflow package dependencies, or both; it scans affected workflow sources for deprecations before writing, skips direct-file workflow registrations as package update targets, and requires manual install recovery if the package manager install fails.
