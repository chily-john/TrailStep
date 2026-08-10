---
kind: rules
paths:
  - packages/authoring/src/workflow-builder/
summary: '`defineWorkflow` builder and author-facing workflow metadata types.'
triggers:
  - defineWorkflow
  - workflow builder
  - workflow metadata
  - workflow start
---

# packages/authoring/src/workflow-builder/

Enter here when changing `defineWorkflow` or its TypeScript option types.

## Rules

- Preserve the single explicit object-form API unless product direction changes.
- `start(input)` is required for workflows.
- Workflow-level `agents` are provider-neutral role declarations consumed by core targeting, not provider bindings.
- Metadata such as `name` and `description` is author-facing only unless core/CLI/dashboard behavior is deliberately added.
