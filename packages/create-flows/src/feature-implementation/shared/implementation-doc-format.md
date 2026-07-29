# Implementation doc format

`implementation-doc.md` converts `feature-doc.md` into implementation-ready stories.

Use this structure:

```markdown
# Implementation Plan: <Feature Name>

## Outcome and Constraints

## Architecture / Integration Notes

## Tracer Bullet Strategy

Describe the thinnest end-to-end behavior that should be built first to prove the risky seams.

## Story Dependency Graph

List each story and its hard dependencies. Dependencies are hard only when a story cannot pass its own tests until another story is finished.

<!-- stepkit-story-boundary -->

### Story 001: <title>

Dependencies: none

#### Goal

#### User-Visible / Integration-Visible Slice

#### Acceptance Criteria

#### Red Phase

- Test file:
- Test case:
- Expected failing assertion:

#### Green Phase

#### Refactor Phase

#### Validation Commands

#### Notes for Implementer

<!-- stepkit-story-boundary -->

### Story 002: <title>

Dependencies: Story 001

...
```

Rules:

- Everything above the first `<!-- stepkit-story-boundary -->` is overview only — it is never read by an implementer. If an implementer needs to know it (architecture notes, file paths, local conventions, validation commands, edge cases, assumptions, blocked states, acceptance details), repeat it inside every story that depends on it.
- Every story must start right after a `<!-- stepkit-story-boundary -->` line, on its own line, with nothing else on that line. Splitting is mechanical and depends on this exact marker — do not use markdown headings alone to separate stories, and do not add or omit a boundary marker except between/before stories.
- Stories must be topologically ordered.
- Every story must be implementation-ready and self-contained, written as instructions to an implementer who will not see this file, only their own story's content.
- Avoid horizontal stories unless they are embedded in an observable vertical slice.
- Name concrete files/tests/commands when they can be inferred from the repository.
- Preserve uncertainty as assumptions or blocked states instead of guessing.
