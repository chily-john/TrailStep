---
"@stepkit/core": patch
"@stepkit/sdk": patch
"@stepkit/cli": patch
---

`sdk` and `cli` now declare an explicit peerDependency on `@stepkit/core`'s version. `core` gains a deprecation-manifest module (`deprecationManifest`, `findDeprecationsAsOf`) backing the new `stepkit doctor` and `stepkit update` CLI commands.
