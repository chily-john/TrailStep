# @trailstep/authoring

## 0.4.1

### Patch Changes

- 9fc5734: HARD-REMOVE the deprecated per-workflow generated-skills feature from the TrailStep CLI.
  
  Breaking changes:
  
  - `trailstep add` no longer accepts `--project-skill` or `--user-skill`; both flags are now rejected as unknown options.
  - Generated per-workflow skill files are no longer written during `trailstep add`.
  
  Migration:
  
  - Agents that should discover registered workflows use the TrailStep MCP server (`trst_*` tools) or the packaged TrailStep skills installed via `trailstep init --install-skill`.
  
  No changes for `trailstep init --install-skill`, `trailstep skill-check`, the packaged `trailstep-skill` / authoring-skill installs, or provider execution-time skill handling.
- Updated dependencies [9fc5734]
  - @trailstep/core@0.7.0

## 0.4.0

### Minor Changes

- 51d35f5: Share the remaining duplicated helpers.
  
  `@trailstep/authoring`: exports the canonical `nonEmptyOptional` and
  `nonEmptyOrDefault` string helpers (`packages/authoring/src/strings.ts`) so that
  workflow packages share one "trim, then drop empty" definition.
  
  `@trailstep/cli`: the six per-command `parseFlags` copies (`add`, `agents`,
  `init`, `mcp`, `providers`, `remove`) now share one shape-driven parser
  (`packages/cli/src/internals/command-framework/flags.ts`). Each command keeps
  parsing exactly what it parsed before — same accepted flags, same error
  messages, same empty-value and missing-value handling — and the shared
  `agent_targets_unavailable` guard now lives in one place
  (`packages/cli/src/internals/agent-config/agent-targets-error.ts`) used by both
  the `add` and `agents` commands.
  
  `@trailstep/create-flows`, `@trailstep/sub-agents`: the duplicated
  `nonEmptyOptional` helper is imported from `@trailstep/authoring`, and the
  worktree input subschema is declared once
  (`delegateWorktreeInputShape` in `packages/sub-agents/src/delegate/schema.ts`)
  and reused by the delegate and delegate-parallel input shapes.
  
  This is a behavior-preserving refactor: no public workflow shape, CLI flag
  behavior, or runtime behavior changed.

### Patch Changes

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

## 0.3.0

### Minor Changes

- 805dbe9: Add opt-in lean `execution` context (`AgentExecutionConfig`, `resolveAgentExecutionConfig`, `DEFAULT_AGENT_EXECUTION`) on agent steps and workflow roles, rendered through provider `hygiene` capability mappings into `{{tools}}`, `{{skills}}`, `{{mcpArgs}}`, `{{extensionsArgs}}`, and `{{contextFilesArgs}}` argv templates. Wire hygiene placeholders into all four provider manifests (pi, claude, codex, gemini), default every delegate workflow to the lean context, and document flag splitting plus the `project-only` collapse on CLIs without a dedicated project-only flag.

### Patch Changes

- 69db9a9: Retry transient working-agent spawn failures with exponential backoff instead of burning the agent target chain. Windows process-level deaths (e.g. `0xC0000142` `STATUS_DLL_INIT_FAILED`) and resource-exhausted spawn errors are now classified as transient: the format phase is retried in the same session (never re-running Phase 1 work) and failing targets are retried before falling back, with growing jittered delays (default 4 attempts, 2s base, x3, 60s cap) configurable via `settings.spawnRetry`. Failures are now visible the moment they happen: new `agent.attemptFailed` events, an incremental `attempts.json` audit trail per step, and captured spawn `stderr.txt` artifacts. Track state records `ownerPid` so runs left `running` by a dead runner are reported as orphaned instead of silently active.
- Updated dependencies [805dbe9]
- Updated dependencies [69db9a9]
  - @trailstep/core@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [30edf9e]
- Updated dependencies [4dba420]
  - @trailstep/core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [40871ed]
- Updated dependencies [40871ed]
- Updated dependencies [8e8bbe8]
  - @trailstep/core@0.3.0

## 0.2.0

### Minor Changes

- 4465267: Add callback/check `.wait(...)` phases with `wait.done(...)` and `wait.pending(...)` helpers, durable pending metadata, and continue-time polling.
- 432547d: Add ambient immutable workflow input helpers, CLI input flags/setters, input templates, and final output printing.
- f6013f5: Add ordered durable `.wait(...)` phases for manual input pauses, including wait artifacts, wait events, waiting workflow results, and CLI answer guidance.
- 796d814: Add the imperative `notify` authoring API with durable progress, warning, and artifact events rendered by the CLI.
- 763827d: Add ordered `.display(...)` runtime phases that emit durable `step.display` events and render in the CLI terminal logger.
- 71f0ffe: Add the parallel-track runtime: track-scoped `globalState` with atomic branch storage, branch lifecycle and cleanup, track retry filters, and post continuations backing parallel delegate fan-out.
- 64ba8ae: Add project/execution cwd separation for workflow runs and step-level cwd overrides.

### Patch Changes

- Updated dependencies [4465267]
- Updated dependencies [7c4875c]
- Updated dependencies [aecaf30]
- Updated dependencies [432547d]
- Updated dependencies [f6013f5]
- Updated dependencies [796d814]
- Updated dependencies [763827d]
- Updated dependencies [71f0ffe]
- Updated dependencies [05fcb88]
- Updated dependencies [db93d74]
- Updated dependencies [64ba8ae]
  - @trailstep/core@0.2.0

## 0.1.2

### Patch Changes

- f11b394: Improve README guidance for interactive setup and clearer workflow authoring examples.

## 0.1.1

### Patch Changes

- ba31526: Improve public README documentation, getting-started guidance, and npm package positioning.
- Updated dependencies [ba31526]
  - @trailstep/core@0.1.1
