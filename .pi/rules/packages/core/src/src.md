---
kind: rules
paths:
  - packages/core/src/
summary: Source and tests for `@trailstep/core` contracts, authoring primitives, runtime modules, retry/timeout policies, agent targeting, agent execution, known-CLI providers, and run artifacts.
triggers:
  - core source
  - core tests
  - workflow primitive
  - event type
  - retry policy
  - timeout policy
  - known-CLI provider
  - agent targeting
---

# packages/core/src/

Enter here when implementing framework-neutral types or runtime behavior that other TrailStep packages consume. `index.ts` is the public barrel; keep exported APIs explicit and avoid leaking internal module structure unless it is an intentional public contract.

## Subdirectories

- `agent-execution/`: Enter when changing prompt-step dispatch, adapter-agent execution, working-agent commands, or interactive-agent commands.
- `agent-targeting/`: Enter when changing `.trailstep/config.json` parsing or role/size/default target resolution.
- `authoring/`: Enter when changing public workflow declarations, fluent step factories, continuation nodes, step configuration types, shape helpers, sub-prompt helpers, or prompt-template helpers.
- `contracts/`: Enter when changing reusable framework-neutral public contracts for agent roles/adapters/messages, failures, run context, or shapes.
- `known-cli-providers/`: Enter when changing built-in provider registry exports, provider contracts, vendor stdout envelopes, provider process args, or working-mode usage metadata.
- `runtime/`: Enter when changing `runWorkflow`, public runtime option/event/result types, retry/timeout policy utilities, continuation interpretation, failed-step resume replay, event creation/persistence, run artifacts, run summary listing, or run context creation.

## Rules

- Keep tests next to source and focused on behavior/contracts rather than package wiring.
- Add new workflow behavior through fluent callable `step({ id, ... })` flows.
- Keep prompt rendering deterministic from typed step input; read external state in code/orchestration before prompt steps.
- Keep `runWorkflow`, `RunContext`, `createRunContext`, `subPrompt`, `resolveRetryPolicy`, `validateRetryPolicy`, retry policy types, `resolveTimeoutPolicy`, `validateTimeoutPolicy`, timeout policy types, `selectLatestUnresolvedFailure`, `defaultRunsRoot`, durable run event/state helpers, run summary APIs, and provider registry/spec types explicit in the public barrel when exposed.
- Do not reintroduce retired top-level folders such as `engine/` or `shared/`; use the current runtime/contracts/agent modules.
- Keep `runtime/` independent of `agent-execution/interactive-agent`; shared interactive protocol helpers belong under `runtime/interactive-session/`.
- Keep refactored command front doors flat: `working-agent/run-working-agent-command.ts` and `interactive-agent/run-interactive-agent-command.ts`; do not export internal agent-execution or runtime helper folders from `index.ts`.
- Keep the public barrel TrailStep-only; do not add migrated compatibility aliases.
- Avoid generic `utils/`, `helpers/`, or `common/` buckets; use named capability folders/files.
- Treat `.trailstep/runs/` output as artifacts, not source fixtures, unless a test intentionally creates them in temp space.
- Resume replay is limited to failed no-prompt code steps with a single failed step and no recovered `onError` history unless runtime validation and tests are expanded together.
