---
"@stepkit/core": patch
"@stepkit/sdk": patch
"@stepkit/cli": patch
---

`sdk` and `cli` now declare an explicit peerDependency on `@stepkit/core`'s version. `core` gains a deprecation-manifest module (`deprecationManifest`, `findDeprecationsAsOf`) backing the new `stepkit doctor` and `stepkit update` CLI commands. `stepkit update` can now update StepKit packages, registered workflow package dependencies, or both; it scans affected workflow sources for deprecations before writing, skips direct-file workflow registrations as package update targets, and requires manual install recovery if the package manager install fails.
