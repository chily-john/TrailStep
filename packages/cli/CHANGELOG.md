# @trailstep/cli

## 0.9.0

### Minor Changes

- 9fc5734: HARD-REMOVE the deprecated per-workflow generated-skills feature from the TrailStep CLI.
  
  Breaking changes:
  
  - `trailstep add` no longer accepts `--project-skill` or `--user-skill`; both flags are now rejected as unknown options.
  - Generated per-workflow skill files are no longer written during `trailstep add`.
  
  Migration:
  
  - Agents that should discover registered workflows use the TrailStep MCP server (`trst_*` tools) or the packaged TrailStep skills installed via `trailstep init --install-skill`.
  
  No changes for `trailstep init --install-skill`, `trailstep skill-check`, the packaged `trailstep-skill` / authoring-skill installs, or provider execution-time skill handling.

### Patch Changes

- Updated dependencies [9fc5734]
  - @trailstep/core@0.7.0
  - @trailstep/mcp@0.3.1

## 0.8.0

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
- 01690f3: Register the TrailStep MCP server with pi by writing pi's `mcp.json` entry directly instead of going through `add-mcp`.
  
  pi's `exposure` / `toolExposure` keys are pi-only concepts that `add-mcp` cannot express, so every pi user used to get the default whole-server `codemode` exposure. The direct write now applies an exposure profile that keeps the generic run-loop tools (`trst_run_workflow`, `trst_watch`, `trst_answer`, `trst_resume`) `direct` while the large-schema per-workflow `trst_*` tools stay `codemode`. The scope-to-path mapping is fixed as well: project and local scope write `<project>/.pi/mcp.json`, global scope writes `$PI_CODING_AGENT_DIR` (or `~/.pi/agent`) `mcp.json`, and pi is excluded from the `add-mcp` agent list so no competing user-level entry is written. The write is atomic, preserves other servers and unknown top-level keys, never clobbers a differently-configured entry, and never fails the run: it warns and prints the manual `pi mcp add <name> -- <command> <args...>` command instead. Every other coding agent keeps the existing `add-mcp` path.
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
- 3d3dc86: Verticalize the CLI internals and the create-flows shared directory.
  
  `@trailstep/cli`: the loose `packages/cli/src/internals/` root files that formed
  one concern now live in `packages/cli/src/internals/command-framework/`
  (`command.types.ts`, `command.types.test.ts`, `command-registry.ts`,
  `command-registry.test.ts`), and `official-provider-specs.ts` was folded into
  `packages/cli/src/internals/providers/official-providers.ts` alongside the
  existing official-provider package helpers. Every importer was updated.
  
  `@trailstep/create-flows`: the misnamed `src/feature-implementation/shared/`
  directory was split. The cross-flow contracts imported by the sibling
  `grill-it-away` and `take-it-away` flows (`agent-roles.ts`, `input-schema.ts`,
  `output-schema.ts`, `constants.ts`) moved to package level at
  `packages/create-flows/src/shared/`. The feature-implementation-only files
  (`story-state.ts`, `story-view.ts`, `review-schema.ts`) stayed inside
  `packages/create-flows/src/feature-implementation/shared/story/`, and the prompt
  fragment markdown files moved to
  `packages/create-flows/src/feature-implementation/prompts/`.
  
  This is a behavior-preserving refactor: no public export, workflow shape, or
  runtime behavior changed.
- Updated dependencies [3d3dc86]
- Updated dependencies [51d35f5]
- Updated dependencies [28e6560]
- Updated dependencies [94788f4]
- Updated dependencies [3d3dc86]
- Updated dependencies [94788f4]
- Updated dependencies [51d35f5]
- Updated dependencies [337eab6]
- Updated dependencies [65f6a96]
- Updated dependencies [94788f4]
- Updated dependencies [51d35f5]
- Updated dependencies [51d35f5]
- Updated dependencies [81a4942]
  - @trailstep/core@0.6.0
  - @trailstep/mcp@0.3.0

## 0.7.0

### Minor Changes

- 1d20c85: Extend `trailstep update --project` / `--all` self-update scope to include `@trailstep/mcp` and provider packages (`@trailstep/provider-claude`, `@trailstep/provider-codex`, `@trailstep/provider-gemini`, `@trailstep/provider-pi`) when present in `package.json`. Peer-compatible resolution against latest stable `@trailstep/core` matches the existing authoring/cli pattern; packages without a core peer fall back to latest stable. Absent packages are ignored, and authoring/cli compatibility is now only required when installed.

### Patch Changes

- 805dbe9: Add opt-in lean `execution` context (`AgentExecutionConfig`, `resolveAgentExecutionConfig`, `DEFAULT_AGENT_EXECUTION`) on agent steps and workflow roles, rendered through provider `hygiene` capability mappings into `{{tools}}`, `{{skills}}`, `{{mcpArgs}}`, `{{extensionsArgs}}`, and `{{contextFilesArgs}}` argv templates. Wire hygiene placeholders into all four provider manifests (pi, claude, codex, gemini), default every delegate workflow to the lean context, and document flag splitting plus the `project-only` collapse on CLIs without a dedicated project-only flag.
- 69db9a9: Retry transient working-agent spawn failures with exponential backoff instead of burning the agent target chain. Windows process-level deaths (e.g. `0xC0000142` `STATUS_DLL_INIT_FAILED`) and resource-exhausted spawn errors are now classified as transient: the format phase is retried in the same session (never re-running Phase 1 work) and failing targets are retried before falling back, with growing jittered delays (default 4 attempts, 2s base, x3, 60s cap) configurable via `settings.spawnRetry`. Failures are now visible the moment they happen: new `agent.attemptFailed` events, an incremental `attempts.json` audit trail per step, and captured spawn `stderr.txt` artifacts. Track state records `ownerPid` so runs left `running` by a dead runner are reported as orphaned instead of silently active.
- Updated dependencies [805dbe9]
- Updated dependencies [69db9a9]
  - @trailstep/core@0.5.0
  - @trailstep/mcp@0.2.2

## 0.6.0

### Minor Changes

- d34b528: Split MCP server registration per scope: project/local registrations keep the `trailstep` server name with a pinned `mcp --project <absolute dir>` command, while global registrations now use the distinct `trailstep-global` server name and omit `--project` so the server follows the agent client's current project (layered project tools plus global `~/.trailstep` tools). Global manual and spawn argv now include `--global` and reflect the omitted `--project`, and the manual fallback command is rendered with the resolved scope's flags and server name when add-mcp cannot be resolved.
- a42b8b9: Lock `add-mcp` MCP registration to the resolved workflow scope and make the manual fallback robust. `trailstep init` and `trailstep add` now pass their resolved `--scope local|project|global` through to `offerMcpRegistration({ scope })`, so registration uses the same scope with no second WHERE prompt. Every manual fallback (`add-mcp` unresolvable, spawn failure, `ERR_TTY_INIT_FAILED`, or a declined local registration) now re-renders the printed `npx add-mcp` command with the resolved scope flags (`--gitignore` / `--global`) and the resolved server args. Headless `--yes` behavior is unchanged: no prompts, print the manual command, never spawn. `add-mcp` is promoted from a devDependency of `@trailstep/mcp` to a production dependency so published installs of `@trailstep/cli` can resolve the `add-mcp` bin entry (packaging trade-off: every `@trailstep/mcp` install now pulls in `add-mcp`; resolution walks cli -> `@trailstep/mcp` package root -> `add-mcp` and works even before `@trailstep/mcp`'s dist is built).

### Patch Changes

- Updated dependencies [a42b8b9]
  - @trailstep/mcp@0.2.1

## 0.5.0

### Minor Changes

- 30edf9e: Per-workflow MCP tools with automatic generation and registration. Adding a workflow now generates `.trailstep/mcp/trst_<id>.json` (description plus input params from `defineWorkflow` input shape), refreshed on `trailstep update --workflows`; the MCP server publishes each workflow as its own tool by default, with `mcp.perWorkflowTools: false` falling back to a `trst_list` catalog alongside the generic `trst_run_workflow` / `trst_watch` / `trst_answer` / `trst_resume` toolkit. `trailstep init` and `trailstep add` auto-offer `add-mcp` registration of the `trailstep mcp` server (absolute `--project`, headless-safe manual fallback). The legacy `skill` field in `defineWorkflow` remains accepted for backwards compatibility.
- eaa12bf: Added registration scope selection (project/local/global) to the MCP add-mcp offer. Interactive registration now asks where the MCP server entry should live after the register confirm: project (committed, default), local (project file appended to .gitignore with a preview before confirming), or global (user-level config, with a note that the entry still serves only the pinned project). Headless runs default to project scope and print the manual fallback without prompting. Scope flags are included in the rendered manual `npx add-mcp` command.
- 4dba420: Robust MCP server as thin adapters over existing run/watch/answer/continue seams. The MCP package now runs a real Model Context Protocol server (low-level Server plus StdioServerTransport): `trst_run_workflow` returns real run ids immediately while the run continues detached in the background, `trst_watch` streams `events.jsonl` offsets with long-poll, `trst_answer` writes real wait files with branch disambiguation, and `trst_resume` continues runs; `trailstep://project` and `trailstep://instructions` resources included. `trailstep mcp --project <dir>` is the foreground server (no detached spawn, no stubs). Core `load-order` uses `os.homedir` with explicit project dir and local-over-project-over-global precedence, and the manifest working-provider timeout guard no longer throws when no timeout is set.

### Patch Changes

- Updated dependencies [30edf9e]
- Updated dependencies [4dba420]
  - @trailstep/mcp@0.2.0
  - @trailstep/core@0.4.0

## 0.4.2

### Patch Changes

- f385f00: Add `--version` flag to the `trailstep` CLI. Prints the CLI package version and exits 0.
- cfc9af6: Fix silent exit when CLI binary is invoked through symlinks or hard links (e.g., workspace-linked global install). The `import.meta.url` vs `process.argv[1]` path comparison failed for linked paths, so `main()` was never called. Compare filenames (`index.js`) instead of full paths.

## 0.4.1

### Patch Changes

- 40871ed: Branch-scoped parallel wait-continue (Gaps 3+4) with branch-keyed parallel waits (Gaps 1+2).
  
  Gaps 1+2 (c0d78f5): decorateBranchEvent decorates wait.started/satisfied/failed with branchId+stepIndex on split tracks; waitEventKey/findPendingWaitsById/waitEventBranchId branch-aware with root fallback; trailstep answer accepts --branch and errors on ambiguous bare answers.
  
  Gaps 3+4 (594ac0b): replayToWaitingStep extended with optional branch scope {branchId, stepIndex} and readBranchRunState hydration; run-workflow.ts isWaitContinue replaces blanket guard with routing — resumes every waiting branch having recorded answer.json through root-continuation-array-scheduler restore (mirror retry path ~L971, never rebuild); unanswered branches stay waiting; done/failed/cancelled siblings never re-execute; CLI command.types.ts usageText documents --branch.
  
  Verification: core 389 tests pass; new co-located tests added; full E2E verified (delegate v4); regression verified clean (non-parallel paths unchanged); build green.
- 8e8bbe8: Fix Windows npm-shim spawning and bare `trailstep add` specs: working/custom/interactive provider commands and Pi model discovery now resolve `.cmd` shims to their Node entrypoint under `shell: false` (no-op on other platforms); bare npm specs like `@trailstep/create-flows` default to `@latest`, reusing the installed bundle when already present.
- Updated dependencies [40871ed]
- Updated dependencies [40871ed]
- Updated dependencies [8e8bbe8]
  - @trailstep/core@0.3.0

## 0.4.0

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
- 9c9e7e0: Split recommended-config consent out of the blanket `trailstep update` confirmation: when recommended config additions ride along with package/skill changes, a second prompt asks whether to apply them, and declining skips only the recommended config writes while the rest of the update proceeds.
- 5f40583: `trailstep update` now picks up skills for new workflow exports of already-installed workflow packages: workflow exports without registry entries ("untracked workflows") get generated skills written to `.trailstep/skills/`, run via their package bundle ref, and distributed after workflow package installs. Untracked workflow skills are distributed only to the skill target(s) the user chose at `trailstep add` time (persisted per registration in workflow metadata). For legacy registrations without a recorded choice, update infers the targets from where that package's skills already exist (project vs. user skill directory) and otherwise defaults to project-only, reporting what was chosen.

### Patch Changes

- 71f0ffe: Fix `trailstep add` silently skipping `trailstep.recommendedConfig` for local directory package sources (such as `./packages/sub-agents`); agent pools and workflow role mappings are now applied additively, matching npm-backed adds.
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

## 0.3.2

### Patch Changes

- f11b394: Improve README guidance for interactive setup and clearer workflow authoring examples.

## 0.3.1

### Patch Changes

- ba31526: Improve public README documentation, getting-started guidance, and npm package positioning.
- Updated dependencies [ba31526]
  - @trailstep/core@0.1.1

## 0.3.0

### Minor Changes

- 8b8bef8: Fix `trailstep update` so it updates the globally installed CLI by default and refreshes the bundled TrailStep skill.

## 0.2.0

### Minor Changes

- f8527c7: Update both the init, agents and add flows to be way easier to use.
