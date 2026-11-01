# @trailstep/core

## 0.9.0

### Minor Changes

- 167b58e: Add a per-run execution lock and make process death observable.
  
  - New `run.lock` artifact (`acquireRunLock` / `releaseRunLock` / `readRunLock` / `isRunLockLive`, exported from `@trailstep/core`) guarantees only one process drives a run directory. Liveness is decided by pid, so a lock left behind by a SIGKILL, OOM or power loss is broken automatically instead of bricking the run. The lock is released on every exit path including `waiting`, so a later `continue` can resume.
  - `runWorkflow` now fails with `run_already_active` instead of executing a second concurrent driver over the same `events.jsonl`, `state.json` and agent artifacts. This is what previously happened when an MCP client retried a `trst_resume` whose blocking continue had outlived the transport timeout.
  - `failWorkflow` and `cancelWorkflow` tolerate an event-append failure, so the real failure always reaches the caller instead of being replaced by a persistence error.
  - The CLI bin now attaches `unhandledRejection` / `uncaughtException` handlers and a `.catch()` on `main()`. Previously an unexpected rejection killed the process silently, leaving the event trail with no terminal event and every observer reporting "in progress" forever.
- 167b58e: Make agent heartbeats report real liveness and add an opt-in stall timeout.
  
  - `step.progress` heartbeats now report wall-clock elapsed time plus `outputBytes`, `msSinceLastOutput`, `pid` and `exited` from a shared `AgentProgressTracker`, instead of a self-incremented counter that looked healthy while a provider CLI was wedged. Existing `data.heartbeat` / `data.elapsedMs` keys are unchanged.
  - New `agent.stalled` event (emitted at most once per attempt) when a configured `stallTimeout` elapses with no child output and no exit.
  - New opt-in `stallTimeout` setting, resolvable at global / workflow / step scope with step > workflow > global precedence and validated like `timeout`. There is deliberately no built-in default: existing workflows are unaffected.
  - The stall timeout only observes and reports in this release. It does not abort the attempt; `onStall` is the hook a future change can wire to termination.

### Patch Changes

- 167b58e: Terminate agent child processes reliably before continuing.
  
  - New shared `terminateChildProcessTree` (awaited everywhere it is used) replaces three divergent fire-and-forget copies. On Windows the `taskkill /T /F` child is awaited; on POSIX the process group gets `SIGTERM` and is escalated to `SIGKILL` after a grace period. Previously a timed-out step rejected immediately and the replacement agent could start while the previous one was still running, so both wrote `output.json` and the step failed with an unretryable `agent_output_invalid_json`.
  - All agent child processes are tracked in a live-children registry and killed from a `process.once("exit")` hook, so a killed or crashed runner no longer orphans agents against an abandoned run directory.
  - Timeout paths wait (bounded) for the child to exit before throwing, so the caller's next action never races a live process.
  - `AgentAdapter` requests gain an optional `AbortSignal`, and `submit_output` results are now recorded per round instead of into one shared variable. A slow first round can no longer satisfy the second round's structured-output request. No default adapter timeout is introduced.
- 167b58e: Make global / project / local config scopes actually compose.
  
  - Config scopes now deep-merge with a single `mergeConfigScopes` implementation. Previously only `agents` was deep-merged, so a project `settings.timeout` deleted a global `settings.retry`, and a local `workflows.<id>.agents.<role>` deleted every other role for that workflow in the project and global scopes. Arrays still replace wholesale; `undefined` never overrides; `null` deliberately clears.
  - `trailstep agents <workflow>` now uses the same merge as the runtime. It previously used a third, deeper merge and would list roles the runtime would never see, which made configuration bugs very hard to diagnose. The output also gains a `Sources:` block naming which scope supplied each configured entry, and a new test asserts the display and `resolveAgentTargets` agree.
  - One malformed config file no longer breaks every command. A global or project config that cannot be read or parsed is reported through `configErrors` (and on stderr by `run`, `continue` and `retry`) instead of throwing, so the remaining scopes still apply.
  - The workflow registry is read through the same loader as the rest of the config, instead of a second, independently merged user-registry path. `workflowRegistry` is the canonical key; the legacy `workflows` string leaves that `trailstep add` still writes keep resolving for one release.
  - New project-root discovery (`resolveProjectRoot`): `TRAILSTEP_PROJECT_ROOT` if set, else the invocation directory when it already has a `.trailstep` directory, else the nearest ancestor with `.git`, else the nearest ancestor with `package.json`, else the invocation directory. `run`, `continue` and `retry` resolve config, the workflow registry and run artifacts at that root while agents keep running in the invocation directory. Running a workflow from a nested directory previously created a second `.trailstep/` tree there and silently ignored the project's config and runs root. **If you have stray `.trailstep/` directories in subdirectories, delete or move them.**
- 167b58e: Make the run event trail crash-tolerant and stop ignoring project config.
  
  - `readRunEvents` now skips and reports malformed or non-event-shaped JSONL lines instead of throwing. A torn line from a crash mid-append previously made a run permanently unresumable, uncontinuable and unretriable; recovery now replays the rest of the trail. Accepts an optional `{ report }` callback.
  - `appendEvent` serializes appends per `events.jsonl` in-process, so parallel branches, the agent heartbeat and the CLI cancel command can no longer interleave into a torn line.
  - Removes the unused `persistEvents`, which rewrote the whole trail with a non-atomic `writeFile`.
  - The generated `.trailstep/.gitignore` now lists run artifacts (`runs/`, `.archive/`, `sessions/`, `worktrees/`, `tmp/`, `inputs/`, `mcp/`, `config-local.json`, `run.lock`, `*.tmp`) instead of a blanket `*`. The previous body ignored `.trailstep/config.json`, so a fresh project silently failed to commit its shared config. A legacy generated file is repaired in place; a hand-edited one is never rewritten.
- 167b58e: Make MCP tools bounded, truthful, and crash-aware.
  
  - `trst_resume` no longer blocks for the whole continue. It spawns `trailstep continue` detached, waits only for bounded evidence that the continue began, and returns `{ resumed: true, status, background: true }`. Previously it awaited a multi-minute continue inside the MCP request, past the client's transport timeout, so a retrying agent started a **second** continue process on the same run directory — the concrete cause of the reported "1 in 5 runs hang" behaviour.
  - `trst_resume` derives `status` from the run's parsed event trail (`completed` / `waiting` / `cancelled` / `failed` / `running`) instead of substring-matching human-readable CLI output, which degraded silently on any wording change.
  - `trst_answer` with `continueAfterAnswer: true` now returns an `isError` tool result when the continue failed, instead of a success payload that left the calling agent watching a run that could not progress.
  - `trst_watch` gains a `crashed` state: no terminal event and no live holder of the run lock means nothing will ever append one, so an orchestrating agent can stop waiting. State is now classified from parsed events and the run lock rather than a regex over raw file text, which could match event-shaped text embedded in agent output. Runs parked on a durable wait correctly remain `in-progress`.
  - `readRunEventsSince` short-circuits when the trail has not grown. `trst_watch` previously re-read and re-decoded the entire `events.jsonl` every 50 ms, which was ~5 GB of reads per 25 s long-poll on a 10 MB trail and grew linearly with run length.
  - `trst_run_workflow` resolves the run directory the CLI actually created instead of predicting it, so a run-name collision no longer reports `started` against a stale directory from an earlier run.
- 167b58e: Harden the parallel scheduler and retry classification.
  
  - The continuation-array scheduler no longer swallows a thrown branch. Previously a `persistBranch` or runtime failure rejected a non-awaited promise chain after the outer promise may already have resolved, which could report a track as completed while a branch had actually failed. A thrown branch now produces a `branch_failed` terminal result and still unblocks the scheduler's worker accounting; a thrown error that already carries a structured failure (such as the scheduler's own step-budget guard) keeps that code instead of being flattened.
  - The `maxSteps` guard throws `TrailStepFailureError` with code `max_steps_exceeded` and structured details instead of a bare `Error` that surfaced as `step_execution_failed`.
  - `step.attemptFailed` now reports `agentDispatches`, the cumulative number of provider dispatches a step has caused, making retry amplification (step retries × fallback targets × format attempts × spawn retries) visible. No cap is imposed and no retry default changed: the format-phase budget stays at 3 attempts, and measuring amplification before bounding it is deliberate — a cap chosen without data would either be useless or break legitimate long-running retries.
  - Five output-corruption codes (`agent_output_invalid_json`, `agent_output_unreadable`, `agent_provider_output_invalid`, `interactive_output_invalid`, `interactive_output_incomplete`) are now retryable under the default `retryOn: "transient"`. They are frequently caused by a race (truncated write, competing writer) rather than a deterministic schema violation, and a genuine schema violation still fails on the retry. `validation_failed`, `agent_target_exhausted` and every unknown code remain permanent.
  - Resume-integrity failures now use structured failure codes (`resume_replay_invalid_phase_order`, `resume_replay_missing_step_output`, `resume_replay_missing_do_phase`) with an actionable `details.hint`, instead of bare developer-facing `Error` messages.
- 167b58e: Fix Windows provider spawns and make JSON extraction brace-safe.
  
  - `resolveCliCommandForSpawn` now reads the Node entrypoint out of pnpm-generated `.cmd` shims (`"%~dp0\..\pkg\cli.js" %*`), not just npm's (`"%dp0%\..\pkg\cli.js" %*`). pnpm shims previously fell through to `cmd.exe /c`, which re-parses the argument list, so any prompt containing `&`, `|`, `<`, `>`, `^`, `%` or `!` was reinterpreted by the shell. The failure was content-dependent and looked intermittent.
  - A `.cmd` shim whose entrypoint cannot be resolved now throws a clear error instead of silently launching through `cmd.exe`. Provider CLIs must be resolvable to a Node entrypoint; the `--project`/prompt argv is never handed to a shell.
  - New `extractJsonObject` in `@trailstep/core` extracts the first balanced JSON object using a real scanner that tracks string literals and escapes and tries ```json fenced blocks first. It replaces the previous "slice from the first `{` to the last `}`" logic in both the envelope parser and the manifest output writer, which produced unparseable output whenever model prose contained an extra brace.
  - `extractEnvelopeText` (raw-text capture mode) continues to return the agent's answer verbatim and deliberately does not use the extractor.

## 0.8.0

### Minor Changes

- cf75cb1: Enable durable continue and retry for answered parallel-track waits.
  
  - `runWorkflow` continue on a run whose root start is a parallel track now resolves answered parallel branches via persisted branch answers (`findAnsweredParallelBranches`, now exported from `@trailstep/core`); with no answered branch yet it re-parks on the pending wait instead of failing, and with an answered branch it resumes that branch through branch-scoped replay.
  - Check waits are self-evaluating: a continue with no answered branch but a pending `check` wait resumes that branch so the check re-runs, while input waits park answer-less on the pending wait.
  - Branch-scoped wait resumes resolve the waiting step node out of the workflow start continuation tree (parallel nodes, continuation arrays, derived branch ids, invoked-workflow branches) and replay from that node (`ResumeWaitOptions.startNode`, `replayCompletedSteps({ startNode })`); the first answered branch replay is reused for the `workflow.resumed` emit instead of replaying twice, and a branch-scoped replay failure surfaces as resume validation instead of being silently skipped.
  - A branch parking into `waiting` no longer cancels its sibling branches on the same track (parallel-track and root-continuation-array schedulers), so multiple branches can hold durable waits concurrently.
  - `findLatestPendingWait` is branch-aware (`findLatestPendingWait(events, branchId)`); events without a branch belong to the implicit root branch.
  - `trailstep continue` (and `answer --continue`) gates on answered parallel branches first, mirroring the runtime: once a split-track branch has its answer artifact, continue resumes it instead of gating on the latest pending wait's missing answer.
  
  Also removes the deprecated `@trailstep/authoring` `defineWorkflowOriginal` re-export shim (the authoring package now re-exports `defineWorkflow` from `@trailstep/core` directly).
- cf75cb1: Share durable run-event readers and canonical JSON guards across core, CLI, and MCP.
  
  - Adds `readRunEventsSince` (plus `RunEventLineEntry` / `RunEventsReadState`) to `@trailstep/core` and routes `trailstep watch` and `trst_watch` through it: partial trailing lines wait for the next read, a shrunk/truncated file restarts from offset 0, and malformed or non-event lines are reported and skipped instead of aborting the watch. `trst_watch` keeps its byte-cursor long-poll contract and now validates event shape the same way the CLI does.
  - Adds `readPlainPayload` to `@trailstep/core` and uses it for all run-event payload reads (`replayCompletedSteps`, `replayToWaitingStep`, `replayToFailedStep`, `reattachInProgressStep`, `replayToCancelledStep`, `latestUnresolvedFailure`); removes the duplicated local helpers.
  - Makes `runs/wait-events` the single source for pending-wait lookup (`findLatestPendingWait`, `waitEventKey`); `replay-wait-events` re-exports instead of duplicating, and all call sites use the canonical `isRecord` / `isPlainObject` guards from `@trailstep/core`.
  - Replaces ~40 local `isRecord` / `isPlainObject` duplicates across `@trailstep/cli` (agent config, add/agents/answer/cancel/continue/doctor/input-template/output/providers/retry/run/runs/update/wait/watch/config/discovery/registry/validation) and `@trailstep/mcp` (`per_workflow`, `trst_answer`, `trst_watch`) with the canonical core guards; no behavior change except the stricter prototype-checked plain-object guard in scalar coercion.
  - Adds `resolveSubPromptAgentFiles` so sub-prompt runs share the same working-agent artifact file set (prompt/output/usage plus work/repair/attempts/stderr) instead of building it inline.
  - Removes the deprecated `core/load-order` re-export shim (implementation lives in `mcp/layered-mcp-loader`, still exported as `layeredMcpToolDirs` / `loadLayeredMcpToolDefinitions` with the `layeredDirs` / `load` aliases), the internal `runs/index` barrel (core index imports the run-directory / wait-event modules directly), and the unused `mcp/tools/index` barrel (server and index import the tool modules directly); drops the unexported `buildProviderWorkingPrompt` dead code.

## 0.7.0

### Minor Changes

- 9fc5734: Wire the agent heartbeat into agent-backed step execution and emit `step.progress` heartbeats for long-running steps.
  
  - `startAgentHeartbeat` (interval from `TRAILSTEP_AGENT_HEARTBEAT_INTERVAL_MS`, default 60s, `0` disables) is now wired into the agent step dispatch seam: it starts before dispatch and stops in a `finally` around the working-agent command / adapter step execution, so it clears on success, failure, and abort.
  - Long-running agent steps now emit best-effort `step.progress` heartbeat events so agents and people watching a workflow run know the step is still alive; interactive-mode steps are intentionally excluded (they already emit their own session events).
  - `startAgentHeartbeat` and `AgentHeartbeat` are exported from `@trailstep/core`.
  
  No changes to workflow authoring APIs or persisted event schemas.

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
