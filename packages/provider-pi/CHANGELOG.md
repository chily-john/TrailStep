# @trailstep/provider-pi

## 0.3.1

### Patch Changes

- 51d35f5: Split the remaining large modules into focused ones, and align the CLI's
  official-provider capability metadata with the provider package manifests.
  
  `@trailstep/core` splits the resume replay
  (`runtime/resume/replay-to-waiting-step/`) into the replay entry point, the
  wait-event helpers, and the waiting-step phase prefix replay. The resume
  behavior and the emitted event trail are unchanged.
  
  `@trailstep/cli` splits `commands/update/update-command.ts`,
  `internals/mcp-tools/mcp-registration.ts` and
  `commands/agents/agents-setup-wizard.ts` into focused modules (preflight
  scanning, recommended config, dependency install, MCP server command, agent
  target detection, add-mcp request, manual fallback text, scope prompts, named
  agent flow, workflow role flow). The public behavior, prompts and help output
  are unchanged.
  
  The provider package manifest is the single source of truth for a provider
  CLI's capabilities. The CLI's `officialProviderSpecFor()` table now mirrors it
  (model support, model discovery, thinking support and thinking levels), the Pi
  provider manifest declares its `pi --list-models` discovery spec, and a new
  `official-providers` test pins the agreement between the CLI table and the
  `@trailstep/provider-*` manifests.

## 0.3.0

### Minor Changes

- 805dbe9: Add opt-in lean `execution` context (`AgentExecutionConfig`, `resolveAgentExecutionConfig`, `DEFAULT_AGENT_EXECUTION`) on agent steps and workflow roles, rendered through provider `hygiene` capability mappings into `{{tools}}`, `{{skills}}`, `{{mcpArgs}}`, `{{extensionsArgs}}`, and `{{contextFilesArgs}}` argv templates. Wire hygiene placeholders into all four provider manifests (pi, claude, codex, gemini), default every delegate workflow to the lean context, and document flag splitting plus the `project-only` collapse on CLIs without a dedicated project-only flag.

## 0.2.0

### Minor Changes

- 322bb12: Add `followUp` support to the pi provider manifest (`sessionIdFlag: --session-id`, `resumeArgs` with `--session {{sessionId}}`). This enables the core two-phase working-agent flow: Phase 1 runs the work prompt, Phase 2 resumes the same pi session to reformat the report into the strict output schema, so long implement turns no longer fail output validation after doing the work.

## 0.1.1

### Patch Changes

- 05fcb88: Publish provider-agnostic runtime support, provider package registration flows, and official provider packages.
