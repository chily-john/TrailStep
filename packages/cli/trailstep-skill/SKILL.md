---
name: trailstep
description: Use when authoring, installing, or running TrailStep workflows with the TrailStep CLI.
---

# TrailStep usage skill

Use TrailStep to author, install, discover, run, continue, and retry durable typed coding-agent workflows from npm packages or project files.

## CLI quick start

- Install the packaged TrailStep skill and create local config with `trailstep init`.
- List available workflows with `trailstep workflows`.
- Run a workflow with a JSON input file: `trailstep <workflow-ref> --input-file .trailstep/inputs/input.json`.
- Continue waiting or interrupted runs with `trailstep continue`.
- Retry failed work with `trailstep retry`; retry instead of inventing a separate resume mechanism.

## Author continuation workflows

Prefer continuation workflows that expose one clear public entry point:

```ts
import { defineWorkflow, done, step } from "@trailstep/authoring";

export const review = defineWorkflow({ start });

function start(input: { readonly topic: string }) {
  return step("review", { input, agent: "reviewer" }, ({ result }) => done({ result }));
}
```

Authoring guidance:

- Use `defineWorkflow({ start })` for workflow definitions.
- Use `step(...)` for agent or tool work that may continue later.
- Use `done(...)` for completed workflow output.
- Put shared role defaults in workflow-level `agents`.
- Override a single unit of work with step-level `agent` only when needed.
- Workflow inputs should be JSON object values; write an object to the file passed with `--input-file`, not raw prose or arrays.

## Workflow refs

TrailStep accepts these workflow reference forms:

- direct refs such as `./workflows/review.ts#review`
- registered refs such as `project/review`
- bundle refs such as `@acme/workflows#review`

Use direct refs for local files, registered refs for named project or user workflows, and bundle refs for exported workflows from installed packages.

## Safety and run artifacts

- do not manually edit `.trailstep/runs`.
- local run artifacts are runtime outputs, not source of truth.
- Use `trailstep continue` for normal continuation and `trailstep retry` for failed steps instead of adding a custom resume path.
- Keep reusable workflow behavior in workflow source and package exports, not in generated run directories.
