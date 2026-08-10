---
kind: rules
paths:
  - packages/core/src/contracts/
summary: Framework-neutral public contracts for agents, failures, enriched run context, and shapes.
triggers:
  - core contracts
  - agent adapter
  - failure type
  - run context type
  - workflow.retryStarted
  - step.attemptFailed
  - shape type
---

# packages/core/src/contracts/

Enter here when changing reusable contracts consumed across authoring, runtime, agent execution, targeting, known-CLI providers, or CLI surfaces. These modules are public-contract oriented and should remain small, framework-neutral, and free of runtime side effects.

## Subdirectories

- `agents/`: Enter when changing provider-neutral agent role, model, message, tool, prompt, adapter, or `AgentAdapterRequest` contracts.
- `failures/`: Enter when changing the exported structured failure shape or `StepKitFailureError` helper used to preserve failure codes through runtime catches.
- `run-context/`: Enter when changing durable run context/state interfaces, workflow metadata, event emission hooks, or current-step helpers exposed to continuations.
- `shapes/`: Enter when changing schema and plain-object type contracts used by authoring and runtime validation.

## Rules

- Do not import from runtime or agent-execution modules from contracts.
- Built-in provider-specific behavior belongs under `known-cli-providers/`; user provider behavior belongs in `customAgents` config.
- Keep `AgentAdapter`, `AgentAdapterObject`, and `AgentAdapterRequest` public signatures stable unless intentionally making a breaking public API change.
- Keep `RunContextEvent` aligned with durable run event types, including retry-start and step-attempt-failed events, when exposing event hooks on `RunContext`.
- `RunContext` may carry runtime-populated workflow metadata, agent roles, cwd, normalized StepKit config, process runners, event hooks/history, and current-step artifact/sub-prompt counters and limits; continuations should consume it ambiently rather than constructing it.
