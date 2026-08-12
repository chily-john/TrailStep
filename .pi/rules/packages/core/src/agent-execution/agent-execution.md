---
kind: rules
paths:
  - packages/core/src/agent-execution/
summary: Prompted step dispatch through adapter agents, configured working agents, or interactive command handoff, including cancellation signals.
triggers:
  - agent execution
  - prompted step
  - working agent
  - interactive agent
  - adapter agent
---

# packages/core/src/agent-execution/

Enter here when changing how a prompted step is dispatched after the continuation runtime reaches it.

## Subdirectories

- `adapter-agent/`: Enter when changing custom adapter invocation, submit-output tool behavior, adapter prompt messages, or adapter output failure handling.
- `custom-provider/`: Enter when changing shared argv template rendering for working and interactive custom providers.
- `working-agent/`: Enter when changing non-interactive command/provider execution, prompt/output file layout, target fallback behavior, output parsing, raw-text document capture, or structured-output validation. Helpers are grouped by `artifacts/`, `prompts/`, `output/`, and `targets/`.
- `interactive-agent/`: Enter when changing inherited-stdio human handoff, interactive prompt construction, provider target routing, process completion/cancellation, command placeholders, one-off continue Skill prompting, or interactive protocol handoff.

## Rules

- A prompted step must reference a workflow-level `agent` role; working steps must declare `outputShape`, while interactive steps without one use the default session-file shape.
- Missing `.trailstep/config.json` is allowed only until a prompted configured-agent step needs it and no adapter is supplied.
- Working custom providers use `args` with `{{promptFile}}`, `{{outputFile}}`, and optional `{{model}}`/`{{thinking}}`; interactive custom providers require `interactiveArgs` with `{{promptFile}}` or `{{prompt}}` plus optional `{{model}}`/`{{thinking}}`. Placeholders and `{{#model}}`/`{{#thinking}}` conditional blocks must be whole argv values; guard optional placeholders when absent.
- Interactive agents complete through the runtime-owned file-based protocol written under the step artifacts; keep `TRAILSTEP_INTERACTIVE_FILE` available to spawned processes, instruct handoff prompts to run `trailstep continue`, require `interactive.json` to be marked completed, and route explicit `outputShape` sessions through schema-validated JSON output.
- Interactive custom commands write `prompt.txt` only when `{{promptFile}}` is used; built-in providers always receive the prompt and system prompt file.
- Interactive provider processes inherit defined process environment values, with `TRAILSTEP_INTERACTIVE_FILE` set to the session protocol file.
- Spawned working/interactive agent processes run with `shell: false`, accept abort signals, and terminate process trees on cancellation; do not add shell interpolation.
- Working and interactive agents write/read step artifacts under `.trailstep/runs/<run>/steps/`; keep those artifacts under the run directory. Nested sub-prompts may pass pre-resolved working-agent files under their sub-prompt artifact directory.
- Working-agent output handling must honor the step output capture mode: JSON mode expects one object, while raw-text mode captures the full response as a `Document` artifact.
