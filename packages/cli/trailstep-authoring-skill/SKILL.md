---
name: trailstep-authoring
description: Use when building, reviewing, or architecting TrailStep workflows.
---

# TrailStep authoring skill

Use this skill when authoring durable typed TrailStep workflows, generated workflow skills, or reusable workflow packages.

## Preferred workflow shape

Prefer continuation workflows that expose one clear public entry point:

```ts
import { defineWorkflow, done, fail, shape, step } from "@trailstep/authoring";

const reviewInput = shape<{ readonly topic: string }>({ topic: "string" });
const reviewOutput = shape<{ readonly result: string }>({ result: "string" });

export const review = defineWorkflow({
  id: "review",
  description: "Review a topic and return concise findings.",
  inputShape: reviewInput,
  outputShape: reviewOutput,
  agents: {
    reviewer: {
      size: "medium",
      thinking: "medium",
      description: "Reviews implementation details and reports findings.",
    },
  },
  start(input) {
    return step({ id: "review-topic" })
      .display(({ input }) => ({
        message: `Starting review for ${input.topic}`,
        data: { topic: input.topic },
      }))
      .prompt<typeof input, { readonly result: string }>(
        ({ topic }) => `Review this topic and return JSON findings: ${topic}`,
        { agent: "reviewer", output: reviewOutput },
      )
      .do((output) =>
        output.result.length === 0
          ? fail({ code: "empty_review", message: "Reviewer returned no findings." })
          : done(output),
      )(input);
  },
});
```

Local style may use direct `step(...)` helpers or the builder form. For new workflow code, prefer the builder form when using prompts because it keeps the step id, prompt, output shape, and continuation together.

## Authoring guidance

- Use `defineWorkflow({ start })` for workflow definitions.
- Use `step({ id }).prompt(...).do(...)` for agent-backed steps with structured output.
- Use `step(...)` or local code steps for focused deterministic work that may continue later.
- Use `.display(...)` for user-visible progress, summaries, or context that should be recorded without dispatching agent work.
- Use `.wait(...)` when a workflow needs an external check, human answer, approval, or parent-agent response before continuing.
- Use `done(...)` for completed workflow output.
- Use `fail(...)` for terminal workflow failures with explicit failure codes/messages.
- Use `shape(...)` or `jsonSchema(...)` so workflow inputs and agent outputs are JSON-object contracts.
- Put shared role defaults in workflow-level `agents`.
- Override a single unit of work with step-level `agent` only when needed.
- Keep workflow inputs and outputs as typed JSON object values.

## Pass/fail and review loops

- Model gates as explicit structured outputs, for example `{ "passed": true, "summary": "..." }`.
- Route failed validation/review outputs back to a repair or retry step with the exact failure evidence.
- Use `fail(...)` only when the workflow cannot safely continue or the retry budget/route is exhausted.
- Do not hide failure state in prose; make pass/fail booleans, summaries, and required improvements part of the output shape.
- Keep each step narrow: planning, implementation, validation, and review should usually be separate steps with separate prompts and outputs.

## Generated workflow skills

The optional workflow `skill` block customizes generated agent skill metadata:

```ts
export const summarize = defineWorkflow({
  id: "summarize",
  description: "Summarize a request.",
  skill: {
    description: "Use when an agent needs to summarize a request.",
    instructions: "Capture the request faithfully and recommend one concrete next step.",
  },
  start(input) {
    // ...
  },
});
```

TrailStep appends generated CLI usage, input-file, and schema instructions when creating workflow skills. Raw skill markdown that starts with YAML frontmatter keeps that frontmatter exactly; raw markdown without frontmatter is wrapped in generated `name`/`description` frontmatter before the custom body.

## Packaging reusable workflows

- Export workflows from the package entrypoint.
- Keep reusable behavior in workflow source and package exports, not generated run directories.
- If a published workflow imports markdown prompt fragments, bundle them into the workflow entrypoint or ship copied assets at the exact runtime paths used by the built bundle.
- Use direct refs while developing, registered refs for stable local/team names, and bundle refs for installed packages.

Reference forms:

- `./workflows/review.ts#review`
- `project/review`
- `@acme/workflows#review`
