# Parallel tracks, callable workflows, and branch-oriented execution

Status: Implementation notes and remaining design anchor. The first implementation is foreground-only and supports root/continuation arrays, callable workflow invocations, branch artifacts, branch retry filters, and in-process global state.

## Purpose

TrailStep currently executes one continuation path at a time: a workflow starts, returns a step, that step returns the next continuation, and eventually the run completes, fails, waits, or is retried. That model is durable and simple, but it does not express large agent orchestration well. For long-horizon coding work we need workflows that can split into independent branches, run several agents/workflows concurrently, share durable coordination state, and still remain observable and retryable.

The target model is not a small fan-out/fan-in helper. `subPrompt(...)` already covers small fan-out tasks inside one step. This design is for larger branches of work: multiple delegate workflows, implementation stories, reviewers, unblockers, and follow-up workflows that may overlap in time and coordinate through shared track state rather than a single parent reducer.

## Glossary

- **Track**: the durable top-level execution container. A track owns global events, global state, branch records, child artifacts, final aggregate output, cleanup metadata, and retry history. The user-facing run id can continue to name the track for compatibility.
- **Branch**: one active continuation path within a track. A branch can execute a step, invoke a workflow, split into more branches, wait, complete, fail, or be retried.
- **Workflow invocation**: a callable workflow started inside a branch. Invocations can be root or nested, but TrailStep should not treat the root branch as semantically special.
- **Local state**: the existing `state` API. It remains scoped to the current branch/run context and should not become shared implicitly.
- **Global state**: new track-scoped durable state, exposed as `globalState`, with atomic update support for cross-branch coordination.
- **Terminal branch result**: a branch outcome produced by normal `done(...)`, failure, cancellation, or an absolute track terminal.

## Goals

1. Allow continuation code to return arrays of continuation tasks so multiple branches can run concurrently.
2. Make workflows callable in authoring code, similar to step factories: `SomeWorkflow(input)` should return a workflow invocation continuation.
3. Preserve the simple meaning of `done(...)` for authors: `done(...)` completes the current branch. The track completes when all branches have terminal outcomes, subject to failure policy.
4. Add track-level terminal helpers for exceptional cases: `absoluteDone(...)` and `absoluteFail(...)` terminate the whole track and cancel siblings.
5. Add `globalState` with atomic `update(...)` for story claiming and other cross-branch coordination.
6. Keep the first implementation foreground-owned: no daemon yet. A `trailstep` command owns scheduling while it is running; daemonization can be added later against the same artifacts.
7. Make branch status, latest messages, waits, and outputs visible from one watch/run view so agents and humans can inspect active work without manually opening every child run.
8. Support retrying the whole track, failed branches, and individual branches without re-running already completed successful branches by default.
9. Treat storage cleanup at the track level so branch artifacts, state, and event references stay consistent.

## Current implementation limits

- There is no daemon/service. A foreground `trailstep` run/retry/continue command owns scheduling only while that command is running.
- Scheduling is foreground and worker-pool based. A waiting, failed, cancelled, or absolute-terminal branch currently terminalizes the track under fail-fast semantics rather than letting all other active branches continue indefinitely.
- Continuation arrays are accepted only when every array entry is a runnable step node or workflow invocation node. Arrays containing `done(...)`, `fail(...)`, `absoluteDone(...)`, or `absoluteFail(...)` are rejected. Return those nodes directly instead.
- Nested workflow invocations are supported inside a branch, including `.post(...)` follow-up continuations, but branch spawning still uses persisted branch metadata and deterministic generated branch ids rather than making requested `branch` names authoritative.
- Retry filters support default unresolved-work retry, `--failed`, `--branch <branchId>`, and `--fresh`. Branch-specific retry requires a persisted branch id from branch metadata; requested branch names are recorded as `requestedBranchId` only.
- `globalState.update(...)` is atomic inside the in-process scheduler/queued run context. It is not yet a daemon-safe or cross-process file lock contract.
- Events remain the existing workflow/step event stream. Branch metadata is currently added to relevant step events, and `track.json` plus `branches/*.json` provide branch status/outputs; dedicated `track.*`/`branch.*` lifecycle event names are not emitted yet.
- No implicit file conflict prevention. Authors remain responsible for coordinating cwd/file overlap.

## Non-goals for the first implementation wave

- No background daemon/service in the initial implementation. The scheduler is driven by foreground run/retry/continue commands.
- No implicit file conflict prevention. Authors remain responsible for coordinating cwd/file overlap. TrailStep may provide optional worktree helpers, locks, and clear documentation, but concurrent mutation conflicts are not prevented by default.
- No mandatory fan-in node. Authors can build fan-in workflows if they want, but arrays of continuations should not imply a reducer-style parent step.
- No special root-output behavior. Track output should aggregate all terminal branch outcomes; users can build a root-controller workflow if they want root-specific semantics.

## Authoring model

### Callable workflows

`defineWorkflow(...)` should return a value that is both a workflow definition and a callable invocation factory.

Example:

```ts
export const ImplementStoryWorkflow = defineWorkflow<ImplementStoryInput, ImplementStoryOutput>({
  id: "implement-story",
  inputShape: implementStoryInput,
  outputShape: implementStoryOutput,
  start(input) {
    return implementStoryStep(input);
  },
});
```

Authors should be able to invoke the workflow directly inside continuations:

```ts
return ImplementStoryWorkflow({
  ...input,
  storyId: story.id,
});
```

The call returns an internal workflow invocation continuation node. Authors should not need to manually construct a `childWorkflow(...)` wrapper.

Workflow invocation options should support branch naming, while follow-up continuations are attached with `.post(...)`:

```ts
return ImplementStoryWorkflow(
  { storyId: story.id },
  { branchId: `story-${story.id}` },
).post((output) => ReviewStoryWorkflow({ storyId: story.id, implementation: output }));
```

Recommended initial option names:

- `branchId?: string`: requested stable branch id/name. TrailStep may suffix or reject collisions according to deterministic replay rules.
- Future-compatible room for worktree or cwd options, but cwd can continue to be specified at workflow/step input level where existing workflows already support it.

Use `.post((output) => nextContinuation)` to extend a pre-existing workflow with custom follow-up steps/workflows after it completes successfully.

### Arrays of continuations

Any step or workflow invocation continuation should be able to return an array of runnable continuation tasks:

```ts
return readyStories.map((story) =>
  ImplementStoryWorkflow({ ...input, storyId: story.id }, { branchId: `story-${story.id}` }),
);
```

An array means: enqueue all returned tasks as runnable branches, subject to worker limits. The current branch is replaced by those tasks. There is no implicit fan-in reducer.

Arrays should initially accept runnable tasks only:

- `StepNode`
- workflow invocation nodes

Avoid supporting arrays containing `done(...)`, `fail(...)`, or absolute terminal nodes initially unless there is a clear runtime rule. A normal branch can still return `done(...)` directly.

### `done(...)`, `absoluteDone(...)`, and `absoluteFail(...)`

Normal `done(output)` completes the current branch or current workflow invocation. If an invocation has a `.post(...)` continuation, TrailStep passes the typed workflow output to that continuation instead of marking the branch terminal.

Track completion is computed by the scheduler:

- if any branch is queued/running/waiting, the track is still active;
- if every branch is terminal and there are no unhandled failures, the track completes successfully with aggregate output;
- if branches failed, the track outcome follows the configured failure policy.

Add explicit track terminals for exceptional cases:

```ts
return absoluteDone({ result: "found-answer" });
return absoluteFail({ code: "blocked", message: "Cannot continue safely." });
```

`absoluteDone(...)` completes the whole track and cancels siblings. `absoluteFail(...)` fails the whole track and cancels siblings.

### Global state

Keep existing `state` local. Add a separate `globalState` export for track-shared coordination:

```ts
const claimed = await globalState.update("stories", (stories) => {
  return claimReadyStories(stories, { limit: 2 });
});
```

Initial API:

```ts
globalState.get<T>(key: string): Promise<T | undefined>;
globalState.set(key: string, value: unknown): Promise<void>;
globalState.update<T>(key: string, updater: (current: T | undefined) => T | Promise<T>): Promise<T>;
```

`update(...)` is atomic across concurrent workers in the current foreground scheduler through the queued in-process run context. Design future daemon/process concurrency as a stronger contract; do not assume today's implementation is a cross-process lock.

Story-claiming workflows should use `globalState.update(...)`, not `get` + `set`, to avoid duplicate branch claims.

## Runtime and scheduler semantics

The current runtime loop has evolved into a foreground scheduler that owns a track while a command is running; there is still no background daemon.

Scheduler responsibilities:

1. Initialize a track and root branch from the user workflow input.
2. Maintain a durable branch queue.
3. Execute up to `workers` branches concurrently.
4. Assign step artifact indexes and branch artifact paths without collisions.
5. Interpret branch continuations:
   - step node: continue branch with that step;
   - workflow invocation node: start/continue that invocation in the branch;
   - array: replace branch with queued sibling branches;
   - done: terminal branch result or invocation `.post(...)` continuation;
   - fail: branch failure subject to failure policy;
   - absolute terminal: terminate track.
6. Persist enough branch state to resume or retry without duplicating completed work.
7. Stop when the track is terminal, waiting for external input, cancelled, or failed according to policy.

### Workers

Default worker count should mirror Playwright-style defaults:

```ts
workers = Math.max(1, Math.floor(os.availableParallelism() / 2));
```

Allow overrides through CLI/config later, e.g. `--workers 4` and workflow concurrency settings.

### Waiting behavior without daemon

Because there is no daemon initially, the foreground scheduler should pause/return when external user/parent-agent input is needed. When a branch waits, the CLI should print the track dashboard: active branches, waiting branches, latest branch messages, and answer/continue instructions.

A future daemon can allow other branches to keep running while one branch waits, but the first implementation can conservatively pause the track on waits to keep parent-agent interaction understandable.

## Events and observability

The user and parent agent need one clean view of active work. Add branch-aware event payloads and terminal output support.

Actual first implementation event strategy:

- Existing `workflow.started`, `workflow.retryStarted`, `step.started`, `step.completed`, `workflow.completed`, and `workflow.failed` events remain the compatibility surface.
- Parallel execution persists track/branch state in `track.json` and `branches/<branchId>.json`.
- `step.started` and `step.completed` events for split branches are decorated with `payload.trackId`, `payload.branchId`, optional `payload.requestedBranchId`, and branch-local step artifact fields.
- Dedicated `track.*`, `branch.*`, and `workflow.invocation*` events are still design candidates, not current emitted events.

`trailstep runs` and `trailstep runs --json` summarize persisted track metadata. A richer terminal/watch view could summarize:

```text
Track: create-flows-123

Branches
  story-auth              running    Implementing auth story
  story-dashboard         waiting    parent-answer: Should I alter the API shape?
  review-runtime          done       Found 3 risks; output available
  story-storage           failed     Provider usage limit
```

Current run summaries combine branch records with branch-decorated step events to show latest branch status/message/failure/output where available. Dedicated branch display/progress event correlation remains future work.

## Track output

Track output should aggregate terminal branch outcomes. The root branch should not be special by default.

Suggested shape:

```json
{
  "status": "completed",
  "branches": {
    "story-auth": {
      "status": "done",
      "workflowId": "implement-story",
      "output": {}
    },
    "story-dashboard": {
      "status": "failed",
      "workflowId": "implement-story",
      "failure": {
        "code": "provider_usage_limit",
        "message": "..."
      }
    }
  }
}
```

If the workflow has an explicit output shape, decide whether to validate this aggregate track output against that shape or introduce a separate track output shape. The implementation should preserve backward compatibility for single-branch workflows where possible.

## Retry and resume

Usage limits and interrupted agents are expected. Branch-level persistence is mandatory.

Persist at minimum per branch:

```ts
{
  branchId,
  parentBranchId?,
  workflowId?,
  workflowInput?,
  invocationStack?,
  status: "queued" | "running" | "waiting" | "done" | "failed" | "cancelled",
  latestStepIndex,
  currentContinuationFingerprint?,
  output?,
  failure?,
  createdAt,
  updatedAt
}
```

Retry modes:

- `trailstep retry <workflow-ref> <runName>`: retry unresolved track work while preserving successful branch outputs by default.
- `trailstep retry <workflow-ref> <runName> --failed`: retry failed branches only while preserving cancelled branches.
- `trailstep retry <workflow-ref> <runName> --branch <branchId>`: retry one persisted branch id.
- `trailstep retry <workflow-ref> <runName> --fresh`: start a new run/track from the original root input.

Avoid blindly restarting all live branches. Completed branches should stay completed unless the user requests a fresh retry or explicitly selects them.

Replay rule for branch spawning: when a branch returns an array, the spawned branches must get stable identities so retry/resume does not duplicate them. The current implementation records explicit `branch` options as `requestedBranchId` metadata and assigns unique persisted ids (`root`, `branch-1`, `branch-2`, ...). Retry and summaries use the persisted ids.

## Storage layout and cleanup

Track should be the cleanup unit. Do not delete branch artifacts independently unless a future compactor can rewrite references safely.

Current layout uses a track-level run directory:

```text
.trailstep/runs/<trackId>/
  track.json
  events.jsonl
  global-state.json
  branches/
    <branchId>.json
    <branchId>.state.json
  steps/
    <artifactStepId>/
  artifacts/
```

Future layouts may add per-branch subdirectories, locks, or output indexes if compaction/daemon support requires them.

The exact layout can vary, but it must support:

- reading a full track summary without scanning every large artifact where possible;
- branch-level retry and status inspection;
- preserving existing single-run output behavior where possible;
- storage lifecycle commands treating the track as one unit;
- pin/archive/delete/prune operations at track level;
- safe handling of managed worktrees and cleanup metadata.

Cleanup commands should account for:

- completed tracks older than policy;
- failed/cancelled tracks older than policy;
- pinned tracks never deleted;
- archived tracks optionally compressed/moved;
- interrupted/stale running tracks;
- managed worktrees retained, removed, failed, or dirty.

## Worktrees and cwd

File conflicts are author-managed. TrailStep should not forbid two branches from using the same cwd or files, because there are legitimate scenarios for that.

However, TrailStep should make isolation easy. Existing workflows can already accept cwd/worktree input. A future workflow invocation option may also request a managed worktree derived from the parent cwd, but this is not required for the first scheduler slice.

## Failure policy

Initial default should be conservative: unhandled branch failure fails the track or marks the track failed when branches settle. However, create-flows-style workloads often want collection semantics. Support failure policy through workflow config or invocation options later:

- `failFast`: first unhandled branch failure cancels siblings and fails the track.
- `collect`: record branch failures, keep other branches running, and report aggregate output/failures at the end.

Even with `collect`, `absoluteFail(...)` must fail the entire track immediately.

## Implementation slices

The implementation should be done linearly in focused runs, not as one massive workflow.

### Slice 1: Authoring API and types

Scope:

- callable `defineWorkflow(...)` return type;
- workflow invocation node shape;
- continuation arrays in public types;
- `absoluteDone(...)` and `absoluteFail(...)` public helpers/types;
- workflow invocation options including `branch` plus fluent `.post(...)` continuations;
- exports through `@trailstep/core` and `@trailstep/authoring`;
- type/runtime tests that prove authoring syntax produces recognizable nodes.

Do not implement the full scheduler in this slice. It is acceptable for runtime to reject new node kinds with clear errors until Slice 2.

Acceptance example:

```ts
return [
  SomeStep(input),
  SomeWorkflow({ value: 1 }),
  ExistingWorkflow(input, { branch: "existing-plus-followup" }).post((output) =>
    FollowupStep(output),
  ),
];
```

### Slice 2: Track/branch scheduler runtime

Scope:

- track/branch persistence model;
- foreground scheduler with worker pool;
- arrays spawn parallel branches;
- normal `done(...)` completes branches;
- `.post(...)` routes workflow output into another continuation;
- aggregate track output with branch outcomes;
- branch-aware events;
- single-branch backward compatibility tests.

### Slice 3: Global state, retry, CLI observability, and storage cleanup

Scope:

- `globalState.get/set/update` with atomic update semantics;
- branch retry filters (`--failed`, `--branch`, `--fresh`);
- watch/run dashboard for branch tree/latest messages/waits;
- storage lifecycle commands treating tracks as cleanup units;
- documentation for concurrency, conflicts, and retry workflows.

## Open decisions for implementers to resolve explicitly

1. Whether public `Workflow<TInput, TOutput>` remains object-like with a callable intersection type, or whether a new `DefinedWorkflow` type carries call signatures while runtime accepts both legacy and callable forms.
2. Whether aggregate track output is validated against existing workflow output shape or represented as a separate built-in track output shape for parallel tracks.
3. Exact event names and backward compatibility strategy.
4. Whether waiting in one branch pauses all scheduling in the no-daemon implementation.
5. Initial failure policy default and where it is configured.
6. Exact lock mechanism for `globalState.update(...)` in foreground-only mode with a future path to daemon/process safety.
