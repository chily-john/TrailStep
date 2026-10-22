---
"@trailstep/core": minor
"@trailstep/cli": patch
---

Make run artifacts durable under concurrent access.

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
