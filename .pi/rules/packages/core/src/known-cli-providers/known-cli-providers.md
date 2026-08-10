---
kind: rules
paths:
  - packages/core/src/known-cli-providers/
summary: Built-in CLI provider registry, stdout envelope extraction, and provider-specific command adapters.
triggers:
  - known CLI provider
  - provider registry
  - claude provider
  - codex provider
  - pi provider
  - gemini provider
---

# packages/core/src/known-cli-providers/

Enter here when changing TrailStep-owned knowledge about named local CLI providers. These adapters spawn vendor CLIs; they are not in-process vendor SDK integrations.

## Subdirectories

- `envelopes/`: Enter when changing extraction of structured output or usage metadata from provider stdout.
- `providers/`: Enter when changing provider-specific command names, argv construction, interactive mode, thinking mapping, or stdout/file-output behavior.
- `process/`: Enter when changing provider CLI command resolution before spawn.
- `registry/`: Enter when changing the built-in provider set or provider adapter contracts.

## Rules

- Registry keys are user-facing `.trailstep/config.json` provider ids; changing them is a config compatibility decision.
- Keep provider process invocation knowledge isolated here; generic working/interactive orchestration belongs in `agent-execution/`.
- Resolve `shell: false` provider spawns through `process/` so Windows npm shims do not force shell prompt parsing.
- Preserve the distinction between providers that write `outputFile` themselves and providers whose stdout must be parsed and written by the adapter.
