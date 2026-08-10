---
kind: rules
paths:
  - packages/cli/src/internals/commands/run/
summary: Run-command parsing, registered refs, bundle refs, direct workflow files, JSON input loading, workflow execution, configured runs-root selection, and success/failure output.
triggers:
  - trailstep run
  - bundle ref
  - input file
  - inline input
  - workflow execution
  - run command
  - TRAILSTEP_RUNS_ROOT
---

# packages/cli/src/internals/commands/run/

Enter here when changing `trailstep <package:workflowExport|registeredRef|package-or-path#workflowName|workflowFile> [workflowRunName]` behavior.

## Files

- `parse-run-invocation.ts`: Change when package workflow ids, direct workflow file refs, optional run names, or legacy `--resume` rejection changes.
- `parse-run-args.ts`: Change when `--input`, `--input-file`, legacy `--resume` rejection, or run options change.
- `generate-run-name.ts`: Change when generated workflow run names change.
- `load-run-input.ts`: Change when JSON input source behavior or CLI input errors change.
- `run-command.ts`: Change when workflow resolution/config/runtime orchestration, runs-root selection, or user-facing success/failure messages change.
- `run-command.types.ts`: Change when run-command parsed argument shapes change.

## Rules

- `--input` and `--input-file` are mutually exclusive and must parse to JSON objects; legacy `--resume` is rejected with a `trailstep retry` hint.
- Missing `.trailstep/config.json` is allowed; core will fail only if a configured agent is actually required.
- Run artifacts use `TRAILSTEP_RUNS_ROOT` when set, otherwise the cwd `.trailstep/runs` default; do not honor migrated runs-root env names.
- Omitting `workflowRunName` generates a slugged run name from the workflow export, timestamp, and random suffix.
- Registered workflow refs come from project/local `.trailstep/config*.json` and global `~/.trailstep/config.json` `workflows`; use `namespace/name`, with `project` then `global` entries also invokable unqualified.
- Bundle refs use `package-or-path#workflowName` and load `trailstep.workflows` manifest targets.
- Direct workflow source refs may be relative or absolute `.ts`, `.mts`, `.js`, or `.mjs` files, extensionless paths, directories with index candidates, or include `#export`; `.tsx` is unsupported.
- Direct workflow sources without `#export` must expose exactly one valid workflow export; use `path#exportName` to select one workflow or bulk add to register multiple workflows.
- `trailstep retry <workflow-ref> <runName>` owns failed-run replay; do not route retries through `runCommand`.
- Preserve process-runner and event-sink injection into `runWorkflow` for tests.
- Keep workflow-not-found as a clean CLI failure, not an uncaught exception.
