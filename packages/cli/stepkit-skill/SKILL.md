---
name: stepkit
description: Use when authoring, installing, or running StepKit workflows with the StepKit CLI.
---

# StepKit usage skill

Use StepKit to author, install, discover, run, continue, and retry durable typed coding-agent workflows from npm packages or project files.

## CLI quick start

- Install the packaged StepKit skill and create local config with `stepkit init`.
- List available workflows with `stepkit workflows`.
- Run a workflow with a JSON input file: `stepkit <workflow-ref> --input-file .stepkit/inputs/input.json`.
- Continue waiting or interrupted runs with `stepkit continue`.
- Retry failed work with `stepkit retry`; retry instead of inventing a separate resume mechanism.

## Author continuation workflows

Prefer continuation workflows that expose one clear public entry point:

```ts
import { defineWorkflow, done, step } from "@stepkit/authoring";

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

StepKit accepts these workflow reference forms:

- direct refs such as `./workflows/review.ts#review`
- registered refs such as `project/review`
- bundle refs such as `@acme/workflows#review`

Use direct refs for local files, registered refs for named project or user workflows, and bundle refs for exported workflows from installed packages.

## Safety and run artifacts

- do not manually edit `.stepkit/runs`.
- local run artifacts are runtime outputs, not source of truth.
- Use `stepkit continue` for normal continuation and `stepkit retry` for failed steps instead of adding a custom resume path.
- Keep reusable workflow behavior in workflow source and package exports, not in generated run directories.
