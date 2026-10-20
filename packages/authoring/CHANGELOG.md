# @trailstep/authoring

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
