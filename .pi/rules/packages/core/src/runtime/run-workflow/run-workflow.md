---
kind: rules
paths:
  - packages/core/src/runtime/run-workflow/
summary: Public `runWorkflow` entrypoint, run initialization, configurable runs root, config/settings normalization, runtime option/result/event types, retry-start and attempt-failure events, sub-prompt events, input/output validation, resume orchestration, retry orchestration, and timeout policy wiring.
triggers:
  - runWorkflow
  - initializeRun
  - parseStepKitConfigInput
  - StepKit settings
  - RunWorkflowOptions
  - runsRoot
  - workflow result
  - workflow.retryStarted
  - step.attemptFailed
  - workflow input validation
  - workflow output validation
  - resume option
  - retry option
  - timeout policy
---

# packages/core/src/runtime/run-workflow/

Enter here when changing the public runtime execution API or its typed result/event surface.

## Rules

- New runs require `input` and `runName`; resume and retry runs require their existing `runDir` and must not load new input.
- `workflow.inputShape`/`outputShape` are preferred, while `input`/`output` schema fields remain accepted by runtime/discovery where source still supports them.
- `cwd` controls prompt-template resolution and the default run artifact location; `runsRoot` can override where new run directories are created, and default `cwd` is `process.cwd()`.
- `stepkitConfig` accepts either parsed flattened `StepKitConfig` (including retry objects and numeric timeout settings) or a raw config object; normalize it through `parseStepKitConfigInput` before configured-agent dispatch.
- Keep new-run directory creation and existing-run event loading in `initializeRun`; `runWorkflow` owns orchestration and result shaping.
- Preserve injectable event/process runners for CLI and tests, including supplied environment and abort signals for working/interactive processes.
- Unknown thrown errors should become `workflow_failed`; `StepKitFailureError` and failure-like objects should preserve failure codes.
- Keep the public `Event` union aligned with emitted workflow, retry-start, attempt-failure, step, sub-prompt, interactive, and tool-call event types.
