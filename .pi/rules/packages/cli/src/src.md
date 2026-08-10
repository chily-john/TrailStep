---
kind: rules
paths:
  - packages/cli/src/
summary: Source and tests for the `trailstep` CLI entrypoint, command internals, agent-config initialization/helpers, workflow registration, interactive continuation, retry/run-summary commands, doctor deprecation scanning, update command/deprecation preflight, and skill checks.
triggers:
  - CLI source
  - CLI tests
  - trailstep binary
  - command output
  - command registry
---

# packages/cli/src/

Enter here when implementing or testing command-line behavior. `index.ts` is both executable entrypoint and public module barrel; keep command behavior injectable so tests do not depend on process globals.

## Subdirectories

- `internals/`: Enter when changing command registration, add/init/agents/continue/workflows/run/runs/retry/cancel/doctor/update/skill-check command logic, update deprecation preflight, agent-config initialization/helpers, discovery, config loading, input loading, retry handling, or workflow-id parsing.

## Rules

- Preserve `main(options)` injection seams for cwd, home directory, env, IO, text/select/multi-select/confirm prompts, event sinks, interactive process runners, working-agent process runners, skills CLI resolution/process running, package command running, deprecation manifests, and run-name determinism.
- Expected CLI errors handled by `main` print their message and nested `Error.cause` messages; unexpected errors stay thrown.
- New behavior belongs in `internals/command-registry.ts` and command implementations; keep `index.ts` focused on entrypoint wiring and public re-exports.
- Keep run-command output tied to actual `runWorkflow` results and run directories.
- CLI tests should clear TrailStep environment variables before running.
