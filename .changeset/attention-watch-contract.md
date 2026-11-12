---
"@trailstep/core": minor
"@trailstep/mcp": minor
---

`@trailstep/mcp` `trst_watch` is now a blocking wait-for-attention call: one call blocks until the run settles, needs an answer, new events arrive, or the budget expires, and it returns `started`, `in-progress`, `waiting`, `terminal` or `crashed`. The compact result carries whichever of `output`, `waits`, `failure`, `crash` or `progress` applies; a cancelled run may carry none of them. It adds the `maxWaitMs` and `waitFor` parameters and sanitizes control characters in progress notifications. State now comes from the shared `@trailstep/core` run-state classifier rather than a watch-local event scan: a stale run and a canonical `unknown` run are both reported `crashed`, with `crash.code` preserving the difference (`no-live-process` vs `unknown-run-state`), while an event-less run whose track reports a live owner stays `started`. A live run lock now outranks absent or unusable track evidence, so a run held by a live process is `started` or `in-progress` even when `track.json` is missing, malformed or oversized; `unknown` now means there is neither a live lock nor usable track evidence. The crash payload carries the classifier's diagnostic message (for a stale run, the stale-owner message), and a watch whose signal is already aborted returns its entry snapshot instead of a spurious crash.

With a progress token a call can block for up to 5 minutes, and the client may treat progress notifications as a keep-alive. Without one the call is capped at 25 seconds and returns a snapshot whose state depends on the run to call again, reported by `effectiveWaitMs`.

`@trailstep/core` exports `listPendingWaits` for the `waiting` state.
