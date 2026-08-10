---
kind: rules
paths:
  - packages/core/src/runtime/resume/
summary: Failed-run replay validation and reconstruction of the failed code step for resume.
triggers:
  - resume workflow
  - replay failed step
  - resume validation
  - workflow.resumed
---

# packages/core/src/runtime/resume/

Enter here when changing which failed run histories can be resumed or how replay reconstructs the live continuation node.

## Rules

- Resume requires a `workflow.started` event, a terminal `workflow.failed` event, and exactly one `step.failed` event.
- Resume supports code-step history, including completed nested `subPrompt` replay by event fingerprint; top-level prompted steps and `onError` recovery history are rejected.
- Preserve step-id drift checks so changed workflow structure does not silently resume the wrong step.
- Resume validation failures should be structured failures and should not append new failure events to the target history.
