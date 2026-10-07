---
"@trailstep/cli": patch
---

Fix silent exit when CLI binary is invoked through symlinks or hard links (e.g., workspace-linked global install). The `import.meta.url` vs `process.argv[1]` path comparison failed for linked paths, so `main()` was never called. Compare filenames (`index.js`) instead of full paths.
