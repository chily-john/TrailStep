---
"@trailstep/mcp": minor
"@trailstep/core": patch
---

Make MCP tools bounded, truthful, and crash-aware.

- `trst_resume` no longer blocks for the whole continue. It spawns `trailstep continue` detached, waits only for bounded evidence that the continue began, and returns `{ resumed: true, status, background: true }`. Previously it awaited a multi-minute continue inside the MCP request, past the client's transport timeout, so a retrying agent started a **second** continue process on the same run directory — the concrete cause of the reported "1 in 5 runs hang" behaviour.
- `trst_resume` derives `status` from the run's parsed event trail (`completed` / `waiting` / `cancelled` / `failed` / `running`) instead of substring-matching human-readable CLI output, which degraded silently on any wording change.
- `trst_answer` with `continueAfterAnswer: true` now returns an `isError` tool result when the continue failed, instead of a success payload that left the calling agent watching a run that could not progress.
- `trst_watch` gains a `crashed` state: no terminal event and no live holder of the run lock means nothing will ever append one, so an orchestrating agent can stop waiting. State is now classified from parsed events and the run lock rather than a regex over raw file text, which could match event-shaped text embedded in agent output. Runs parked on a durable wait correctly remain `in-progress`.
- `readRunEventsSince` short-circuits when the trail has not grown. `trst_watch` previously re-read and re-decoded the entire `events.jsonl` every 50 ms, which was ~5 GB of reads per 25 s long-poll on a 10 MB trail and grew linearly with run length.
- `trst_run_workflow` resolves the run directory the CLI actually created instead of predicting it, so a run-name collision no longer reports `started` against a stale directory from an earlier run.
