# Story implementation contract

The story loop works one story at a time. Each story is self-contained. You will not see non-context overview text or other stories; you will see only the active story plus any shared `<context>` content prepended by the split-stories step.

## Protect pre-existing uncommitted work

Run `git status --short` before making any change.

- The preferred execution mode is a StepKit-created isolated worktree/branch. In that mode, a successful review is followed by an automatic story commit, so the next story starts from a clean diff boundary.
- Treat every pre-existing uncommitted file as protected — it may be unfinished human work, another run's in-progress work, or a sign that isolation failed.
- Do not run destructive cleanup: no `git reset`, `git checkout --`, broad `git clean`, or equivalent revert/format-away operations.
- Do not delete or rewrite unrelated chunks in a file that already has changes.
- If this story requires editing a file that is already dirty, preserve the existing changes and make only the minimal additional change the story requires.
- If dirty work makes the story ambiguous or blocked, stop and report a blocked state instead of removing it.
- Do not create git commits yourself unless the story explicitly requires it. StepKit creates the reviewed story commit after the reviewer passes the story when auto-commit mode is enabled.

## Implementer responsibilities

- Implement only the current story and required dependency-compatible adjustments. Do not start later stories.
- Use strict behavioral-red TDD: write or update a focused failing behavioral test first, confirm it fails for the intended reason when feasible, implement the smallest change to pass it, then refactor only after it's green.
- Run the story's validation commands before reporting completion when feasible.
- Do not report success until implementation and focused validation are done, or until a true blocked state is reached — report the blocker clearly instead of pretending the story is complete.

## Reviewer responsibilities

- Review only the active story diff from the recorded story baseline through HEAD plus the current uncommitted diff. Do not try to review every dirty change in the checkout as global context.
- Inspect with read-only commands only (`git status --short`, the exact `git diff <storyStartCommit>..HEAD` command supplied in your prompt, and `git diff`). Do not run tests or other commands — the implementer is responsible for passing focused validation; this is an AI-only review.
- Never edit code, delete files, revert files, run cleanup, stage files, commit files, or otherwise modify the working tree to isolate your review.
- If unrelated dirty files, missing baseline information, or overlapping changes make the active story diff unreviewable, return a failing structured review that explains the isolation problem instead of changing the repository.
- Review against: the story's acceptance criteria, TDD evidence and test quality, vertical-slice completeness, tracer-bullet alignment where applicable, minimal scope with no gold-plating, and integration with existing architecture/project conventions.

## Completion

A story is complete when code is changed as needed, behavioral tests exist, focused validation passes according to the implementer, and the implementation is well integrated with the existing architecture.
