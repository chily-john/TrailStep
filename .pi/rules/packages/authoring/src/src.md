---
kind: rules
paths:
  - packages/authoring/src/
summary: 'Source and tests for `@stepkit/authoring` workflow authoring APIs and re-exported core types, including retry/timeout policies.'
triggers:
  - authoring source
  - authoring tests
  - workflow authoring
  - prompt API
  - builder API
  - retry policy
  - timeout policy
---

# packages/authoring/src/

Enter here when implementing author-facing workflow APIs, fluent step factories, schemas, local prompt-template helpers, or authoring validation hooks. `index.ts` is the public authoring barrel; prefer re-exporting stable core primitives rather than redefining runtime semantics here.

## Subdirectories

- `workflow-builder/`: Enter when changing `defineWorkflow` validation or author-facing workflow metadata.
- `shared/`: Enter for authoring-only validation utilities used by builders.

## Rules

- Favor explicit object APIs; do not add convenience overloads without a product decision.
- Re-export core fluent factory primitives (`step`, `done`, `fail`, `promptTemplate`), retry/timeout policy types, and run context types rather than wrapping their runtime semantics in the authoring layer.
- Keep prompt output deterministic from step input; require orchestration/code steps to gather outside state first.
