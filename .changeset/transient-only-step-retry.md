---
"@trailstep/core": minor
---

Make automatic step retry transient-only.

Automatic step retry now re-runs a step only when its failure is classified as
transient (`step_timeout`, `agent_provider_unavailable`, `agent_provider_failed`,
`agent_provider_spawn_error`, `agent_provider_timeout`, or a failure explicitly
marked retryable). Every other failure — including new failure codes that are
not on the transient allowlist — is permanent and fails on the first attempt
with the same event trail as before. A `step.attemptFailed` event is emitted
only when a retry actually follows.

The retry policy gains an optional `retryOn?: "transient" | "always"` setting
(step > workflow > global, default `"transient"`) so a step, workflow, or
global configuration can opt into retrying every failure.
