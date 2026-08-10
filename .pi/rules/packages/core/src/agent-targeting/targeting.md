---
kind: rules
paths:
  - packages/core/src/agent-targeting/
summary: `.stepkit/config.json` parsing, retry/timeout settings validation, and authoritative role/size/default target resolution for agents.
triggers:
  - stepkit config
  - agent target
  - agents
  - workflows agents
  - customProviders
  - role resolution
  - settings
  - timeout
---

# packages/core/src/agent-targeting/

Enter here when changing how local `.stepkit/config.json` is parsed or how workflow agent roles resolve to concrete working/interactive targets.

## Rules

- Config version must be `1`; `customProviders` and top-level `agents` are required objects; top-level and workflow `settings` are optional objects whose `retry` must be an object contributing only `maxAttempts` and `timeout` must be a number when present; empty retry objects are omitted so lower-precedence policies still apply.
- A target `provider` resolves against the built-in provider registry first, then falls back to `customProviders`; a provider matching neither is an `agent_provider_unknown` config failure.
- Resolved targets concatenate workflow role mapping, then top-level role-size mapping, then top-level `default`; skip empty mappings and fail only when all are empty.
- `agents` is shared by working and interactive modes; workflow-specific overrides live under `workflows.<id>.agents`, with workflow settings under `workflows.<id>.settings`.
- Agent mapping entries are plain arrays; elements may be literal provider targets or `{ ref }` entries that expand from top-level `agents` only.
- Top-level `agents` keys are reusable mapping names, including role sizes and `default`; thinking values are `low`, `medium`, `high`, `xhigh`, and `max`.
- Do not accept legacy `customAgents`, `workingAgents`, or `interactiveAgents` fallbacks.
- Keep parse diagnostics user-facing because CLI config loading surfaces them directly.
