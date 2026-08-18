---
kind: rules
paths:
  - packages/core/src/runtime/artifacts/
summary: Local/default run roots, event JSONL, state JSON, and `.trailstep` gitignore artifact helpers.
triggers:
  - run storage
  - events.jsonl
  - state.json
  - .trailstep runs
  - runsRoot
  - duplicate run name
---

# packages/core/src/runtime/artifacts/

Enter here when changing how runtime artifacts are created, read, or written under the default or configured runs root.

## Rules

- `defaultRunsRoot(cwd)` is the canonical `.trailstep/runs` path; explicit runs roots are allowed, run names must be non-empty single path segments, and duplicate requested run names should create suffixed run ids rather than overwrite existing directories.
- `events.jsonl` is append-only during execution; preserve partial trailing-line tolerance for reading interrupted runs.
- Missing `state.json` should read as an empty object.
- Keep generated `.trailstep` artifacts ignored by default while preserving `.trailstep/.gitignore` itself.
- Step artifact directories use an execution index plus sanitized step id and hold prompt, output, usage, interactive protocol, and session-description files.
