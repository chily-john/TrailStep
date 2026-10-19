---
"@trailstep/cli": minor
---

Extend `trailstep update --project` / `--all` self-update scope to include `@trailstep/mcp` and provider packages (`@trailstep/provider-claude`, `@trailstep/provider-codex`, `@trailstep/provider-gemini`, `@trailstep/provider-pi`) when present in `package.json`. Peer-compatible resolution against latest stable `@trailstep/core` matches the existing authoring/cli pattern; packages without a core peer fall back to latest stable. Absent packages are ignored, and authoring/cli compatibility is now only required when installed.
