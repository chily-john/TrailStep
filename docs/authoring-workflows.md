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

The workflow file defines the public boundary: id, description, optional generated-skill metadata, input shape, output shape, agent roles, and start continuation.

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
  skill: {
    description: "Use when an agent needs to summarize a feature request.",
    instructions: "Capture the user's request faithfully and recommend one concrete next step.",
  },
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

The optional `skill` block customizes generated workflow skill frontmatter and guidance. Generated TrailStep usage, input-file, schema, and run-command instructions are still appended automatically.

## Core primitives

- `defineWorkflow(...)`: defines the exported workflow boundary and returns a callable workflow value. Calling that value creates a workflow-invocation continuation.
- `shape(...)`: validates simple JSON-object inputs/outputs with string, number, and boolean fields.
- `jsonSchema(...)`: validates richer JSON Schema shapes.
- `step({ id })`: defines a durable continuation step.
- `.prompt(...)`: dispatches that step to an agent.
- `.do(...)`: receives the step output and returns the next continuation.
- `done(...)`: completes the current workflow invocation or branch successfully. In a sequential workflow this is also the workflow result.
- `fail(...)`: completes the current branch as a failure without dispatching another step.
- `absoluteDone(...)`: completes the entire track successfully and cancels sibling branches. Use this only for exceptional track-wide short-circuiting.
- `absoluteFail(...)`: fails the entire track and cancels sibling branches.
- `state`: branch-local durable state for the current continuation path.
- `globalState`: track-shared durable state for coordination between parallel branches.

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

## Parallel tracks and callable workflows

`defineWorkflow(...)` returns a callable workflow value. Use the object as the exported workflow definition, or call it from another workflow/step to create a workflow-invocation continuation:

```ts
return ImplementStoryWorkflow(
  { storyId: story.id, cwd: input.cwd },
  {
    branch: `story-${story.id}`,
    onDone: (output) => ReviewStoryWorkflow({ storyId: story.id, implementation: output }),
  },
);
```

Workflow invocation options currently include:

- `branch?: string`: a requested stable branch name. Persisted branch ids are the ids to use for retry/inspection; when names collide, TrailStep keeps the requested name as `requestedBranchId` metadata and assigns unique persisted branch ids such as `branch-1`.
- `onDone?: (output) => ContinuationResult`: a follow-up continuation for the same branch when the invoked workflow returns `done(...)`.

A continuation may return an array of runnable branch candidates to split work:

```ts
return readyStories.map((story) =>
  ImplementStoryWorkflow({ storyId: story.id }, { branch: `story-${story.id}` }),
);
```

Arrays replace the current branch with queued child branches. They are not a reducer/fan-in primitive. Array entries must be runnable step nodes or workflow invocation nodes; return `done(...)`, `fail(...)`, `absoluteDone(...)`, or `absoluteFail(...)` directly instead of placing them in an array.

Normal `done(output)` finishes the current workflow invocation or branch. If a workflow invocation has `onDone`, TrailStep passes the validated output to that callback and continues the same branch. The whole track completes when all branches are terminal unless a failure policy or absolute terminal ends it earlier. Use `absoluteDone(...)` or `absoluteFail(...)` only when one branch should terminate the entire track and cancel siblings.

`state` remains branch-local. Sibling branches do not see each other's `state` values. Use `globalState` for shared coordination:

```ts
const next = await globalState.update("stories", (current) => claimReadyStory(current));
```

`globalState.update(...)` is atomic within the running TrailStep scheduler/process, so it is safe for concurrent foreground workers in one command. It is not a cross-daemon or multi-process lock; future daemon/process support may strengthen that scope. Prefer `update(...)` over `get(...)` plus `set(...)` for claims, counters, and other read-modify-write coordination.

TrailStep does not prevent two branches from using the same cwd or editing the same files. Workflow authors remain responsible for avoiding file conflicts, for example by passing distinct cwd/worktree inputs or coordinating through `globalState`.

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
