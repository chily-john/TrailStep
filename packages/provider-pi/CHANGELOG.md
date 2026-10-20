# @trailstep/provider-pi

## 0.3.0

### Minor Changes

- 805dbe9: Add opt-in lean `execution` context (`AgentExecutionConfig`, `resolveAgentExecutionConfig`, `DEFAULT_AGENT_EXECUTION`) on agent steps and workflow roles, rendered through provider `hygiene` capability mappings into `{{tools}}`, `{{skills}}`, `{{mcpArgs}}`, `{{extensionsArgs}}`, and `{{contextFilesArgs}}` argv templates. Wire hygiene placeholders into all four provider manifests (pi, claude, codex, gemini), default every delegate workflow to the lean context, and document flag splitting plus the `project-only` collapse on CLIs without a dedicated project-only flag.

## 0.2.0

### Minor Changes

- 322bb12: Add `followUp` support to the pi provider manifest (`sessionIdFlag: --session-id`, `resumeArgs` with `--session {{sessionId}}`). This enables the core two-phase working-agent flow: Phase 1 runs the work prompt, Phase 2 resumes the same pi session to reformat the report into the strict output schema, so long implement turns no longer fail output validation after doing the work.

## 0.1.1

### Patch Changes

- 05fcb88: Publish provider-agnostic runtime support, provider package registration flows, and official provider packages.
