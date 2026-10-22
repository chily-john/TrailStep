---
name: trailstep-authoring
description: Use when building, reviewing, or architecting TrailStep workflows.
---

# TrailStep authoring skill

Use this skill when authoring durable typed TrailStep workflows or reusable workflow packages.

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

### Retries

- Configure retries per step with the step `retry` option, per workflow, or globally via settings.
- Defaults: `maxAttempts: 2` and `retryOn: "transient"` — one automatic retry on transient failures only; set `maxAttempts: 1` to disable retries or `retryOn: "always"` to retry every failure.

## Pass/fail and review loops

- Model gates as explicit structured outputs, for example `{ "passed": true, "summary": "..." }`.
- Route failed validation/review outputs back to a repair or retry step with the exact failure evidence.
- Use `fail(...)` only when the workflow cannot safely continue or the retry budget/route is exhausted.
- Do not hide failure state in prose; make pass/fail booleans, summaries, and required improvements part of the output shape.
- Keep each step narrow: planning, implementation, validation, and review should usually be separate steps with separate prompts and outputs.

## Parallel fan-out and join

- Use `parallel(...)` with a continuation array of branch nodes for durable fan-out.
- Use `.post(...)` on the parallel node to join once branches settle; the post continuation receives `{ status, branches }` keyed by branch id.
- Pick `failurePolicy: "fail-fast"` (default) to stop the fan-out when one branch fails, or `failurePolicy: "all-settled"` to let every branch settle before joining.
- Express fan-out as a continuation array consumed by `parallel(...)`, not as a hand-rolled array reduction; pair it with `.post(...)` for the durable join.
- Prefer durable `parallel(...)` + `.post(...)` over in-step fan-out with `subPrompt(...)` + `Promise.all`: sub-prompt fan-out is not durable across waits, retries, or restarts, while the parallel node replays through the continuation runtime.

## Retry and timeouts

- Put retry config on `step(...)`: `retry: { maxAttempts?: number, retryOn?: "transient" | "always" }`, alongside `timeout: { seconds }`.
- Defaults: `maxAttempts: 2` and `retryOn: "transient"` — only transient failures (timeouts, provider unavailability/failure/spawn errors) are retried; deterministic failures (schema violations, invalid continuations, exhausted agent targets) fail on the first attempt.
- Retry policy resolves field by field with precedence step > workflow (`Workflow.retry` / per-workflow settings) > global (`settings.retry`); use `retryOn: "always"` only for idempotent work and `maxAttempts: 1` to disable automatic retries.
- Retried attempts emit `step.attemptFailed`; the terminal `step.failed` event fires exactly once when the budget or route is exhausted.

## Parallel fan-out and joins

- `parallel(nodes, { concurrency?, failurePolicy? }).post((aggregate) => ...)` runs an array of runnable nodes (steps or workflow invocations) as sibling branches and joins them in `post()` once every branch settles.
- The join receives `{ status: "completed", branches }` keyed by persisted branch id.
- Default `failurePolicy: "fail-fast"`: each branch contributes its raw output, and a branch failure terminalizes the track immediately, so `post()` runs only after every branch succeeds.
- `failurePolicy: "all-settled"`: every branch settles; each entry is `{ status, output?, message?, failure? }`, so failures reach `post()` instead of stopping the track.
- Returned arrays split the current branch into child branches; they are not a reducer — combining results happens in `post()`, and `concurrency` caps how many branches run at once.
- For lightweight fan-out inside one step, combine `subPrompt(...)` calls with `Promise.all(...)`; that concurrency lives within a single step and does not survive resume. Use `parallel(...).post(...)` when the fan-out must be durable across interruption and retry.
- Coordinate across branches with `globalState.update(...)` (atomic within one scheduler process); `state` stays branch-local.

## Execution context and inputs

- Execution blocks merge field by field with precedence step > workflow config (`workflows.<id>.settings.execution`) > global config (`settings.execution`) > the role's own block; `contextFiles` defaults to `true`, and an invalid config block fails fast with an error naming its config path.
- Stringified scalars in caller-supplied run inputs are coerced against `inputShape` when unambiguous (plain decimal strings to numbers, exact `true`/`false` to booleans, recursed through objects and arrays); ambiguous strings are left untouched so validation fails as written. The coerced value is what the run persists.

## Workflow skill metadata

The optional workflow `skill` block customizes agent skill metadata for packaged workflow skills:

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

TrailStep does not generate per-workflow skills anymore; workflow source keeps the optional `skill` metadata for packaged skill consumers. For agent workflow discovery, use the TrailStep MCP server (`trst_*` tools).

## Packaging reusable workflows

- Export workflows from the package entrypoint.
- Keep reusable behavior in workflow source and package exports, not generated run directories.
- If a published workflow imports markdown prompt fragments, bundle them into the workflow entrypoint or ship copied assets at the exact runtime paths used by the built bundle.
- Use direct refs while developing, registered refs for stable local/team names, and bundle refs for installed packages.

Reference forms:

- `./workflows/review.ts#review`
- `project/review`
- `@acme/workflows#review`
