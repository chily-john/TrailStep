---
"@trailstep/cli": patch
"@trailstep/core": patch
---

Fix Windows npm-shim spawning and bare `trailstep add` specs: working/custom/interactive provider commands and Pi model discovery now resolve `.cmd` shims to their Node entrypoint under `shell: false` (no-op on other platforms); bare npm specs like `@trailstep/create-flows` default to `@latest`, reusing the installed bundle when already present.
