---
"@trailstep/cli": minor
---

Split MCP server registration per scope: project/local registrations keep the `trailstep` server name with a pinned `mcp --project <absolute dir>` command, while global registrations now use the distinct `trailstep-global` server name and omit `--project` so the server follows the agent client's current project (layered project tools plus global `~/.trailstep` tools). Global manual and spawn argv now include `--global` and reflect the omitted `--project`, and the manual fallback command is rendered with the resolved scope's flags and server name when add-mcp cannot be resolved.