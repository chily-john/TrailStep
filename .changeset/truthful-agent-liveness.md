---
"@trailstep/core": minor
---

Make agent heartbeats report real liveness and add an opt-in stall timeout.

- `step.progress` heartbeats now report wall-clock elapsed time plus `outputBytes`, `msSinceLastOutput`, `pid` and `exited` from a shared `AgentProgressTracker`, instead of a self-incremented counter that looked healthy while a provider CLI was wedged. Existing `data.heartbeat` / `data.elapsedMs` keys are unchanged.
- New `agent.stalled` event (emitted at most once per attempt) when a configured `stallTimeout` elapses with no child output and no exit.
- New opt-in `stallTimeout` setting, resolvable at global / workflow / step scope with step > workflow > global precedence and validated like `timeout`. There is deliberately no built-in default: existing workflows are unaffected.
- The stall timeout only observes and reports in this release. It does not abort the attempt; `onStall` is the hook a future change can wire to termination.
