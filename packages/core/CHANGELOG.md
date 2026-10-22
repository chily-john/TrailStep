# @trailstep/core

## 0.6.0

### Minor Changes

- 51d35f5: Complete the cancellation lifecycle: the cancel marker is a pending request, not
  a record.
  
  - The runtime consumes the cancel marker when it honours a cancellation. A run
    that ends cancelled no longer leaves a `cancel.json` behind, so a later
    cancel, continue, or retry can tell "requested but not yet acted on" from
    "already honoured and the run is over". The event trail
    (`workflow.cancelRequested` + `workflow.cancelled`) remains the record.
  - A cancelled run can be retried. `trailstep retry <workflow-ref> <run>` on a
    cancelled run consumes the pending cancellation and re-executes the step the
    cancellation interrupted instead of failing with "no latest unresolved
    failure". The retry reports its target through a `workflow.retryStarted` event
    that carries the cancelled step and the cancellation event it replaces.
  - `trailstep retry` clears a pending cancellation for the run it targets, the
    same way `trailstep continue` does, and reports waiting and cancelled retry
    results instead of treating them as failures.
  - `trailstep cancel` reports the run's real terminal status: a failed run is
    reported as already failed (not already completed), and a stale marker left
    behind by an already honoured cancellation never turns an already cancelled
    run back into a "cancellation requested" report.
- 3d3dc86: Add canonical shared guards and the TrailStep directory-name constant.
  
  `@trailstep/core` now exports `isRecord`, `isPlainObject`, `isNodeError` and
  `errorMessage` from a single canonical module (`packages/core/src/json/guards.ts`)
  plus the `TRAILSTEP_DIR_NAME` constant (`.trailstep`) from the run-storage
  module. The package internals were de-duplicated to use these exports instead
  of the previously duplicated local helper copies, and the scattered `.trailstep`
  path literals now use the shared constant. This is a behavior-preserving
  refactor: the strict "plain object" definition (object, not `null`, prototype
  `Object.prototype` or `null`) is now the single canonical one.
- 94788f4: Make run artifacts durable under concurrent access.
  
  BREAKING (minor, because the package is pre-1.0): the `deferEngineInit`
  export was removed. It was a no-op that was never called; use the runtime's
  own initialization instead.
  
  - Run state, global state, branch state and track artifacts are now written
    atomically (temp file in the same directory plus a rename), so a reader
    never observes a partially written document. The CLI wait-answer write
    used by `trailstep answer` is atomic in the same way.
  - A replace-rename on Windows fails with `EPERM` while another process holds
    the target open. The runtime's own wait poller and the dashboard both read
    the answer file while it is being written, so a concurrent reader could
    turn the write into a hard failure. The rename now retries with a longer
    bounded backoff.
  - The queued run-state and global-state writes no longer swallow a
    persistence failure. Each failure surfaces exactly once to the caller that
    triggered it, a failed read is retried instead of poisoning the queue, and
    a reporting failure can no longer deadlock the queue.
  - The vestigial `deferEngineInit` export and the legacy MCP `run_workflow`
    re-export were removed.
- 51d35f5: Harden the remaining unguarded parses, swallowed promises and failure inspection.
  
  - `@trailstep/core` now exports `isFailureLikeError` and `readFailureCode` from
    the failure contract, so consumers no longer hand-roll duplicate
    failure-shape checks.
  - Step control and interactive agent execution no longer discard a detached
    promise rejection. Abort and cancellation rejections stay quiet, while an
    unexpected failure is reported (injectable via `onUnexpectedError`).
  - `trailstep watch` reports and skips malformed or torn event lines instead of
    aborting the watcher.
- 81a4942: Make automatic step retry transient-only.
  
  Automatic step retry now re-runs a step only when its failure is classified as
  transient (`step_timeout`, `agent_provider_unavailable`, `agent_provider_failed`,
  `agent_provider_spawn_error`, `agent_provider_timeout`, or a failure explicitly
  marked retryable). Every other failure — including new failure codes that are
  not on the transient allowlist — is permanent and fails on the first attempt
  with the same event trail as before. A `step.attemptFailed` event is emitted
  only when a retry actually follows.
  
  The retry policy gains an optional `retryOn?: "transient" | "always"` setting
  (step > workflow > global, default `"transient"`) so a step, workflow, or
  global configuration can opt into retrying every failure.

### Patch Changes

- 3d3dc86: Break the import cycles in the authoring, provider-catalog and CLI registry
  layers.
  
  `@trailstep/core` now keeps mutually recursive type declarations in a single
  leaf module each — the agent step request config moved next to the agent
  adapter contract (`contracts/agents/agent-adapter.types.ts`), the workflow
  invocation node moved next to the `Workflow` contract
  (`authoring/workflow/workflow.types.ts`), and the durable run `Event` and the
  interactive process contract moved into `contracts/events/event.types.ts` and
  `contracts/process/interactive-process.types.ts`. `@trailstep/cli` extracts the
  shared registry vocabulary into
  `internals/workflow-registry/workflow-registry.types.ts` and the path-shaped
  reference check into `internals/workflow-reference/direct-file-reference.ts`,
  so the workflow registry and workflow resolution modules no longer import each
  other. This is a behavior-preserving refactor: the public API of both packages
  is unchanged and no runtime behavior changed.
- 28e6560: Agents now load the project's context files by default, and the user can
  control the whole execution (hygiene) block from the TrailStep config.
  
  `@trailstep/core` changes the default execution block from
  `contextFiles: "project-only"` to `contextFiles: true`. `"project-only"` was
  misleading on every provider CLI that has no project-only flag: `pi
  --no-context-files` disables AGENTS.md/CLAUDE.md discovery entirely, so the
  value that claimed to restrict context to the project actually removed it. An
  agent with an execution block now loads the project's context files unless it
  opts out, and the value stays available for providers that do offer a
  project-only flag.
  
  `@trailstep/core` also adds `settings.execution` to the TrailStep config, both
  globally (`settings.execution`) and per workflow
  (`workflows.<id>.settings.execution`). The block has the same shape as
  `AgentExecutionConfig` (`tools`, `skills`, `mcp`, `extensions`, `contextFiles`)
  and is merged field by field with the agent role's own block: step execution >
  per-workflow config > global config > role, per field. A config block that
  names only `contextFiles` therefore changes only that field and leaves the
  role's other fields alone; an explicit `false` or `[]` overrides a
  lower-precedence value. An invalid config block fails fast with a
  config-scoped diagnostic before any provider process is spawned, and no block
  anywhere still means "render no hygiene args at all".
  
  `@trailstep/sub-agents` no longer pins `contextFiles` in the delegate's lean
  execution block, so a delegate turn inherits the framework default and reads
  the repository's own `AGENTS.md` / `CLAUDE.md` instead of disabling context
  discovery. The rest of the lean block is unchanged: `--no-skills`, `--no-mcp`
  and `--no-extensions` are still rendered, and all tools stay available.
  
  Behavior is otherwise preserved.
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
- 51d35f5: Split the remaining large modules into focused ones, and align the CLI's
  official-provider capability metadata with the provider package manifests.
  
  `@trailstep/core` splits the resume replay
  (`runtime/resume/replay-to-waiting-step/`) into the replay entry point, the
  wait-event helpers, and the waiting-step phase prefix replay. The resume
  behavior and the emitted event trail are unchanged.
  
  `@trailstep/cli` splits `commands/update/update-command.ts`,
  `internals/mcp-tools/mcp-registration.ts` and
  `commands/agents/agents-setup-wizard.ts` into focused modules (preflight
  scanning, recommended config, dependency install, MCP server command, agent
  target detection, add-mcp request, manual fallback text, scope prompts, named
  agent flow, workflow role flow). The public behavior, prompts and help output
  are unchanged.
  
  The provider package manifest is the single source of truth for a provider
  CLI's capabilities. The CLI's `officialProviderSpecFor()` table now mirrors it
  (model support, model discovery, thinking support and thinking levels), the Pi
  provider manifest declares its `pi --list-models` discovery spec, and a new
  `official-providers` test pins the agreement between the CLI table and the
  `@trailstep/provider-*` manifests.

## 0.5.0

### Minor Changes

- 805dbe9: Add opt-in lean `execution` context (`AgentExecutionConfig`, `resolveAgentExecutionConfig`, `DEFAULT_AGENT_EXECUTION`) on agent steps and workflow roles, rendered through provider `hygiene` capability mappings into `{{tools}}`, `{{skills}}`, `{{mcpArgs}}`, `{{extensionsArgs}}`, and `{{contextFilesArgs}}` argv templates. Wire hygiene placeholders into all four provider manifests (pi, claude, codex, gemini), default every delegate workflow to the lean context, and document flag splitting plus the `project-only` collapse on CLIs without a dedicated project-only flag.
- 69db9a9: Retry transient working-agent spawn failures with exponential backoff instead of burning the agent target chain. Windows process-level deaths (e.g. `0xC0000142` `STATUS_DLL_INIT_FAILED`) and resource-exhausted spawn errors are now classified as transient: the format phase is retried in the same session (never re-running Phase 1 work) and failing targets are retried before falling back, with growing jittered delays (default 4 attempts, 2s base, x3, 60s cap) configurable via `settings.spawnRetry`. Failures are now visible the moment they happen: new `agent.attemptFailed` events, an incremental `attempts.json` audit trail per step, and captured spawn `stderr.txt` artifacts. Track state records `ownerPid` so runs left `running` by a dead runner are reported as orphaned instead of silently active.

## 0.4.0

### Minor Changes

- 30edf9e: Per-workflow MCP tools with automatic generation and registration. Adding a workflow now generates `.trailstep/mcp/trst_<id>.json` (description plus input params from `defineWorkflow` input shape), refreshed on `trailstep update --workflows`; the MCP server publishes each workflow as its own tool by default, with `mcp.perWorkflowTools: false` falling back to a `trst_list` catalog alongside the generic `trst_run_workflow` / `trst_watch` / `trst_answer` / `trst_resume` toolkit. `trailstep init` and `trailstep add` auto-offer `add-mcp` registration of the `trailstep mcp` server (absolute `--project`, headless-safe manual fallback). The legacy `skill` field in `defineWorkflow` remains accepted for backwards compatibility.

### Patch Changes

- 4dba420: Robust MCP server as thin adapters over existing run/watch/answer/continue seams. The MCP package now runs a real Model Context Protocol server (low-level Server plus StdioServerTransport): `trst_run_workflow` returns real run ids immediately while the run continues detached in the background, `trst_watch` streams `events.jsonl` offsets with long-poll, `trst_answer` writes real wait files with branch disambiguation, and `trst_resume` continues runs; `trailstep://project` and `trailstep://instructions` resources included. `trailstep mcp --project <dir>` is the foreground server (no detached spawn, no stubs). Core `load-order` uses `os.homedir` with explicit project dir and local-over-project-over-global precedence, and the manifest working-provider timeout guard no longer throws when no timeout is set.

## 0.3.0

### Minor Changes

- 40871ed: Branch-scoped parallel wait-continue (Gaps 3+4) with branch-keyed parallel waits (Gaps 1+2).
  
  Gaps 1+2 (c0d78f5): decorateBranchEvent decorates wait.started/satisfied/failed with branchId+stepIndex on split tracks; waitEventKey/findPendingWaitsById/waitEventBranchId branch-aware with root fallback; trailstep answer accepts --branch and errors on ambiguous bare answers.
  
  Gaps 3+4 (594ac0b): replayToWaitingStep extended with optional branch scope {branchId, stepIndex} and readBranchRunState hydration; run-workflow.ts isWaitContinue replaces blanket guard with routing — resumes every waiting branch having recorded answer.json through root-continuation-array-scheduler restore (mirror retry path ~L971, never rebuild); unanswered branches stay waiting; done/failed/cancelled siblings never re-execute; CLI command.types.ts usageText documents --branch.
  
  Verification: core 389 tests pass; new co-located tests added; full E2E verified (delegate v4); regression verified clean (non-parallel paths unchanged); build green.
- 40871ed: Delegate skill descriptions updated to more direct/aggressive language; core working-agent prompts switched to two-phase architecture (work without output shape, then same-session format/reformat with output schema).
  
  Sub-agents (`packages/sub-agents/src/delegate/workflow.ts` + `delegate-parallel/workflow.ts`): all delegate skill descriptions (`delegate`, `delegateExplore`, `delegateSimpleExplore`, `delegateArchitectPlanner`, `delegateReview`, `delegateImplement`, `delegateQuickImplementor`, `delegateSmartImplementor`, `delegateRelentlessDebugger`, `delegateSchemaFormatter`, `delegateParallel`) rewritten from passive "Use as a sub-agent for..." to directive/conditional "Use when you need..." / "Read-only exploration that summarizes findings without editing files." / "When instructions are already concrete..." etc. Skill descriptions and skill focus fields now include explicit parallel recommendations ("If you have 2+ independent tasks, use trst-delegate-parallel instead of calling this sequentially.").
  
  Core (`packages/core/src/agent-execution/working-agent/prompts/build-two-phase-prompts.ts` + artifacts + tests): new two-phase working-agent prompt architecture. Phase 1 (`buildWorkPrompt`) embeds the original prompt with zero mention of output files, JSON, or schemas — avoiding the long-turn domain-JSON problem. Phase 2 (`buildFormatPrompt`) is a pinned same-session follow-up that asks the agent to reformat its last answer to exactly one JSON object matching the strict output schema; includes validation error feedback when needed. New artifact paths: `workFile` (`work.txt`) and `repairPromptFile` (`repair-prompt.md`). Tests verify that work prompts contain the original prompt but no JSON/schema references, and format prompts include the stringified schema, require a single JSON object, and omit validation sections when no errors exist.

### Patch Changes

- 8e8bbe8: Fix Windows npm-shim spawning and bare `trailstep add` specs: working/custom/interactive provider commands and Pi model discovery now resolve `.cmd` shims to their Node entrypoint under `shell: false` (no-op on other platforms); bare npm specs like `@trailstep/create-flows` default to `@latest`, reusing the installed bundle when already present.

## 0.2.0

### Minor Changes

- 4465267: Add callback/check `.wait(...)` phases with `wait.done(...)` and `wait.pending(...)` helpers, durable pending metadata, and continue-time polling.
- aecaf30: Add durable workflow cancellation with `trailstep cancel <runNameOrRunDir>` and cancelled runtime results/events.
- 432547d: Add ambient immutable workflow input helpers, CLI input flags/setters, input templates, and final output printing.
- f6013f5: Add ordered durable `.wait(...)` phases for manual input pauses, including wait artifacts, wait events, waiting workflow results, and CLI answer guidance.
- 796d814: Add the imperative `notify` authoring API with durable progress, warning, and artifact events rendered by the CLI.
- 763827d: Add ordered `.display(...)` runtime phases that emit durable `step.display` events and render in the CLI terminal logger.
- 71f0ffe: Add the parallel-track runtime: track-scoped `globalState` with atomic branch storage, branch lifecycle and cleanup, track retry filters, and post continuations backing parallel delegate fan-out.
- 05fcb88: Publish provider-agnostic runtime support, provider package registration flows, and official provider packages.
- db93d74: Align the shared agent pool across packages (`planner`, `explorer`, `quick-implementor`, `smart-implementor`, `debugger`, `reviewer`, `expert`, `formatter`, plus `generalist` with demanding-model fallback), extend `trailstep agents explain` to workflow routing (`namespace/name`), re-apply missing package `recommendedConfig` additively on `trailstep update` (never overwriting user values), surface `trailstep doctor` drift warnings, and emit a compact agent routing progress note for working-agent steps.
- 64ba8ae: Add project/execution cwd separation for workflow runs and step-level cwd overrides.

### Patch Changes

- 7c4875c: Resolve workflow agent roles from top-level agents with matching role names before falling back to size/default mappings.

## 0.1.1

### Patch Changes

- ba31526: Improve public README documentation, getting-started guidance, and npm package positioning.
