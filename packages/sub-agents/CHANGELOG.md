# @trailstep/sub-agents

## 0.3.0

### Minor Changes

- 805dbe9: Add opt-in lean `execution` context (`AgentExecutionConfig`, `resolveAgentExecutionConfig`, `DEFAULT_AGENT_EXECUTION`) on agent steps and workflow roles, rendered through provider `hygiene` capability mappings into `{{tools}}`, `{{skills}}`, `{{mcpArgs}}`, `{{extensionsArgs}}`, and `{{contextFilesArgs}}` argv templates. Wire hygiene placeholders into all four provider manifests (pi, claude, codex, gemini), default every delegate workflow to the lean context, and document flag splitting plus the `project-only` collapse on CLIs without a dedicated project-only flag.

### Patch Changes

- 69db9a9: Retry transient working-agent spawn failures with exponential backoff instead of burning the agent target chain. Windows process-level deaths (e.g. `0xC0000142` `STATUS_DLL_INIT_FAILED`) and resource-exhausted spawn errors are now classified as transient: the format phase is retried in the same session (never re-running Phase 1 work) and failing targets are retried before falling back, with growing jittered delays (default 4 attempts, 2s base, x3, 60s cap) configurable via `settings.spawnRetry`. Failures are now visible the moment they happen: new `agent.attemptFailed` events, an incremental `attempts.json` audit trail per step, and captured spawn `stderr.txt` artifacts. Track state records `ownerPid` so runs left `running` by a dead runner are reported as orphaned instead of silently active.
- Updated dependencies [805dbe9]
- Updated dependencies [69db9a9]
  - @trailstep/authoring@0.3.0

## 0.2.2

### Patch Changes

- @trailstep/authoring@0.2.2

## 0.2.1

### Patch Changes

- 40871ed: Delegate skill descriptions updated to more direct/aggressive language; core working-agent prompts switched to two-phase architecture (work without output shape, then same-session format/reformat with output schema).
  
  Sub-agents (`packages/sub-agents/src/delegate/workflow.ts` + `delegate-parallel/workflow.ts`): all delegate skill descriptions (`delegate`, `delegateExplore`, `delegateSimpleExplore`, `delegateArchitectPlanner`, `delegateReview`, `delegateImplement`, `delegateQuickImplementor`, `delegateSmartImplementor`, `delegateRelentlessDebugger`, `delegateSchemaFormatter`, `delegateParallel`) rewritten from passive "Use as a sub-agent for..." to directive/conditional "Use when you need..." / "Read-only exploration that summarizes findings without editing files." / "When instructions are already concrete..." etc. Skill descriptions and skill focus fields now include explicit parallel recommendations ("If you have 2+ independent tasks, use trst-delegate-parallel instead of calling this sequentially.").
  
  Core (`packages/core/src/agent-execution/working-agent/prompts/build-two-phase-prompts.ts` + artifacts + tests): new two-phase working-agent prompt architecture. Phase 1 (`buildWorkPrompt`) embeds the original prompt with zero mention of output files, JSON, or schemas — avoiding the long-turn domain-JSON problem. Phase 2 (`buildFormatPrompt`) is a pinned same-session follow-up that asks the agent to reformat its last answer to exactly one JSON object matching the strict output schema; includes validation error feedback when needed. New artifact paths: `workFile` (`work.txt`) and `repairPromptFile` (`repair-prompt.md`). Tests verify that work prompts contain the original prompt but no JSON/schema references, and format prompts include the stringified schema, require a single JSON object, and omit validation sections when no errors exist.
- @trailstep/authoring@0.2.1

## 0.2.0

### Minor Changes

- 0390822: Introduce the public sub-agents package with delegate workflows, including the parallel delegate workflow export.
- db93d74: Align the shared agent pool across packages (`planner`, `explorer`, `quick-implementor`, `smart-implementor`, `debugger`, `reviewer`, `expert`, `formatter`, plus `generalist` with demanding-model fallback), extend `trailstep agents explain` to workflow routing (`namespace/name`), re-apply missing package `recommendedConfig` additively on `trailstep update` (never overwriting user values), surface `trailstep doctor` drift warnings, and emit a compact agent routing progress note for working-agent steps.

### Patch Changes

- Updated dependencies [4465267]
- Updated dependencies [432547d]
- Updated dependencies [f6013f5]
- Updated dependencies [796d814]
- Updated dependencies [763827d]
- Updated dependencies [71f0ffe]
- Updated dependencies [64ba8ae]
  - @trailstep/authoring@0.2.0
