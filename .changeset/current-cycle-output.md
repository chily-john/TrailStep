---
"@trailstep/cli": patch
---

`trailstep output` now reads only the run's current lifecycle cycle. `workflow.resumed` and `workflow.retryStarted` start a new cycle, so a reopened run no longer returns an earlier cycle's `workflow.completed` output or terminal message, and its error status is not inherited from an earlier completion, failure or pending wait. When the current cycle has no final output, the error status reports the current cycle's `completed`, `failed` or `cancelled` terminal event, or `waiting` for its pending wait; a reopened running run reports `not completed`. `--message` uses the current cycle's terminal message and otherwise keeps the existing no-final-message error. Single-cycle output, `--field`, `--json` and archived-run restore guidance are unchanged.
