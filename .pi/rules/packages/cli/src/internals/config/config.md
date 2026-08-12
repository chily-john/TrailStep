---
kind: rules
paths:
  - packages/cli/src/internals/config/
summary: User/project `.trailstep/config.json` loading, project-local overrides, workflow registry extraction, and CLI-facing config validation errors.
triggers:
  - .trailstep config
  - ~/.trailstep config
  - CLI config error
  - loadTrailStepConfig
  - agent config
---

# packages/cli/src/internals/config/

Enter here when changing how the CLI reads user/project/project-local TrailStep config before workflow execution or extracts project/user-registered workflow refs.

## Rules

- Missing user/project/project-local config returns `undefined`; code-only workflows and adapter-provided tests must still run without config.
- Invalid JSON or core validation failures become `CliConfigError` so `main()` returns exit code `1` with a readable message.
- Config shape and provider/target diagnostics are owned by `@trailstep/core`; this layer should format, not duplicate, validation policy.
- `.trailstep/config.json` and `.trailstep/config-local.json` may register workflow refs as string targets under `workflows`; expose only project-scope registrations via `loadTrailStepProjectConfig` while passing only core config data to validation.
- `~/.trailstep/config.json` contributes run config and user workflow registry entries; use the `homeDir` option on `loadTrailStepConfig` or `loadTrailStepProjectConfig` when tests need to isolate it. There is no `~/.trailstep/config-local.json` — local overrides only exist at the project scope.
- Effective run config merges in precedence order: user, project, then project-local. Top-level keys are replaced by the later scope, except `agents` merges by agent entry name; `workflows` is replaced for run config while project/project-local registry strings merge by namespace bucket.
