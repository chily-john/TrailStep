# @trailstep/mcp

## 0.3.0

### Minor Changes

- 65f6a96: Publish the MCP package with a declared public surface and complete npm
  metadata.
  
  The MCP package was published without an `exports` map, without `bugs` and
  `homepage` metadata, and without a `LICENSE` file in its tarball, and it was
  not covered by the repository's public-package checks - so none of that was
  caught before a release.
  
  - The package now declares its public entry point through `exports`, matching
    every other published TrailStep package. The `./package.json` subpath stays
    reachable, because the CLI resolves it to locate the `add-mcp` binary.
    BREAKING (minor, because the package is pre-1.0): deep imports such as
    `@trailstep/mcp/dist/tools/trst_watch.js` no longer resolve. Import from
    `@trailstep/mcp` instead.
  - The `bugs` and `homepage` metadata are now declared, and the tarball
    includes the `LICENSE` file the manifest already promised.
  - The package is now part of the public-package metadata check and the npm
    pack dry-run, so a packaging mistake fails CI instead of a release.
- 94788f4: Make the MCP server correct under real-world conditions.
  
  BREAKING (minor, because the package is pre-1.0): the legacy `run_workflow`
  module and the `runWorkflow` / `RunWorkflowResult` aliases were removed. Use
  `runWorkflowTool` and the `RunWorkflowToolOptions` / `RunWorkflowToolResult`
  types instead. The `run_workflow` TOOL itself is unchanged and still
  registered on the server.
  
  The MCP tools are thin adapters over the real CLI seams, and several of them
  were not correct:
  
  - `trst_watch` resolved runs under a hardcoded `<cwd>/.trailstep/runs` and
    ignored `TRAILSTEP_RUNS_ROOT`, so a run started under a custom runs root
    could not be watched by name. It now resolves the runs root the same way
    the rest of the system does.
  - `trst_run_workflow` reported `status: "started"` even when the background
    process never started. It now verifies that the run materialized and reports
    `status: "failed"` with an error when it did not.
  - The Windows path fallback spawned the CLI through `cmd.exe` with the
    `--input` JSON unquoted, which mangled the input. The fallback is now
    refused with a clear pointer to `TRAILSTEP_CLI_ENTRY`.
  - The watch cursor wrote its temp file to a path that collided between
    overlapping watch calls in one process, so two calls could clobber each
    other's cursor. The temp name is now unique per write.
  - `trst_resume` spawned the continue process without the caller's
    environment, so a caller-supplied `TRAILSTEP_RUNS_ROOT` or
    `TRAILSTEP_CLI_ENTRY` applied to resolution but not to the run.
  - `trst_answer` discarded the persisted-answer report when the follow-up
    continue failed. It now returns `persisted: true` together with the
    continue error, so the caller can tell the answer was saved.
- 51d35f5: Share the run-artifact helpers with the CLI instead of copying them.
  
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

### Patch Changes

- 94788f4: Make cancelled runs continuable and keep generated MCP tools in step with the
  workflows they describe.
  
  - A cancelled run can be continued again. The cancellation marker is consumed
    when the run is continued, so a cancelled run is no longer permanently
    unrunnable, and `trailstep cancel --clear` removes a pending cancellation
    without starting a run.
  - The CLI cancel command now creates events through the core helpers, so it
    emits conforming event ids and appends through the shared append path
    instead of a hand-rolled id and a raw append that could interleave with
    the live run. A cancelled run always reaches its terminal cancelled event.
  - `trailstep remove` now deletes the generated MCP tool JSON for the workflow
    it removes, and the MCP server skips per-workflow tool files whose workflow
    no longer resolves, so a removed workflow stops publishing a dead tool.
  - The MCP server reuses the core MCP config parsing instead of re-implementing
    it, which removes a source of drift between the two.
- 337eab6: Coerce stringified workflow input scalars and enrich the MCP tool descriptions.
  
  `@trailstep/core`: workflow input is now coerced against the workflow's own
  input schema before validation. A string that unambiguously matches the
  declared scalar type becomes that type -- a plain decimal becomes a `number`
  or `integer`, and exactly `true` / `false` becomes a `boolean` -- including in
  nested object properties and array items. Ambiguous strings (`"abc"`,
  `"25abc"`, `"1e5"`, `" 25 "`, `"yes"`) and schemas without a declared type are
  left untouched, so a genuinely invalid input still fails with the same
  `validation_failed` diagnostics. The coercion is opt-in at the workflow-input
  call site; the shared `jsonSchema()` / `assert()` validators used for agent
  step outputs and documents are unchanged. The coerced value is what the run
  persists, so a replayed or resumed run validates the same value.
  
  `@trailstep/mcp`: the `trst_run_workflow` description now says that a
  per-workflow tool (for example `trst_delegate` or `trst_take-it-away`) should
  be preferred when one exists, and the `trst_watch` description now says that
  the byte-offset cursor is persisted per run, that an unknown run id returns an
  error result instead of waiting, and how it pairs with `trst_run_workflow` and
  `trst_answer`. The server also sends `instructions` on initialize pointing at
  the `trailstep://instructions` resource.
  
  `@trailstep/sub-agents`: the delegate workflow descriptions (and the
  `delegateParallel` description) now say what the workflow does, what `mode`
  selects, that `maxTurns` bounds the number of turns, and that a delegate which
  needs a decision returns a question answered with `trst_answer` and continued
  with `trst_resume`. The generated per-workflow tool JSON takes its description
  from the workflow description, so the live tools pick this up. The shipped
  delegate skill files are built from `skillDescription` / `skillFocus` and are
  unchanged.
  
  `@trailstep/cli`: the pi MCP server description now points at the
  `trailstep://instructions` resource that documents the run -> watch -> answer
  -> resume loop.
  
  Behavior is otherwise preserved.
- Updated dependencies [3d3dc86]
- Updated dependencies [51d35f5]
- Updated dependencies [28e6560]
- Updated dependencies [3d3dc86]
- Updated dependencies [94788f4]
- Updated dependencies [51d35f5]
- Updated dependencies [337eab6]
- Updated dependencies [51d35f5]
- Updated dependencies [81a4942]
  - @trailstep/core@0.6.0

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
