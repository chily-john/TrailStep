---
"@trailstep/core": minor
"@trailstep/cli": patch
"@trailstep/authoring": patch
---

Enable durable continue and retry for answered parallel-track waits.

- `runWorkflow` continue on a run whose root start is a parallel track now resolves answered parallel branches via persisted branch answers (`findAnsweredParallelBranches`, now exported from `@trailstep/core`); with no answered branch yet it re-parks on the pending wait instead of failing, and with an answered branch it resumes that branch through branch-scoped replay.
- Check waits are self-evaluating: a continue with no answered branch but a pending `check` wait resumes that branch so the check re-runs, while input waits park answer-less on the pending wait.
- Branch-scoped wait resumes resolve the waiting step node out of the workflow start continuation tree (parallel nodes, continuation arrays, derived branch ids, invoked-workflow branches) and replay from that node (`ResumeWaitOptions.startNode`, `replayCompletedSteps({ startNode })`); the first answered branch replay is reused for the `workflow.resumed` emit instead of replaying twice, and a branch-scoped replay failure surfaces as resume validation instead of being silently skipped.
- A branch parking into `waiting` no longer cancels its sibling branches on the same track (parallel-track and root-continuation-array schedulers), so multiple branches can hold durable waits concurrently.
- `findLatestPendingWait` is branch-aware (`findLatestPendingWait(events, branchId)`); events without a branch belong to the implicit root branch.
- `trailstep continue` (and `answer --continue`) gates on answered parallel branches first, mirroring the runtime: once a split-track branch has its answer artifact, continue resumes it instead of gating on the latest pending wait's missing answer.

Also removes the deprecated `@trailstep/authoring` `defineWorkflowOriginal` re-export shim (the authoring package now re-exports `defineWorkflow` from `@trailstep/core` directly).
