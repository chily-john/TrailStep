# @trailstep/core

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
