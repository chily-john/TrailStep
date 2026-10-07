---
"@trailstep/core": minor
"@trailstep/cli": patch
---

Branch-scoped parallel wait-continue (Gaps 3+4) with branch-keyed parallel waits (Gaps 1+2).

Gaps 1+2 (c0d78f5): decorateBranchEvent decorates wait.started/satisfied/failed with branchId+stepIndex on split tracks; waitEventKey/findPendingWaitsById/waitEventBranchId branch-aware with root fallback; trailstep answer accepts --branch and errors on ambiguous bare answers.

Gaps 3+4 (594ac0b): replayToWaitingStep extended with optional branch scope {branchId, stepIndex} and readBranchRunState hydration; run-workflow.ts isWaitContinue replaces blanket guard with routing — resumes every waiting branch having recorded answer.json through root-continuation-array-scheduler restore (mirror retry path ~L971, never rebuild); unanswered branches stay waiting; done/failed/cancelled siblings never re-execute; CLI command.types.ts usageText documents --branch.

Verification: core 389 tests pass; new co-located tests added; full E2E verified (delegate v4); regression verified clean (non-parallel paths unchanged); build green.
