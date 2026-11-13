# @trailstep/mcp

## 0.5.0

### Minor Changes

- 5f379ec: `@trailstep/mcp` `trst_watch` is now a blocking wait-for-attention call: one call blocks until the run settles, needs an answer, new events arrive, or the budget expires, and it returns `started`, `in-progress`, `waiting`, `terminal` or `crashed`. The compact result carries whichever of `output`, `waits`, `failure`, `crash` or `progress` applies; a cancelled run may carry none of them. It adds the `maxWaitMs` and `waitFor` parameters and sanitizes control characters in progress notifications. State now comes from the shared `@trailstep/core` run-state classifier rather than a watch-local event scan: a stale run and a canonical `unknown` run are both reported `crashed`, with `crash.code` preserving the difference (`no-live-process` vs `unknown-run-state`), while an event-less run whose track reports a live owner stays `started`. A live run lock now outranks absent or unusable track evidence, so a run held by a live process is `started` or `in-progress` even when `track.json` is missing, malformed or oversized; `unknown` now means there is neither a live lock nor usable track evidence. The crash payload joins the classifier's diagnostic messages (for a stale run, the stale-owner message), so a pending cancellation stays visible next to the state reason, and a watch whose signal is already aborted returns its entry snapshot instead of a spurious crash. Crashed means the watch will not observe further progress, and a lock file left by a dead process whose pid was reused can still read as alive.
  
  With a progress token a call can block for up to 5 minutes, and the client may treat progress notifications as a keep-alive. Without one the call is capped at 25 seconds and returns a snapshot whose state depends on the run to call again, reported by `effectiveWaitMs`.
  
  `@trailstep/cli` `trailstep watch` now decides when to stop from that same classifier and its public watch projection instead of its own terminal/wait event scan: terminal, waiting and crashed (including canonical `unknown`) stop the stream, while started and in-progress keep streaming. A normal terminal event and a pending wait still stop silently with exit code 0. The abnormal cases are explicit: a stale run prints `Watch stopped: run crashed.` with the classifier's stale-owner reason and exits 2, while canonical `unknown` prints `Watch stopped: run state is unknown.` with the joined classifier reasons and exits 3. A cancellation request with no terminal event is no longer treated as terminal: with no live owner it classifies as `unknown`, so the watch prints the unknown and cancellation reasons together and exits 3; a waiting track with no pending wait still prints that no pending wait exists and exits 0. Classification happens before the `--no-follow` early return, so the documented exit codes also apply when only the events already on disk are printed. Stop reasons go to stderr so `--json` and `--jsonl` stdout stay event-only. Human, JSON and JSONL output, `--follow`/`--no-follow`, `--since beginning`, the poll interval and malformed-line reporting are otherwise unchanged, and a pending wait still prints the existing waiting line.
  
  `@trailstep/mcp` `trst_resume` now judges status in the current lifecycle cycle, matching the canonical classifier: a `workflow.cancelRequested` without a terminal event is not terminal, so resume reports `running` (never `waiting`) while the request is pending in the current cycle, and a request superseded by a later `workflow.resumed` or `workflow.retryStarted` no longer makes the reopened run look cancelled. The same cycle window keeps an older cycle's terminal event from overriding the resumed run's state.
  
  `@trailstep/core` exports one lifecycle-cycle rule plus `listPendingWaits` for the `waiting` state and `toPublicWatchRunState`, the five-state projection shared by MCP and CLI watch. `findLifecycleCycleStartIndex`, `selectCurrentLifecycleCycle` and `findLifecycleTerminalEvent` now live in one module and are used by the classifier, `runWorkflow`, run summaries, evidence queries and MCP resume, so `workflow.resumed` and `workflow.retryStarted` consistently reopen a run and an earlier cycle's terminal, cancellation or pending wait cannot decide its current state. `EvidenceDiagnosticCode` now includes `cancellation-pending`, derived from a module-level `EVIDENCE_DIAGNOSTIC_CODES` list that the evidence JSON-schema enum uses directly, so the classifier can mark a pending cancellation without changing the schema version. Core run summaries now select the terminal status and unresolved failure within the current cycle, and every other eventful run projects the shared classifier: a parked wait reports `active`, a dead owner `stale`, missing evidence `unknown`, and a recorded `step.failed` stays failure detail (including in "Recent failed runs") without flipping the status. A current-cycle `workflow.failed` still reports `failed`, and an event-less run whose track records `completed`, `failed` or `cancelled` keeps that status because the track is its only durable completion record. A run with a recorded step failure and no terminal event is therefore no longer archive/delete eligible: it stays hot until a terminal event or manual deletion. "Recent failed runs" now selects by the recorded unresolved failure inside its seven-day window rather than by `status === "failed"`, so a waiting or stale run with a recorded failure remains visible. The bounded evidence scan retains `workflow.resumed` and `workflow.retryStarted` so its state matches the classifier, and `inspectRunEvidence` additively exposes a `cycles` array with each cycle's reopen event, terminal/cancellation event and pending-wait count; superseded cycles remain inspectable rather than hidden. Because that projection changed, `RUN_EVIDENCE_QUERY_PROJECTOR_REVISION` is bumped from `2` to `3`.

### Patch Changes

- 8606842: Patch published runtime transitive security fixes.
  
  - Pin `fast-uri` to 3.1.9 via `ajv`: `@trailstep/core` depends on `ajv` directly, and `@trailstep/cli` / `@trailstep/mcp` pull the same `ajv` path transitively through `@modelcontextprotocol/sdk`.
  - Pin `body-parser` to 2.4.0 via `express`: `@trailstep/cli` / `@trailstep/mcp` pull it transitively through the MCP SDK `express` dependency.
  
  `deepmerge` 4.3.1 advisory remains visible with no patched release available; this changeset does not claim all vulnerabilities are gone. `vitest` and dashboard `vite`/svelte-plugin bumps are dev/build-only and do not trigger separate published bumps.
- Updated dependencies [5f379ec]
- Updated dependencies [267b15c]
- Updated dependencies [d26a2f9]
- Updated dependencies [8606842]
  - @trailstep/core@0.10.0

## 0.4.0

### Minor Changes

- 167b58e: Make MCP tools bounded, truthful, and crash-aware.
  
  - `trst_resume` no longer blocks for the whole continue. It spawns `trailstep continue` detached, waits only for bounded evidence that the continue began, and returns `{ resumed: true, status, background: true }`. Previously it awaited a multi-minute continue inside the MCP request, past the client's transport timeout, so a retrying agent started a **second** continue process on the same run directory — the concrete cause of the reported "1 in 5 runs hang" behaviour.
  - `trst_resume` derives `status` from the run's parsed event trail (`completed` / `waiting` / `cancelled` / `failed` / `running`) instead of substring-matching human-readable CLI output, which degraded silently on any wording change.
  - `trst_answer` with `continueAfterAnswer: true` now returns an `isError` tool result when the continue failed, instead of a success payload that left the calling agent watching a run that could not progress.
  - `trst_watch` gains a `crashed` state: no terminal event and no live holder of the run lock means nothing will ever append one, so an orchestrating agent can stop waiting. State is now classified from parsed events and the run lock rather than a regex over raw file text, which could match event-shaped text embedded in agent output. Runs parked on a durable wait correctly remain `in-progress`.
  - `readRunEventsSince` short-circuits when the trail has not grown. `trst_watch` previously re-read and re-decoded the entire `events.jsonl` every 50 ms, which was ~5 GB of reads per 25 s long-poll on a 10 MB trail and grew linearly with run length.
  - `trst_run_workflow` resolves the run directory the CLI actually created instead of predicting it, so a run-name collision no longer reports `started` against a stale directory from an earlier run.

### Patch Changes

- Updated dependencies [167b58e]
- Updated dependencies [167b58e]
- Updated dependencies [167b58e]
- Updated dependencies [167b58e]
- Updated dependencies [167b58e]
- Updated dependencies [167b58e]
- Updated dependencies [167b58e]
- Updated dependencies [167b58e]
  - @trailstep/core@0.9.0

## 0.3.2

### Patch Changes

- cf75cb1: Share durable run-event readers and canonical JSON guards across core, CLI, and MCP.
  
  - Adds `readRunEventsSince` (plus `RunEventLineEntry` / `RunEventsReadState`) to `@trailstep/core` and routes `trailstep watch` and `trst_watch` through it: partial trailing lines wait for the next read, a shrunk/truncated file restarts from offset 0, and malformed or non-event lines are reported and skipped instead of aborting the watch. `trst_watch` keeps its byte-cursor long-poll contract and now validates event shape the same way the CLI does.
  - Adds `readPlainPayload` to `@trailstep/core` and uses it for all run-event payload reads (`replayCompletedSteps`, `replayToWaitingStep`, `replayToFailedStep`, `reattachInProgressStep`, `replayToCancelledStep`, `latestUnresolvedFailure`); removes the duplicated local helpers.
  - Makes `runs/wait-events` the single source for pending-wait lookup (`findLatestPendingWait`, `waitEventKey`); `replay-wait-events` re-exports instead of duplicating, and all call sites use the canonical `isRecord` / `isPlainObject` guards from `@trailstep/core`.
  - Replaces ~40 local `isRecord` / `isPlainObject` duplicates across `@trailstep/cli` (agent config, add/agents/answer/cancel/continue/doctor/input-template/output/providers/retry/run/runs/update/wait/watch/config/discovery/registry/validation) and `@trailstep/mcp` (`per_workflow`, `trst_answer`, `trst_watch`) with the canonical core guards; no behavior change except the stricter prototype-checked plain-object guard in scalar coercion.
  - Adds `resolveSubPromptAgentFiles` so sub-prompt runs share the same working-agent artifact file set (prompt/output/usage plus work/repair/attempts/stderr) instead of building it inline.
  - Removes the deprecated `core/load-order` re-export shim (implementation lives in `mcp/layered-mcp-loader`, still exported as `layeredMcpToolDirs` / `loadLayeredMcpToolDefinitions` with the `layeredDirs` / `load` aliases), the internal `runs/index` barrel (core index imports the run-directory / wait-event modules directly), and the unused `mcp/tools/index` barrel (server and index import the tool modules directly); drops the unexported `buildProviderWorkingPrompt` dead code.
- Updated dependencies [cf75cb1]
- Updated dependencies [cf75cb1]
  - @trailstep/core@0.8.0

## 0.3.1

### Patch Changes

- Updated dependencies [9fc5734]
  - @trailstep/core@0.7.0

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
