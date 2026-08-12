---
kind: rules
paths:
  - packages/cli/src/internals/commands/workflows/
summary: `stepkit workflows` command output and interactive drill-in edit/remove flow.
triggers:
  - stepkit workflows
  - list workflows
  - discovered workflows
---

# packages/cli/src/internals/commands/workflows/

Enter here when changing `stepkit workflows` behavior. The command always runs the interactive flow — there is no plain non-interactive listing mode and no `--edit` flag.

## Rules

- Keep list output machine-readable and stable unless README/tests change with it.
- Do not duplicate discovery filtering rules here; update `internals/discovery` for package/workflow selection behavior.
- Do not duplicate registry read/write logic here; update `../../workflow-registry/workflow-registry.js` for metadata-aware enumeration, delete, move/rename, or duplicate-detection behavior shared with `add`/`remove`.
- Scope cannot be changed from this flow (only namespace/name within the existing scope) — remove and re-add to move a registration across scopes.
