---
"@trailstep/core": patch
---

Harden the parallel scheduler and retry classification.

- The continuation-array scheduler no longer swallows a thrown branch. Previously a `persistBranch` or runtime failure rejected a non-awaited promise chain after the outer promise may already have resolved, which could report a track as completed while a branch had actually failed. A thrown branch now produces a `branch_failed` terminal result and still unblocks the scheduler's worker accounting; a thrown error that already carries a structured failure (such as the scheduler's own step-budget guard) keeps that code instead of being flattened.
- The `maxSteps` guard throws `TrailStepFailureError` with code `max_steps_exceeded` and structured details instead of a bare `Error` that surfaced as `step_execution_failed`.
- `step.attemptFailed` now reports `agentDispatches`, the cumulative number of provider dispatches a step has caused, making retry amplification (step retries × fallback targets × format attempts × spawn retries) visible. No cap is imposed and no retry default changed: the format-phase budget stays at 3 attempts, and measuring amplification before bounding it is deliberate — a cap chosen without data would either be useless or break legitimate long-running retries.
- Five output-corruption codes (`agent_output_invalid_json`, `agent_output_unreadable`, `agent_provider_output_invalid`, `interactive_output_invalid`, `interactive_output_incomplete`) are now retryable under the default `retryOn: "transient"`. They are frequently caused by a race (truncated write, competing writer) rather than a deterministic schema violation, and a genuine schema violation still fails on the retry. `validation_failed`, `agent_target_exhausted` and every unknown code remain permanent.
- Resume-integrity failures now use structured failure codes (`resume_replay_invalid_phase_order`, `resume_replay_missing_step_output`, `resume_replay_missing_do_phase`) with an actionable `details.hint`, instead of bare developer-facing `Error` messages.
