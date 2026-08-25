# Authoring workflows

TrailStep workflows are TypeScript modules that export workflow definitions. The recommended model is the continuation model: `defineWorkflow({ ... start })`, `step(...)`, and `done(...)`.

## Install authoring packages

```bash
npm install @trailstep/authoring @trailstep/core
```

Use the equivalent command for your package manager if you use `pnpm`, `yarn`, or `bun`.

## Recommended file shape

Keep workflow entrypoints small and move step logic into separate files:

```text
workflows/
  feature-summary.schema.ts
  feature-summary.workflow.ts
  steps/
    summarize-request.step.ts
```

Shared schemas keep the workflow boundary and step implementation clean:

```ts
// workflows/feature-summary.schema.ts
import { shape } from "@trailstep/authoring";

export type FeatureSummaryInput = {
  readonly request: string;
};

export type FeatureSummaryOutput = {
  readonly summary: string;
  readonly nextStep: string;
};

export const featureSummaryInput = shape<FeatureSummaryInput>({
  request: "string",
});

export const featureSummaryOutput = shape<FeatureSummaryOutput>({
  summary: "string",
  nextStep: "string",
});
```

The workflow file defines the public boundary: id, description, input shape, output shape, agent roles, and start continuation.

```ts
// workflows/feature-summary.workflow.ts
import { defineWorkflow } from "@trailstep/authoring";
import {
  type FeatureSummaryInput,
  type FeatureSummaryOutput,
  featureSummaryInput,
  featureSummaryOutput,
} from "./feature-summary.schema.js";
import { summarizeRequestStep } from "./steps/summarize-request.step.js";

export const featureSummary = defineWorkflow<FeatureSummaryInput, FeatureSummaryOutput>({
  id: "feature-summary",
  description: "Summarize a feature request and suggest one next step.",
  inputShape: featureSummaryInput,
  outputShape: featureSummaryOutput,
  agents: {
    summarizer: {
      size: "medium",
      thinking: "medium",
      description: "Summarizes feature requests for planning.",
    },
  },
  start(input) {
    return summarizeRequestStep(input);
  },
});
```

A step file owns one focused unit of work. Export the built step as a `const`, then call it with input from the workflow or previous step.

```ts
// workflows/steps/summarize-request.step.ts
import { done, promptSections, section, step } from "@trailstep/authoring";
import {
  type FeatureSummaryInput,
  type FeatureSummaryOutput,
  featureSummaryOutput,
} from "../feature-summary.schema.js";

function summarizeRequestPrompt({
  input,
}: {
  readonly input: FeatureSummaryInput;
}): string {
  return promptSections(
    section("Feature request", input.request),
    section(
      "Task",
      "Summarize the request in two or three sentences, then recommend exactly one next step.",
    ),
  );
}

export const summarizeRequestStep = step({ id: "summarize-request" })
  .prompt<FeatureSummaryInput, FeatureSummaryOutput>(summarizeRequestPrompt, {
    agent: "summarizer",
    output: featureSummaryOutput,
  })
  .do((output) => done(output));
```

## Core primitives

- `defineWorkflow(...)`: defines the exported workflow boundary.
- `shape(...)`: validates simple JSON-object inputs/outputs with string, number, and boolean fields.
- `jsonSchema(...)`: validates richer JSON Schema shapes.
- `step({ id })`: defines a durable continuation step.
- `.prompt(...)`: dispatches that step to an agent.
- `.do(...)`: receives the step output and returns the next continuation.
- `done(...)`: completes the workflow successfully.
- `fail(...)`: completes the workflow as a failure without dispatching another step.

## Working and interactive steps

Prompt steps default to working-agent mode. Use interactive mode when a step needs the user's live input or attention:

```ts
export const clarifyRequirementsStep = step({ id: "clarify-requirements" })
  .prompt(
    () => "Ask the user clarifying questions until the feature request is clear.",
    { mode: "interactive", output: shape<{ conversation: string }>({ conversation: "string" }) },
  )
  .do((output) => nextStep(output));
```

Use `trailstep continue` to continue waiting or interrupted interactive work.

## Retry and timeout

Retry and timeout config belongs on `step(...)`, not `.prompt(...)`:

```ts
step({
  id: "review-plan",
  retry: { maxAttempts: 2 },
  timeout: { seconds: 600 },
})
  .prompt(...)
  .do(...);
```

## Agent roles

Workflows can describe agent roles at the workflow level, then use those roles from steps:

```ts
export const reviewWorkflow = defineWorkflow({
  id: "review",
  agents: {
    reviewer: {
      size: "large",
      thinking: "high",
      description: "Reviews the change set for correctness and risk.",
    },
  },
  start(input) {
    return reviewStep(input);
  },
});
```

```ts
step({ id: "review" })
  .prompt(renderPrompt, { agent: "reviewer", output: reviewShape })
  .do(handleReview);
```

## Prompt fragments

For local source workflows, prompt helpers such as `loadFragments`, `promptSections`, and `section` can keep prompts readable.

For published workflow packages, prefer bundling markdown prompt fragments into the entrypoint so installed packages do not rely on runtime file paths. With `tsup`, raw markdown imports plus the text loader work well:

```ts
import methodology from "./methodology.md?raw";

const promptFragment = methodology.trimEnd();
```

```json
{
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --sourcemap --clean --loader .md=text"
  }
}
```

## Register and skill-enable a workflow

Run direct refs while developing:

```bash
trailstep ./workflows/feature-summary.workflow.ts#featureSummary --input '{"request":"Add CSV export."}'
```

Register them when they should have stable names:

```bash
trailstep add ./workflows/feature-summary.workflow.ts#featureSummary --scope project --name feature-summary --project-skill
trailstep project/feature-summary --input '{"request":"Add CSV export."}'
```

Use `--project-skill` for team-shared agent skills and `--user-skill` for personal agent skills.
