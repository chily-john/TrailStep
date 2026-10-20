---
"@trailstep/core": minor
"@trailstep/authoring": minor
"@trailstep/sub-agents": minor
"@trailstep/provider-claude": minor
"@trailstep/provider-codex": minor
"@trailstep/provider-gemini": minor
"@trailstep/provider-pi": minor
"@trailstep/cli": patch
---

Add opt-in lean `execution` context (`AgentExecutionConfig`, `resolveAgentExecutionConfig`, `DEFAULT_AGENT_EXECUTION`) on agent steps and workflow roles, rendered through provider `hygiene` capability mappings into `{{tools}}`, `{{skills}}`, `{{mcpArgs}}`, `{{extensionsArgs}}`, and `{{contextFilesArgs}}` argv templates. Wire hygiene placeholders into all four provider manifests (pi, claude, codex, gemini), default every delegate workflow to the lean context, and document flag splitting plus the `project-only` collapse on CLIs without a dedicated project-only flag.
