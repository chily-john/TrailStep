---
"@trailstep/core": minor
"@trailstep/cli": minor
---

Complete the cancellation lifecycle: the cancel marker is a pending request, not
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
