---
"@trailstep/core": minor
"@trailstep/mcp": minor
---

`@trailstep/mcp` `trst_watch` is now a blocking wait-for-attention call: one call blocks until the run settles, needs an answer, new events arrive, or the budget expires, and it returns `started`, `in-progress`, `waiting`, `terminal` or `crashed`. The compact result carries whichever of `output`, `waits`, `failure`, `crash` or `progress` applies; a cancelled run may carry none of them. It adds the `maxWaitMs` and `waitFor` parameters and sanitizes control characters in progress notifications. An event-less trail with no live run lock is now reported `crashed` once it is older than a 10-second startup grace window instead of reporting `started` forever.

With a progress token a call can block for up to 5 minutes, and the client may treat progress notifications as a keep-alive. Without one the call is capped at 25 seconds and returns a snapshot whose state depends on the run to call again, reported by `effectiveWaitMs`.

`@trailstep/core` exports `listPendingWaits` for the `waiting` state.
