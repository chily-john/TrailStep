import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ContinuationResult,
  document,
  done,
  type Event,
  fail,
  jsonSchema,
  parseTrailStepConfig,
  runWorkflow,
  state,
  step,
  type Workflow,
} from "../../index.js";

function eventTypes(events: readonly Event[]): readonly string[] {
  return events.map((event) => event.type);
}

function event(input: {
  readonly id: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId?: string;
  readonly type: Event["type"];
  readonly payload?: Event["payload"];
}): Event {
  return {
    id: input.id,
    runId: input.runId,
    workflowId: input.workflowId,
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    type: input.type,
    payload: input.payload ?? {},
  };
}

describe("runWorkflow retry", () => {
  it("manual retry targets a step that returned fail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-fail-node-"));
    let shouldFail = true;

    const workflow: Workflow<Record<string, never>, { reviewed: boolean }> = {
      id: "retry-fail-node-workflow",
      inputShape: {},
      outputShape: { reviewed: "boolean" },
      start(input) {
        return step({ id: "review" }).do(async () => {
          if (shouldFail) {
            return fail({ code: "review_rejected", message: "review rejected" });
          }

          return done({ reviewed: true });
        })(input);
      },
    };

    const failed = await runWorkflow({ workflow, input: {}, runName: "retry-fail-node", cwd });

    expect(failed.status).toBe("failure");
    expect(eventTypes(failed.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);
    expect(failed.events[2]).toMatchObject({
      type: "step.failed",
      stepId: "review",
      payload: { failure: { code: "review_rejected", message: "review rejected" } },
    });
    expect(failed.events[3]).toMatchObject({ type: "workflow.failed" });

    shouldFail = false;
    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual" },
    });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }

    expect(retried.output).toEqual({ reviewed: true });
    expect(retried.events[4]).toMatchObject({
      type: "workflow.retryStarted",
      payload: {
        retryKind: "manual",
        retriedStepId: "review",
        sourceFailureEventId: failed.events[2]?.id,
        sourceFailureReplayPosition: 2,
      },
    });
  });

  it("manual retry targets a prompt step whose continuation returned fail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-prompt-fail-node-"));
    let shouldFail = true;
    let agentAttempts = 0;

    const workflow: Workflow<{ task: string }, { reviewed: boolean }> = {
      id: "retry-prompt-fail-node-workflow",
      inputShape: { task: "string" },
      outputShape: { reviewed: "boolean" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({ id: "review" })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { approved: "boolean" },
            agent: "reviewer",
          })
          .do((output: { approved: boolean }) => {
            if (shouldFail) {
              return fail({ code: "review_rejected", message: "review rejected" });
            }

            return done({ reviewed: output.approved });
          })(input);
      },
    };

    const trailstepConfig = parseTrailStepConfig({
      version: 1,
      customProviders: { worker: { binary: "worker-agent" } },
      agents: { small: [{ provider: "worker" }] },
    });

    const failed = await runWorkflow({
      workflow,
      input: { task: "prompt retry" },
      runName: "retry-prompt-fail-node",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        agentAttempts += 1;
        await writeFile(request.outputFile, JSON.stringify({ approved: true }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(failed.status).toBe("failure");
    expect(eventTypes(failed.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.failed",
      "workflow.failed",
    ]);
    expect(failed.events[3]).toMatchObject({
      type: "step.failed",
      stepId: "review",
      payload: { failure: { code: "review_rejected", message: "review rejected" } },
    });
    expect(failed.events[4]).toMatchObject({ type: "workflow.failed" });

    shouldFail = false;
    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual" },
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        agentAttempts += 1;
        await writeFile(request.outputFile, JSON.stringify({ approved: true }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }

    expect(retried.output).toEqual({ reviewed: true });
    expect(agentAttempts).toBe(2);
    expect(eventTypes(retried.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.failed",
      "workflow.failed",
      "workflow.retryStarted",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
    expect(retried.events[5]).toMatchObject({
      type: "workflow.retryStarted",
      payload: {
        retryKind: "manual",
        retriedStepId: "review",
        sourceFailureEventId: failed.events[3]?.id,
        sourceFailureReplayPosition: 3,
      },
    });
  });

  it("manual retry ignores completed events from earlier resolved failed attempts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-resolved-completions-"));
    let shouldFailReview = true;
    let shouldFailPublish = true;
    let agentAttempts = 0;
    const reviewDocumentPaths: string[] = [];

    const workflow: Workflow<{ task: string }, { result: string }> = {
      id: "retry-resolved-completions-workflow",
      inputShape: { task: "string" },
      outputShape: { result: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({ id: "review" })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { action: "string" },
            agent: "reviewer",
          })
          .do(async (output: { action: string }) => {
            if (shouldFailReview) {
              return fail({ code: "review_rejected", message: "review rejected" });
            }

            const reviewDocument = await document(`review action ${output.action}`);
            reviewDocumentPaths.push(reviewDocument.path);

            if (output.action === "stop") {
              return done({ result: "stopped" });
            }

            return step({ id: "publish" }).do(() => {
              if (shouldFailPublish) {
                throw new Error("publish unavailable");
              }

              return done({ result: "published" });
            })({});
          })(input);
      },
    };

    const trailstepConfig = parseTrailStepConfig({
      version: 1,
      customProviders: { worker: { binary: "worker-agent" } },
      agents: { small: [{ provider: "worker" }] },
    });
    const runAgent = async (request: { readonly outputFile: string }) => {
      agentAttempts += 1;
      await writeFile(
        request.outputFile,
        JSON.stringify({ action: agentAttempts === 1 ? "stop" : "continue" }),
        "utf8",
      );
      return { exitCode: 0 };
    };

    const failedReview = await runWorkflow({
      workflow,
      input: { task: "resolved completion retry" },
      runName: "retry-resolved-completions",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: runAgent,
    });

    expect(failedReview.status).toBe("failure");
    expect(eventTypes(failedReview.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.failed",
      "workflow.failed",
    ]);

    shouldFailReview = false;
    const failedPublish = await runWorkflow({
      workflow,
      retry: { runDir: failedReview.runDir, kind: "manual" },
      trailstepConfig,
      workingAgentProcessRunner: runAgent,
    });

    expect(failedPublish.status).toBe("failure");
    expect(eventTypes(failedPublish.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.failed",
      "workflow.failed",
      "workflow.retryStarted",
      "step.started",
      "step.completed",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);

    shouldFailPublish = false;
    const retriedPublish = await runWorkflow({
      workflow,
      retry: { runDir: failedReview.runDir, kind: "manual" },
      trailstepConfig,
      workingAgentProcessRunner: runAgent,
    });

    expect(retriedPublish.status).toBe("success");
    if (retriedPublish.status !== "success") {
      throw new Error(retriedPublish.failure.message);
    }
    expect(retriedPublish.output).toEqual({ result: "published" });
    expect(agentAttempts).toBe(2);
    expect(reviewDocumentPaths).toEqual([
      join(failedReview.runDir, "steps", "0002-review", "document-1.md"),
      join(failedReview.runDir, "steps", "0002-review", "document-1.md"),
    ]);
  });

  it("manual retry appends events with ids unique from existing events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-event-ids-"));
    const runName = "retry-event-ids";
    const runDir = join(cwd, ".trailstep", "runs", runName);
    await mkdir(runDir, { recursive: true });
    const persistedEvents: readonly Event[] = [
      {
        id: "evt_1",
        runId: runName,
        workflowId: "retry-event-ids-workflow",
        timestamp: "2026-01-01T00:00:00.000Z",
        schemaVersion: "v0",
        type: "workflow.started",
        payload: { input: {} },
      },
      {
        id: "evt_2",
        runId: runName,
        workflowId: "retry-event-ids-workflow",
        stepId: "review",
        timestamp: "2026-01-01T00:00:01.000Z",
        schemaVersion: "v0",
        type: "step.started",
        payload: {},
      },
      {
        id: "evt_3",
        runId: runName,
        workflowId: "retry-event-ids-workflow",
        stepId: "review",
        timestamp: "2026-01-01T00:00:02.000Z",
        schemaVersion: "v0",
        type: "step.failed",
        payload: { failure: { code: "review_rejected", message: "review rejected" } },
      },
      {
        id: "evt_4",
        runId: runName,
        workflowId: "retry-event-ids-workflow",
        timestamp: "2026-01-01T00:00:03.000Z",
        schemaVersion: "v0",
        type: "workflow.failed",
        payload: { failure: { code: "review_rejected", message: "review rejected" } },
      },
    ];
    await writeFile(
      join(runDir, "events.jsonl"),
      `${persistedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const workflow: Workflow<Record<string, never>, { reviewed: boolean }> = {
      id: "retry-event-ids-workflow",
      inputShape: {},
      outputShape: { reviewed: "boolean" },
      start(input) {
        return step({ id: "review" }).do(async () => done({ reviewed: true }))(input);
      },
    };

    const retried = await runWorkflow({ workflow, retry: { runDir, kind: "manual" } });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }
    expect(eventTypes(retried.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
      "workflow.retryStarted",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
    expect(new Set(retried.events.map((event) => event.id)).size).toBe(retried.events.length);
  });

  it("manual retry reports historical workflow failures without step metadata clearly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-historical-workflow-failure-"));
    const runName = "retry-historical-workflow-failure";
    const runDir = join(cwd, ".trailstep", "runs", runName);
    await mkdir(runDir, { recursive: true });
    const persistedEvents: readonly Event[] = [
      {
        id: "workflow-started",
        runId: runName,
        workflowId: "retry-historical-workflow-failure",
        timestamp: "2026-01-01T00:00:00.000Z",
        schemaVersion: "v0",
        type: "workflow.started",
        payload: { input: {} },
      },
      {
        id: "workflow-failed",
        runId: runName,
        workflowId: "retry-historical-workflow-failure",
        timestamp: "2026-01-01T00:00:01.000Z",
        schemaVersion: "v0",
        type: "workflow.failed",
        payload: { failure: { code: "review_rejected", message: "review rejected" } },
      },
    ];
    await writeFile(
      join(runDir, "events.jsonl"),
      `${persistedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const workflow: Workflow<Record<string, never>, { reviewed: boolean }> = {
      id: "retry-historical-workflow-failure",
      inputShape: {},
      outputShape: { reviewed: "boolean" },
      start(input) {
        return step({ id: "review" }).do(async () => done({ reviewed: true }))(input);
      },
    };

    const retried = await runWorkflow({ workflow, retry: { runDir, kind: "manual" } });

    expect(retried.status).toBe("failure");
    if (retried.status !== "failure") {
      throw new Error("Expected retry to fail.");
    }
    expect(retried.failure).toEqual({
      code: "retry_target_not_failed",
      message:
        "Workflow failure has no associated step ID. This run may use unsupported historical retry metadata.",
    });
  });

  it("manual retry resumes a run whose latest persisted event is a dangling step.started", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-dangling-"));
    const runName = "retry-dangling";
    const runDir = join(cwd, ".trailstep", "runs", runName);
    await mkdir(runDir, { recursive: true });
    const persistedEvents: readonly Event[] = [
      {
        id: "workflow-started",
        runId: runName,
        workflowId: "retry-dangling-workflow",
        timestamp: "2026-01-01T00:00:00.000Z",
        schemaVersion: "v0",
        type: "workflow.started",
        payload: { input: {} },
      },
      {
        id: "review-started",
        runId: runName,
        workflowId: "retry-dangling-workflow",
        stepId: "review",
        timestamp: "2026-01-01T00:00:01.000Z",
        schemaVersion: "v0",
        type: "step.started",
        payload: {},
      },
    ];
    await writeFile(
      join(runDir, "events.jsonl"),
      `${persistedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const documentPaths: string[] = [];
    const workflow: Workflow<Record<string, never>, { reviewed: boolean }> = {
      id: "retry-dangling-workflow",
      inputShape: {},
      outputShape: { reviewed: "boolean" },
      start(input) {
        return step({ id: "review" }).do(async () => {
          const attemptDoc = await document("retried dangling attempt");
          documentPaths.push(attemptDoc.path);
          return done({ reviewed: true });
        })(input);
      },
    };

    const retried = await runWorkflow({
      workflow,
      retry: { runDir, kind: "manual" },
    });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }

    expect(retried.runDir).toBe(runDir);
    expect(retried.output).toEqual({ reviewed: true });
    expect(documentPaths[0]).toBe(join(runDir, "steps", "0002-review", "document-1.md"));
    await expect(readFile(documentPaths[0] ?? "", "utf8")).resolves.toBe(
      "retried dangling attempt",
    );
    expect(eventTypes(retried.events)).toEqual([
      "workflow.started",
      "step.started",
      "workflow.retryStarted",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
    expect(retried.events[2]).toMatchObject({
      type: "workflow.retryStarted",
      payload: {
        retryKind: "manual",
        retriedStepId: "review",
        sourceFailureEventId: "review-started",
        sourceFailureReplayPosition: 1,
      },
    });
    expect(retried.events[3]).toMatchObject({ type: "step.started", stepId: "review" });
  });

  it("manual retry targets dangling second implement-story with paired repeated-id replay", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-repeated-story-dangling-"));
    const runName = "retry-repeated-story-dangling";
    const runDir = join(cwd, ".trailstep", "runs", runName);
    await mkdir(runDir, { recursive: true });
    const workflowId = "retry-repeated-story-dangling-workflow";
    const persistedEvents: readonly Event[] = [
      event({
        id: "workflow-started",
        runId: runName,
        workflowId,
        type: "workflow.started",
        payload: { input: {} },
      }),
      event({
        id: "router-1-started",
        runId: runName,
        workflowId,
        stepId: "story-router",
        type: "step.started",
      }),
      event({
        id: "router-1-completed",
        runId: runName,
        workflowId,
        stepId: "story-router",
        type: "step.completed",
      }),
      event({
        id: "implement-1-started",
        runId: runName,
        workflowId,
        stepId: "implement-story",
        type: "step.started",
      }),
      event({
        id: "implement-1-wait",
        runId: runName,
        workflowId,
        stepId: "implement-story",
        type: "wait.satisfied",
        payload: { waitId: "check-0", output: { story: 1 } },
      }),
      event({
        id: "implement-1-completed",
        runId: runName,
        workflowId,
        stepId: "implement-story",
        type: "step.completed",
      }),
      event({
        id: "review-1-started",
        runId: runName,
        workflowId,
        stepId: "review-story-implementation",
        type: "step.started",
      }),
      event({
        id: "review-1-completed",
        runId: runName,
        workflowId,
        stepId: "review-story-implementation",
        type: "step.completed",
      }),
      event({
        id: "commit-1-started",
        runId: runName,
        workflowId,
        stepId: "commit-story",
        type: "step.started",
      }),
      event({
        id: "commit-1-completed",
        runId: runName,
        workflowId,
        stepId: "commit-story",
        type: "step.completed",
      }),
      event({
        id: "router-2-started",
        runId: runName,
        workflowId,
        stepId: "story-router",
        type: "step.started",
      }),
      event({
        id: "router-2-completed",
        runId: runName,
        workflowId,
        stepId: "story-router",
        type: "step.completed",
      }),
      event({
        id: "implement-2-started",
        runId: runName,
        workflowId,
        stepId: "implement-story",
        type: "step.started",
      }),
    ];
    await writeFile(
      join(runDir, "events.jsonl"),
      `${persistedEvents.map((persistedEvent) => JSON.stringify(persistedEvent)).join("\n")}\n`,
      "utf8",
    );

    let implementCalls = 0;
    const seenWaitStories: number[] = [];
    const workflow: Workflow<Record<string, never>, { story: number }> = {
      id: workflowId,
      inputShape: {},
      outputShape: { story: "number" },
      start(input) {
        let route: (routeInput: Record<string, never>) => ContinuationResult<{ story: number }>;
        const commit = step({ id: "commit-story" }).do(() => route({}));
        const review = step({ id: "review-story-implementation" }).do(() => commit({}));
        const implement = step({ id: "implement-story" })
          .wait(async ({ wait }) => wait.done({ story: implementCalls + 1 }), {
            output: { story: "number" },
          })
          .do(({ waits }) => {
            const story = waits["check-0"]?.story;
            if (typeof story !== "number") {
              throw new Error("missing implement wait story");
            }
            seenWaitStories.push(story);
            implementCalls += 1;
            return story < 2 ? review({}) : done({ story });
          });
        route = step({ id: "story-router" }).do(() => implement({}));
        return route(input);
      },
    };

    const retried = await runWorkflow({ workflow, retry: { runDir, kind: "manual" } });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }
    expect(retried.output).toEqual({ story: 2 });
    expect(seenWaitStories).toEqual([1, 2]);
    expect(retried.events[13]).toMatchObject({
      type: "workflow.retryStarted",
      payload: {
        retriedStepId: "implement-story",
        sourceFailureEventId: "implement-2-started",
        sourceFailureReplayPosition: 12,
      },
    });
  });

  it("manual retry reconstructs runtime state at a repeated-step retry boundary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-state-boundary-"));
    let shouldFailSecondStory = true;
    const seenStoryIndexes: number[] = [];

    const workflow: Workflow<{ stories: string[] }, { story: string }> = {
      id: "retry-state-boundary-workflow",
      inputShape: jsonSchema<{ stories: string[] }>({
        type: "object",
        properties: { stories: { type: "array", items: { type: "string" } } },
        required: ["stories"],
        additionalProperties: false,
      }),
      outputShape: { story: "string" },
      start(input) {
        const implementStory = (): ContinuationResult<{ story: string }> =>
          step({ id: "implement-story" }).do(async () => {
            const active = await state.get<{ index: number }>("activeStory");
            const index = active?.index ?? 0;
            seenStoryIndexes.push(index);

            if (index === 1 && shouldFailSecondStory) {
              throw new Error("second story unavailable");
            }

            const story = input.stories[index];
            if (story === undefined) {
              throw new Error(`missing story ${index}`);
            }

            if (index + 1 >= input.stories.length) {
              return done({ story });
            }

            await state.set("activeStory", { index: index + 1 });
            return implementStory();
          })({});

        return implementStory();
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: { stories: ["Story 001", "Story 002"] },
      runName: "retry-state-boundary",
      cwd,
    });

    expect(failed.status).toBe("failure");
    await expect(readFile(join(failed.runDir, "state.json"), "utf8")).resolves.toContain(
      '"index": 1',
    );

    shouldFailSecondStory = false;
    seenStoryIndexes.length = 0;
    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual" },
    });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }
    expect(retried.output).toEqual({ story: "Story 002" });
    expect(seenStoryIndexes).toEqual([0, 1]);
    expect(eventTypes(retried.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.started",
      "step.failed",
      "workflow.failed",
      "workflow.retryStarted",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
  });

  it("manual retry targets a dangling repeated implement-green without dropping prior completed attempts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-repeated-dangling-"));
    const runName = "retry-repeated-dangling";
    const runDir = join(cwd, ".trailstep", "runs", runName);
    await mkdir(runDir, { recursive: true });
    const persistedEvents: readonly Event[] = [
      event({
        id: "workflow-started",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        type: "workflow.started",
        payload: { input: {} },
      }),
      event({
        id: "router-1-started",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "story-router",
        type: "step.started",
      }),
      event({
        id: "router-1-completed",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "story-router",
        type: "step.completed",
      }),
      event({
        id: "implement-1-started",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "implement-green",
        type: "step.started",
      }),
      event({
        id: "implement-1-completed",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "implement-green",
        type: "step.completed",
      }),
      event({
        id: "router-2-started",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "story-router",
        type: "step.started",
      }),
      event({
        id: "router-2-completed",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "story-router",
        type: "step.completed",
      }),
      event({
        id: "implement-2-started",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "implement-green",
        type: "step.started",
      }),
      event({
        id: "implement-2-completed",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "implement-green",
        type: "step.completed",
      }),
      event({
        id: "router-3-started",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "story-router",
        type: "step.started",
      }),
      event({
        id: "router-3-completed",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "story-router",
        type: "step.completed",
      }),
      event({
        id: "implement-3-started",
        runId: runName,
        workflowId: "retry-repeated-dangling-workflow",
        stepId: "implement-green",
        type: "step.started",
      }),
    ];
    await writeFile(
      join(runDir, "events.jsonl"),
      `${persistedEvents.map((persistedEvent) => JSON.stringify(persistedEvent)).join("\n")}\n`,
      "utf8",
    );

    let implementCalls = 0;
    const workflow: Workflow<Record<string, never>, { attempt: number }> = {
      id: "retry-repeated-dangling-workflow",
      inputShape: {},
      outputShape: { attempt: "number" },
      start(input) {
        let route: (routeInput: Record<string, never>) => ContinuationResult<{ attempt: number }>;
        const implement = step({ id: "implement-green" }).do(() => {
          implementCalls += 1;
          return implementCalls < 3 ? route({}) : done({ attempt: implementCalls });
        });
        route = step({ id: "story-router" }).do(() => implement({}));
        return route(input);
      },
    };

    const retried = await runWorkflow({ workflow, retry: { runDir, kind: "manual" } });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }
    expect(retried.output).toEqual({ attempt: 3 });
    expect(retried.events[12]).toMatchObject({
      type: "workflow.retryStarted",
      payload: {
        retriedStepId: "implement-green",
        sourceFailureEventId: "implement-3-started",
        sourceFailureReplayPosition: 11,
      },
    });
    expect(retried.events.at(-3)).toMatchObject({
      type: "step.started",
      stepId: "implement-green",
    });
  });

  it("manual retry resumes the latest unresolved failure and continues artifact ordinals", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-"));
    let shouldFail = true;
    const documentPaths: string[] = [];

    const workflow: Workflow<Record<string, never>, { reviewed: boolean }> = {
      id: "retry-workflow",
      inputShape: {},
      outputShape: { reviewed: "boolean" },
      start(input) {
        return step({ id: "review" }).do(async () => {
          const attemptDoc = await document(shouldFail ? "failed attempt" : "retried attempt");
          documentPaths.push(attemptDoc.path);
          if (shouldFail) {
            throw new Error("review unavailable");
          }
          return done({ reviewed: true });
        })(input);
      },
    };

    const failed = await runWorkflow({ workflow, input: {}, runName: "retry-me", cwd });

    expect(failed.status).toBe("failure");
    expect(documentPaths[0]).toBe(join(failed.runDir, "steps", "0001-review", "document-1.md"));
    await expect(readFile(documentPaths[0] ?? "", "utf8")).resolves.toBe("failed attempt");

    shouldFail = false;
    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual" },
    });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }

    expect(retried.runId).toBe(failed.runId);
    expect(retried.runDir).toBe(failed.runDir);
    expect(retried.output).toEqual({ reviewed: true });
    expect(documentPaths[1]).toBe(join(failed.runDir, "steps", "0002-review", "document-1.md"));
    await expect(readFile(documentPaths[0] ?? "", "utf8")).resolves.toBe("failed attempt");
    await expect(readFile(documentPaths[1] ?? "", "utf8")).resolves.toBe("retried attempt");
    expect(eventTypes(retried.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
      "workflow.retryStarted",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
    expect(retried.events[4]).toMatchObject({
      type: "workflow.retryStarted",
      payload: {
        retryKind: "manual",
        retriedStepId: "review",
        sourceFailureEventId: failed.events[2]?.id,
        sourceFailureReplayPosition: 2,
      },
    });
  });

  it("manual retry replays completed wait steps with their satisfied wait outputs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-wait-replay-"));
    const runName = "retry-wait-replay";
    let shouldFail = true;

    const workflow: Workflow<Record<string, never>, { approved: boolean }> = {
      id: "retry-wait-replay-workflow",
      inputShape: {},
      outputShape: { approved: "boolean" },
      start(input) {
        return step({ id: "review" })
          .wait(async ({ wait }) => wait.done({ approved: true }), {
            output: { approved: "boolean" },
          })
          .do(({ waits }) =>
            step({ id: "publish" }).do(() => {
              if (shouldFail) {
                throw new Error("publish unavailable");
              }

              return done({ approved: waits["check-0"]?.approved === true });
            })({}),
          )(input);
      },
    };

    const failed = await runWorkflow({ workflow, input: {}, runName, cwd });

    expect(failed.status).toBe("failure");
    expect(eventTypes(failed.events)).toEqual([
      "workflow.started",
      "step.started",
      "wait.satisfied",
      "step.completed",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);

    shouldFail = false;
    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual" },
    });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }
    expect(retried.output).toEqual({ approved: true });
  });

  it("manual retry writes a failed prompt agent attempt and retried attempt to separate step artifact directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-retry-agent-"));
    let agentAttempts = 0;

    const workflow: Workflow<{ task: string }, { notes: string }> = {
      id: "retry-agent-workflow",
      inputShape: { task: "string" },
      outputShape: { notes: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({ id: "review" })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { notes: "string" },
            agent: "reviewer",
          })
          .do((output: { notes: string }) => done(output))(input);
      },
    };

    const trailstepConfig = parseTrailStepConfig({
      version: 1,
      customProviders: { worker: { binary: "worker-agent" } },
      agents: { small: [{ provider: "worker" }] },
    });

    const failed = await runWorkflow({
      workflow,
      input: { task: "artifact retry" },
      runName: "retry-agent",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        agentAttempts += 1;
        await writeFile(
          request.outputFile,
          agentAttempts === 1
            ? JSON.stringify({ notes: "failed agent attempt" })
            : JSON.stringify({ notes: "retried agent attempt" }),
          "utf8",
        );
        return { exitCode: agentAttempts === 1 ? 1 : 0 };
      },
    });

    expect(failed.status).toBe("failure");
    const failedStepDir = join(failed.runDir, "steps", "0001-review");
    await expect(readFile(join(failedStepDir, "prompt.md"), "utf8")).resolves.toContain(
      "Review artifact retry.",
    );
    await expect(readFile(join(failedStepDir, "output.json"), "utf8")).resolves.toBe(
      JSON.stringify({ notes: "failed agent attempt" }),
    );

    const retried = await runWorkflow({
      workflow,
      retry: { runDir: failed.runDir, kind: "manual" },
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        agentAttempts += 1;
        await writeFile(
          request.outputFile,
          JSON.stringify({ notes: "retried agent attempt" }),
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }

    const retriedStepDir = join(failed.runDir, "steps", "0002-review");
    expect(retried.output).toEqual({ notes: "retried agent attempt" });
    await expect(readFile(join(failedStepDir, "output.json"), "utf8")).resolves.toBe(
      JSON.stringify({ notes: "failed agent attempt" }),
    );
    await expect(readFile(join(retriedStepDir, "prompt.md"), "utf8")).resolves.toContain(
      "Review artifact retry.",
    );
    await expect(readFile(join(retriedStepDir, "output.json"), "utf8")).resolves.toBe(
      JSON.stringify({ notes: "retried agent attempt" }),
    );
    expect(eventTypes(retried.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
      "workflow.retryStarted",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
  });
});
