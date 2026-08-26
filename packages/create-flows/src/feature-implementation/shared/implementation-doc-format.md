# Implementation doc format

`implementation-doc.md` converts `feature-doc.md` into implementation-ready stories.

Use this structure:

```markdown
# Implementation Plan: <Feature Name>

## Overview for planner/reviewer

Optional high-level planning notes that do not need to be seen by story implementers.

<context>

## Shared Implementation Context

Put every cross-story detail that an implementer may need here: outcome and constraints, architecture/integration notes, tracer-bullet strategy, repository conventions, shared validation commands, edge cases, assumptions, and hard dependency graph notes.

Anything inside this balanced `<context>` block is prepended programmatically to every story by the split-stories step.

</context>

<!-- trailstep-story-boundary -->

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

<!-- trailstep-story-boundary -->

### Story 002: <title>

Dependencies: Story 001

...
```

Rules:

- Text above the first `<!-- trailstep-story-boundary -->` is never read by an implementer unless it is inside a balanced `<context>` ... `</context>` block. The split-stories step prepends all context blocks to every story.
- If a detail applies to most/all stories, put it in `<context>`; if it applies only to selected stories, repeat it inside those stories. No story-critical detail may live only in non-context overview text.
- Every `<context>` marker must have a matching `</context>` marker, and context blocks should be outside story bodies unless there is a deliberate reason to prepend that block to every story. Context markers are recognized only when the marker is the sole non-whitespace content on its line; inline mentions of `<context>` in prose are ignored by the splitter.
- Every story must start right after a `<!-- trailstep-story-boundary -->` line, on its own line, with nothing else on that line. Splitting is mechanical and depends on this exact marker — do not use markdown headings alone to separate stories, and do not add or omit a boundary marker except between/before stories.
- Stories must be topologically ordered.
- Every story must be implementation-ready and self-contained, written as instructions to an implementer who will not see this file, only their own story's content.
- Avoid horizontal stories unless they are embedded in an observable vertical slice.
- Name concrete files/tests/commands when they can be inferred from the repository.
- Preserve uncertainty as assumptions or blocked states instead of guessing.
