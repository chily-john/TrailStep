---
"@trailstep/cli": patch
---

Fix the global `trailstep` command silently doing nothing (exiting 0 with no output) when the bin shim is installed as a symlink; resolve the invoked script path before the CLI entry guard runs. Also resolves the CLI entry path used for spawned MCP server launches through symlinks.
