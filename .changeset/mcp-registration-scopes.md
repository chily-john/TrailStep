---
"@trailstep/cli": minor
---

Added registration scope selection (project/local/global) to the MCP add-mcp offer. Interactive registration now asks where the MCP server entry should live after the register confirm: project (committed, default), local (project file appended to .gitignore with a preview before confirming), or global (user-level config, with a note that the entry still serves only the pinned project). Headless runs default to project scope and print the manual fallback without prompting. Scope flags are included in the rendered manual `npx add-mcp` command.
