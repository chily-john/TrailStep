# Story implementation contract

The story loop works one story at a time. Each story is self-contained — you will not see the overview or other stories, only this one.

## Protect pre-existing uncommitted work

Run `git status --short` before making any change.

- Treat every pre-existing uncommitted file as protected — it may be unfinished human work or a previous run's in-progress work.
- Do not run destructive cleanup: no `git reset`, `git checkout --`, broad `git clean`, or equivalent revert/format-away operations.
- Do not delete or rewrite unrelated chunks in a file that already has changes.
- If this story requires editing a file that is already dirty, preserve the existing changes and make only the minimal additional change the story requires.
- If dirty work makes the story ambiguous or blocked, stop and report a blocked state instead of removing it.

## Implementer responsibilities

- Implement only the current story and required dependency-compatible adjustments. Do not start later stories.
- Use strict behavioral-red TDD: write or update a focused failing behavioral test first, confirm it fails for the intended reason when feasible, implement the smallest change to pass it, then refactor only after it's green.
- Run the story's validation commands before reporting completion when feasible.
- Do not report success until implementation and focused validation are done, or until a true blocked state is reached — report the blocker clearly instead of pretending the story is complete.

## Reviewer responsibilities

- Inspect the working tree with read-only commands only (`git status --short`, `git diff --stat`, `git diff`). Do not run tests or other commands — the implementer is responsible for passing focused validation; this is an AI-only review.
- Review against: the story's acceptance criteria, TDD evidence and test quality, vertical-slice completeness, tracer-bullet alignment where applicable, minimal scope with no gold-plating, and integration with existing architecture/project conventions.
- Do not edit code.

## Completion

A story is complete when code is changed as needed, behavioral tests exist, focused validation passes according to the implementer, and the implementation is well integrated with the existing architecture.
