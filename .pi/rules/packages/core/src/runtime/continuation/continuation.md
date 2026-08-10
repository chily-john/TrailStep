---
kind: rules
paths:
  - packages/core/src/runtime/continuation/
summary: Interpretation loop for step/done/fail continuation nodes, automatic retry attempts, step timeouts, and step-level events/failures.
triggers:
  - continuation loop
  - step.started
  - step.completed
  - step.failed
  - step.attemptFailed
  - maxSteps
  - step timeout
  - error continuation
---

# packages/core/src/runtime/continuation/

Enter here when changing how continuation nodes are interpreted after workflow start or resume.

## Rules

- A no-prompt step's `.next(...)` is its work; emit `step.completed` only after that continuation succeeds.
- A step continuation that returns `fail(...)` is a step-scoped failure; emit `step.failed` and do not emit `step.completed`.
- Prompted working steps require `outputShape`; interactive steps without one use the default session-file shape, and all raw agent output must be schema-asserted before the next continuation runs.
- Invalid continuation return values are `invalid_continuation` failures and should emit `step.failed` when they occur inside a step.
- Preserve the max-step guard and pass step/workflow `maxSubPrompts` into step context for nested sub-prompt limits; make changes with runtime tests.
- Step timeouts fail as `step_timeout`, emit `step.failed`, and pass abort signals through prompted dispatch.
- Safe automatic step retries emit `step.attemptFailed` before `workflow.retryStarted` and do not emit `step.failed` for the consumed attempt.
- `StepKitFailureError` and failure-like thrown values should preserve their failure codes rather than being wrapped generically.
