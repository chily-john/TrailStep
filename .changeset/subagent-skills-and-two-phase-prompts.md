---
"@trailstep/sub-agents": patch
"@trailstep/core": minor
---

Delegate skill descriptions updated to more direct/aggressive language; core working-agent prompts switched to two-phase architecture (work without output shape, then same-session format/reformat with output schema).

Sub-agents (`packages/sub-agents/src/delegate/workflow.ts` + `delegate-parallel/workflow.ts`): all delegate skill descriptions (`delegate`, `delegateExplore`, `delegateSimpleExplore`, `delegateArchitectPlanner`, `delegateReview`, `delegateImplement`, `delegateQuickImplementor`, `delegateSmartImplementor`, `delegateRelentlessDebugger`, `delegateSchemaFormatter`, `delegateParallel`) rewritten from passive "Use as a sub-agent for..." to directive/conditional "Use when you need..." / "Read-only exploration that summarizes findings without editing files." / "When instructions are already concrete..." etc. Skill descriptions and skill focus fields now include explicit parallel recommendations ("If you have 2+ independent tasks, use trst-delegate-parallel instead of calling this sequentially.").

Core (`packages/core/src/agent-execution/working-agent/prompts/build-two-phase-prompts.ts` + artifacts + tests): new two-phase working-agent prompt architecture. Phase 1 (`buildWorkPrompt`) embeds the original prompt with zero mention of output files, JSON, or schemas — avoiding the long-turn domain-JSON problem. Phase 2 (`buildFormatPrompt`) is a pinned same-session follow-up that asks the agent to reformat its last answer to exactly one JSON object matching the strict output schema; includes validation error feedback when needed. New artifact paths: `workFile` (`work.txt`) and `repairPromptFile` (`repair-prompt.md`). Tests verify that work prompts contain the original prompt but no JSON/schema references, and format prompts include the stringified schema, require a single JSON object, and omit validation sections when no errors exist.
