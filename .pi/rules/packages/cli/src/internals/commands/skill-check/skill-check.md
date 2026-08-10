---
kind: rules
paths:
  - packages/cli/src/internals/commands/skill-check/
summary: `stepkit skill-check` reporting for discovered workflow packages missing `SKILL.md`.
triggers:
  - stepkit skill-check
  - missing SKILL.md
  - workflow package skill
  - skill detection
---

# packages/cli/src/internals/commands/skill-check/

Enter here when changing how the CLI verifies companion skill documentation for discovered workflow packages.

## Rules

- Keep grouping package-based, not workflow-export based, so a package with multiple workflows produces one report line.
- Preserve sorted workflow ids in reports for stable test output.
- This command depends on discovery output; change discovery filtering in `internals/discovery/`, not here.
