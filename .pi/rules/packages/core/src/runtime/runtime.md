---
kind: rules
paths:
  - packages/core/src/runtime/
summary: Workflow execution, continuation interpretation, event/artifact persistence, configurable run roots, run summary listing, sub-prompt event support, failed-run resume/retry, retry/timeout policies, interactive reattachment, and run context creation.
triggers:
  - runWorkflow
  - runtime events
  - continuation runtime
  - interactive session
  - resume run
  - retry policy
  - timeout policy
  - run artifacts
---

# packages/core/src/runtime/

Enter here when changing how workflows execute or how local run artifacts are produced and consumed.

## Subdirectories

- `artifacts/`: Enter when changing default/custom run-root directory creation, event JSONL storage, run state storage, or artifact reading.
- `continuation/`: Enter when changing step/done/fail node interpretation, max-step guarding, step event emission, or error continuations.
- `events/`: Enter when changing event id/timestamp/schema construction.
- `failures/`: Enter when changing runtime failure-like detection or workflow/step failure shaping.
- `interactive-session/`: Enter when changing `interactive.json` completion detection, default interactive output shape, completed output reading, or shared protocol validation.
- `resume/`: Enter when changing failed-run replay validation, dangling interactive session reattachment, or which histories can be resumed.
- `retry/`: Enter when changing retry replay target selection, retry policy resolution/validation, replay-to-failure behavior, or consumed-failure resolution.
- `timeout/`: Enter when changing timeout policy resolution/validation or step timeout tests.
- `run-context/`: Enter when changing continuation-visible run id/name/path/state behavior, workflow metadata, emit hooks, or step-local artifact counters.
- `sub-prompts/`: Enter when changing nested sub-prompt execution, artifact paths, fingerprint replay, max-sub-prompt failures, or tests.
- `run-workflow/`: Enter when changing the public runtime entrypoint, options, result type, event types, input/output validation, or resume orchestration.
- `runs/`: Enter when changing default/custom run-root summary listing, newest-first sorting, or recent failed run selection.

## Rules

- Runtime failures should become structured `Failure` objects and be reflected by `workflow.failed` unless validation fails before a workflow can start/resume.
- Events are appended incrementally to `events.jsonl`; do not rely only on in-memory event arrays.
- `selectLatestUnresolvedFailure` should use the latest unresolved step/workflow failure or dangling `step.started` interruption and ignore completed runs or failures/interruptions consumed by `workflow.retryStarted`.
- Retry replay should rebuild history before the selected failure but re-run the retried step attempt, including prompt steps whose continuation failed after prompt completion.
- Keep input/output validation at workflow boundaries and step output validation after prompted dispatch.
- Sub-prompts must run inside an active step context, require an output shape, and replay only matching completed fingerprints before dispatch.
- Treat run names as requested names; actual run ids/directories may receive suffixes to avoid collisions under the selected runs root.
- Run summaries read from optional `runsRoot` (defaulting to `defaultRunsRoot(cwd)`), use unresolved failures for failed status/recent-failed selection, and classify completed retried runs as completed.
- Retry policy precedence is step over workflow over global config over built-in defaults; timeout policy precedence is step over workflow over global config over no built-in timeout. Validate `maxAttempts` and numeric timeout milliseconds as integers of at least 1.
