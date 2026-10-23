---
"@trailstep/core": minor
"@trailstep/cli": patch
"@trailstep/mcp": patch
---

Share durable run-event readers and canonical JSON guards across core, CLI, and MCP.

- Adds `readRunEventsSince` (plus `RunEventLineEntry` / `RunEventsReadState`) to `@trailstep/core` and routes `trailstep watch` and `trst_watch` through it: partial trailing lines wait for the next read, a shrunk/truncated file restarts from offset 0, and malformed or non-event lines are reported and skipped instead of aborting the watch. `trst_watch` keeps its byte-cursor long-poll contract and now validates event shape the same way the CLI does.
- Adds `readPlainPayload` to `@trailstep/core` and uses it for all run-event payload reads (`replayCompletedSteps`, `replayToWaitingStep`, `replayToFailedStep`, `reattachInProgressStep`, `replayToCancelledStep`, `latestUnresolvedFailure`); removes the duplicated local helpers.
- Makes `runs/wait-events` the single source for pending-wait lookup (`findLatestPendingWait`, `waitEventKey`); `replay-wait-events` re-exports instead of duplicating, and all call sites use the canonical `isRecord` / `isPlainObject` guards from `@trailstep/core`.
- Replaces ~40 local `isRecord` / `isPlainObject` duplicates across `@trailstep/cli` (agent config, add/agents/answer/cancel/continue/doctor/input-template/output/providers/retry/run/runs/update/wait/watch/config/discovery/registry/validation) and `@trailstep/mcp` (`per_workflow`, `trst_answer`, `trst_watch`) with the canonical core guards; no behavior change except the stricter prototype-checked plain-object guard in scalar coercion.
- Adds `resolveSubPromptAgentFiles` so sub-prompt runs share the same working-agent artifact file set (prompt/output/usage plus work/repair/attempts/stderr) instead of building it inline.
- Removes the deprecated `core/load-order` re-export shim (implementation lives in `mcp/layered-mcp-loader`, still exported as `layeredMcpToolDirs` / `loadLayeredMcpToolDefinitions` with the `layeredDirs` / `load` aliases), the internal `runs/index` barrel (core index imports the run-directory / wait-event modules directly), and the unused `mcp/tools/index` barrel (server and index import the tool modules directly); drops the unexported `buildProviderWorkingPrompt` dead code.
