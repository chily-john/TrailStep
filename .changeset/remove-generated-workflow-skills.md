---
"@trailstep/cli": minor
"@trailstep/authoring": patch
"@trailstep/create-flows": patch
"@trailstep/sub-agents": patch
---

HARD-REMOVE the deprecated per-workflow generated-skills feature from the TrailStep CLI.

Breaking changes:

- `trailstep add` no longer accepts `--project-skill` or `--user-skill`; both flags are now rejected as unknown options.
- Generated per-workflow skill files are no longer written during `trailstep add`.

Migration:

- Agents that should discover registered workflows use the TrailStep MCP server (`trst_*` tools) or the packaged TrailStep skills installed via `trailstep init --install-skill`.

No changes for `trailstep init --install-skill`, `trailstep skill-check`, the packaged `trailstep-skill` / authoring-skill installs, or provider execution-time skill handling.
