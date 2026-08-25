# @trailstep/authoring

`@trailstep/authoring` provides TypeScript helpers for writing TrailStep workflows. Most workflow authors should start here rather than using `@trailstep/core` directly.

## Install

```bash
npm install @trailstep/authoring @trailstep/core
```

Use the equivalent command for your package manager if you use `pnpm`, `yarn`, or `bun`.

## What this package is for

Use this package to author continuation workflows with:

- `defineWorkflow({ start })` as the workflow boundary.
- `step(...)` for focused units of agent or local work.
- `.prompt(...).do(...)` for agent-backed steps with structured output.
- `done(...)` and `fail(...)` for terminal continuations.
- `shape(...)` or `jsonSchema(...)` for JSON-object validation.
- prompt helpers such as `promptSections`, `section`, `loadFragments`, and `promptTemplate`.

## Basic pattern

Keep workflow entrypoints small and put step logic in separate files as workflows grow.

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

Run direct refs while developing:

```bash
trailstep ./workflows/feature-summary.workflow.ts#featureSummary --input '{"request":"Add CSV export."}'
```

Register stable refs when the workflow should be shared:

```bash
trailstep add ./workflows/feature-summary.workflow.ts#featureSummary --scope project --name feature-summary --project-skill
trailstep project/feature-summary --input '{"request":"Add CSV export."}'
```

## Packaging prompt fragments

If a published workflow imports markdown prompt fragments, prefer bundling them into the workflow entrypoint so the installed package has no runtime file-path assumptions. With `tsup`, use raw imports plus the text loader:

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

Add a declaration for TypeScript:

```ts
declare module "*.md?raw" {
  const content: string;
  export default content;
}
```

`loadFragments(import.meta.dirname, ...)` is useful for local source workflows or packages that deliberately ship copied asset files, but publishable bundled workflow packages must either inline those fragments or include copied assets in `files` at the exact runtime paths used by the built bundle.

## More docs

- [Authoring workflows](../../docs/authoring-workflows.md)
- [Generated skills](../../docs/generated-skills.md)
- [CLI reference](../../docs/cli-reference.md)
