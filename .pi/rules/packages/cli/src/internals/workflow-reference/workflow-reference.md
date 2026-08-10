---
kind: rules
paths:
  - packages/cli/src/internals/workflow-reference/
summary: Parsing of package-qualified and bundle workflow references used by CLI run commands.
triggers:
  - workflow reference
  - package workflow export
  - package:workflowExport
  - package-or-path#workflowName
  - parseWorkflowId
---

# packages/cli/src/internals/workflow-reference/

Enter here when changing how CLI arguments identify workflow exports. Workflow ids use `<package:workflowExport>` for discovered package exports or `<package-or-path#workflowName>` for bundle manifest workflows; package-export ids parse on the last colon so scoped package names remain valid.

## Rules

- Keep invalid workflow ids as `CliUsageError` so `main()` returns a clean usage failure.
- Preserve last-colon parsing unless scoped package handling is replaced deliberately.
- Bundle refs parse on the last `#` and keep `workflowName` separate from the resolved export name.
- The parsed reference is primarily validation/structure; `run-command` still matches legacy package-export ids against discovered workflow ids.
