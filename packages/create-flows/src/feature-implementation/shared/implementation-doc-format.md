# Implementation doc format

`implementation-doc.md` converts `feature-doc.md` into implementation-ready stories.

Use this structure:

```markdown
# Implementation Plan: <Feature Name>

## Overview for planner/reviewer

Optional high-level planning notes that do not need to be seen by story implementers.

<context>
audience: implementer
stories: all
phases: explore-story

## Shared Implementer Exploration Context

Put only cross-story details that an implementer needs during story exploration: outcome constraints, architecture/integration notes, repository conventions, shared validation command hints, assumptions, and hard dependency graph notes. Do not put reviewer-only instructions, full implementation-doc process guidance, or unrelated story details here.

Scoped context blocks are stored separately from story bodies. They are not prepended to every split story. The router passes matching implementer context only to the narrow phase that needs it.

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

- Text above the first `<!-- trailstep-story-boundary -->` is never part of an active story body. Only scoped `<context>` ... `</context>` blocks with recognized metadata can be selected as separate phase context.
- Context blocks must begin with metadata lines before the first blank line. Recognized keys are `audience: implementer|reviewer|all`, `stories: all|Story 001|Story 001: Title`, and `phases: all|explore-story|write-red-tests|implement-green|validate-story|review-story-implementation`.
- Unscoped context blocks are ignored instead of being blindly prepended to every story. If a detail applies to only one story, prefer putting it directly in that story. No story-critical detail may live only in non-context overview text.
- Every `<context>` marker must have a matching `</context>` marker. Context markers are recognized only when the marker is the sole non-whitespace content on its line; inline mentions of `<context>` in prose are ignored by the splitter.
- Every story must start right after a `<!-- trailstep-story-boundary -->` line, on its own line, with nothing else on that line. Splitting is mechanical and depends on this exact marker — do not use markdown headings alone to separate stories, and do not add or omit a boundary marker except between/before stories.
- Stories must be topologically ordered.
- Every story must be implementation-ready and self-contained, written as instructions to an implementer who will not see this file, only their own story's content.
- Avoid horizontal stories unless they are embedded in an observable vertical slice.
- Name concrete files/tests/commands when they can be inferred from the repository.
- Preserve uncertainty as assumptions or blocked states instead of guessing.
