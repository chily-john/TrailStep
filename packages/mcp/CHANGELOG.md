# @trailstep/mcp

## 0.2.2

### Patch Changes

- Updated dependencies [805dbe9]
- Updated dependencies [69db9a9]
  - @trailstep/core@0.5.0

## 0.2.1

### Patch Changes

- a42b8b9: Lock `add-mcp` MCP registration to the resolved workflow scope and make the manual fallback robust. `trailstep init` and `trailstep add` now pass their resolved `--scope local|project|global` through to `offerMcpRegistration({ scope })`, so registration uses the same scope with no second WHERE prompt. Every manual fallback (`add-mcp` unresolvable, spawn failure, `ERR_TTY_INIT_FAILED`, or a declined local registration) now re-renders the printed `npx add-mcp` command with the resolved scope flags (`--gitignore` / `--global`) and the resolved server args. Headless `--yes` behavior is unchanged: no prompts, print the manual command, never spawn. `add-mcp` is promoted from a devDependency of `@trailstep/mcp` to a production dependency so published installs of `@trailstep/cli` can resolve the `add-mcp` bin entry (packaging trade-off: every `@trailstep/mcp` install now pulls in `add-mcp`; resolution walks cli -> `@trailstep/mcp` package root -> `add-mcp` and works even before `@trailstep/mcp`'s dist is built).

## 0.2.0

### Minor Changes

- 30edf9e: Per-workflow MCP tools with automatic generation and registration. Adding a workflow now generates `.trailstep/mcp/trst_<id>.json` (description plus input params from `defineWorkflow` input shape), refreshed on `trailstep update --workflows`; the MCP server publishes each workflow as its own tool by default, with `mcp.perWorkflowTools: false` falling back to a `trst_list` catalog alongside the generic `trst_run_workflow` / `trst_watch` / `trst_answer` / `trst_resume` toolkit. `trailstep init` and `trailstep add` auto-offer `add-mcp` registration of the `trailstep mcp` server (absolute `--project`, headless-safe manual fallback). The legacy `skill` field in `defineWorkflow` remains accepted for backwards compatibility.
- 4dba420: Robust MCP server as thin adapters over existing run/watch/answer/continue seams. The MCP package now runs a real Model Context Protocol server (low-level Server plus StdioServerTransport): `trst_run_workflow` returns real run ids immediately while the run continues detached in the background, `trst_watch` streams `events.jsonl` offsets with long-poll, `trst_answer` writes real wait files with branch disambiguation, and `trst_resume` continues runs; `trailstep://project` and `trailstep://instructions` resources included. `trailstep mcp --project <dir>` is the foreground server (no detached spawn, no stubs). Core `load-order` uses `os.homedir` with explicit project dir and local-over-project-over-global precedence, and the manifest working-provider timeout guard no longer throws when no timeout is set.

### Patch Changes

- Updated dependencies [30edf9e]
- Updated dependencies [4dba420]
  - @trailstep/core@0.4.0
