---
"@trailstep/sub-agents": patch
---

Compose delegate workflow MCP tool descriptions from shared task/context sentences.

- All delegate workflow variants (`delegate`, `delegateExplore`, `delegateSimpleExplore`, `delegateArchitectPlanner`, `delegateReview`, `delegateImplement`, `delegateQuickImplementor`, `delegateSmartImplementor`, `delegateRelentlessDebugger`, `delegateSchemaFormatter`) now build their `description` through one `delegateWorkflowDescription` composer that carries the required task semantics, the optional context guidance, the mode behavior, the turn budget, the summarize flag, the worktree option, and the watch/answer/continue question loop.
- The composed string is the whole `defineWorkflow` description that the generated per-workflow MCP tool JSON publishes, so every variant now states the same question-loop contract (`watch` with `trst_watch`, answer with `trst_answer`, continue with `trst_resume`) and the same task/context/mode/turns/summarize/worktree semantics instead of each hand-writing its own sentence.

No changes to delegate execution behavior or persisted run schemas.
