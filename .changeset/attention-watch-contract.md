---
"@trailstep/core": minor
"@trailstep/mcp": minor
---

`@trailstep/mcp` `trst_watch` is now a blocking wait-for-attention call: it returns `started`, `in-progress`, `waiting`, `terminal` or `crashed`, and the compact result carries `output`, `waits`, `failure`, `crash` or `progress`. It adds the `maxWaitMs` and `waitFor` parameters and sanitizes control characters in progress notifications.

Clients that send a progress token can block for up to 5 minutes; clients without one are capped at 25 seconds and get an in-progress snapshot to call again, reported by `effectiveWaitMs`.

`@trailstep/core` exports `listPendingWaits` for the `waiting` state.
