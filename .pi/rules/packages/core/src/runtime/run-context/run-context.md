---
kind: rules
paths:
  - packages/core/src/runtime/run-context/
summary: Creation of the ambient run context, workflow metadata, event hooks, and durable per-run state access.
triggers:
  - run context
  - context state
  - state.json
  - ambient state
  - AsyncLocalStorage
---

# packages/core/src/runtime/run-context/

Enter here when changing the `RunContext` instance or how it is made ambiently available to step continuations. Step authors never construct or receive a `RunContext` directly — they import the `state` authoring helper (`authoring/state/state.ts`), which reads the current store via `currentRunContext()`.

## Rules

- Keep state reads/writes durable through `runtime/artifacts`; do not introduce process-only state here.
- Treat state values as JSON-compatible data because they are written to `state.json`.
- `runWorkflow` must wrap the entire resume + continuation flow in `runContextStorage.run(...)` — every downstream `onOutput` call depends on the store being populated for the whole async chain, not just the initial call.
- Do not thread `RunContext` back into continuation signatures or resume helper options; that plumbing was replaced by the ambient `state` export specifically so authors and internal call sites don't pass it around.
- Keep current-step counters separate for document artifacts and nested sub-prompts, and carry the step/workflow `maxSubPrompts` guard through step context.
