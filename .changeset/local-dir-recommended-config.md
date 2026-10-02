---
"@trailstep/cli": patch
---

Fix `trailstep add` silently skipping `trailstep.recommendedConfig` for local directory package sources (such as `./packages/sub-agents`); agent pools and workflow role mappings are now applied additively, matching npm-backed adds.
