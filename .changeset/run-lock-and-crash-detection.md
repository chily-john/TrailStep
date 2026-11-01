---
"@trailstep/core": minor
"@trailstep/cli": patch
---

Add a per-run execution lock and make process death observable.

- New `run.lock` artifact (`acquireRunLock` / `releaseRunLock` / `readRunLock` / `isRunLockLive`, exported from `@trailstep/core`) guarantees only one process drives a run directory. Liveness is decided by pid, so a lock left behind by a SIGKILL, OOM or power loss is broken automatically instead of bricking the run. The lock is released on every exit path including `waiting`, so a later `continue` can resume.
- `runWorkflow` now fails with `run_already_active` instead of executing a second concurrent driver over the same `events.jsonl`, `state.json` and agent artifacts. This is what previously happened when an MCP client retried a `trst_resume` whose blocking continue had outlived the transport timeout.
- `failWorkflow` and `cancelWorkflow` tolerate an event-append failure, so the real failure always reaches the caller instead of being replaced by a persistence error.
- The CLI bin now attaches `unhandledRejection` / `uncaughtException` handlers and a `.catch()` on `main()`. Previously an unexpected rejection killed the process silently, leaving the event trail with no terminal event and every observer reporting "in progress" forever.
