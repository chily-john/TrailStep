---
"@trailstep/core": patch
---

Terminate agent child processes reliably before continuing.

- New shared `terminateChildProcessTree` (awaited everywhere it is used) replaces three divergent fire-and-forget copies. On Windows the `taskkill /T /F` child is awaited; on POSIX the process group gets `SIGTERM` and is escalated to `SIGKILL` after a grace period. Previously a timed-out step rejected immediately and the replacement agent could start while the previous one was still running, so both wrote `output.json` and the step failed with an unretryable `agent_output_invalid_json`.
- All agent child processes are tracked in a live-children registry and killed from a `process.once("exit")` hook, so a killed or crashed runner no longer orphans agents against an abandoned run directory.
- Timeout paths wait (bounded) for the child to exit before throwing, so the caller's next action never races a live process.
- `AgentAdapter` requests gain an optional `AbortSignal`, and `submit_output` results are now recorded per round instead of into one shared variable. A slow first round can no longer satisfy the second round's structured-output request. No default adapter timeout is introduced.
