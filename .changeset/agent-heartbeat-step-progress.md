---
"@trailstep/core": minor
---

Wire the agent heartbeat into agent-backed step execution and emit `step.progress` heartbeats for long-running steps.

- `startAgentHeartbeat` (interval from `TRAILSTEP_AGENT_HEARTBEAT_INTERVAL_MS`, default 60s, `0` disables) is now wired into the agent step dispatch seam: it starts before dispatch and stops in a `finally` around the working-agent command / adapter step execution, so it clears on success, failure, and abort.
- Long-running agent steps now emit best-effort `step.progress` heartbeat events so agents and people watching a workflow run know the step is still alive; interactive-mode steps are intentionally excluded (they already emit their own session events).
- `startAgentHeartbeat` and `AgentHeartbeat` are exported from `@trailstep/core`.

No changes to workflow authoring APIs or persisted event schemas.
