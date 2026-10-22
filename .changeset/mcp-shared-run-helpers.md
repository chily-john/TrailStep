---
"@trailstep/mcp": minor
---

Share the run-artifact helpers with the CLI instead of copying them.

The MCP package cannot import the CLI package - the CLI already depends on the
MCP package, so that would be a dependency cycle - which is why the shared
helpers had been duplicated. They now live in `@trailstep/core`, next to the
run-artifact layout they describe, and both the CLI and the MCP package use
them.

- The MCP package no longer carries its own copy of the wait-file helpers.
- Wait-answer writes go through the shared atomic write, so an answer file is
  never observed half-written.
- Run-name generation is unified. The CLI and the MCP now derive the same run
  name for the same workflow. Two visible differences remain, both noted
  because they change a name a caller sees:
  - a bundle reference (`pkg#workflow`) started through the MCP tool now
    yields `workflow-<timestamp>-<suffix>`, where the reference's export name
    is used rather than the whole `pkg-workflow` string;
  - for a direct file reference the MCP tool uses the file name, while the
    CLI uses the workflow's declared id. These differ only when a workflow
    file's name is not its declared id.
- The two divergent CLI-entry resolvers in the MCP package (one reading
  `process.argv`, one walking up `node_modules`) are now one module with one
  resolution strategy. The Windows path fallback refusal is preserved.
