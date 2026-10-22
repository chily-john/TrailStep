---
"@trailstep/core": patch
"@trailstep/cli": patch
"@trailstep/provider-pi": patch
---

Split the remaining large modules into focused ones, and align the CLI's
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
