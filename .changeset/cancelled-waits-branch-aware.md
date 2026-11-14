---
"@trailstep/core": patch
"@trailstep/cli": patch
"@trailstep/mcp": patch
---

A `step.cancelled` now terminates the matching pending wait for answerability and continuation. `listPendingWaits` resolves a wait only when a later `step.cancelled` has the same `stepId` and branch identity, where an absent branch is the implicit root branch. Cancelling one parallel branch no longer resolves a same-id wait on another branch, and a cancellation never erases a wait that started after it. The scheduler now decorates `step.cancelled` with real branch provenance, and `trailstep cancel` emits one branch-attributed cancellation per pending wait instead of an unscoped cancellation for only the latest wait.

A legacy `step.cancelled` without branch identity cannot be attributed to a parallel branch. `listPendingWaits` withholds that branch wait instead of resolving an arbitrary branch, and the new `listWaitCancellationAmbiguities` projection lets CLI and MCP answer report the ambiguity and refuse to write an answer. `trailstep answer` and `trst_answer` now evaluate waits in the current lifecycle cycle and report the legacy ambiguity instead of guessing.

Behaviour change: a cancelled wait is no longer answerable or continuable. `trailstep cancel` followed by `trailstep continue` now clears the pending cancellation marker, then fails closed with `Run is not waiting`; recovery is through `trailstep retry`, which re-enters the cancelled step and parks on a fresh wait. The core cancellation integration test now proves this retry recovery path. Watch/classifier projections no longer present a cancelled or legacy-ambiguous wait as pending.
