import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  Document,
  document,
  done,
  type Event,
  parseStepKitConfig,
  runWorkflow,
  type StepFactory,
  step,
  type Workflow,
} from "../../../index.js";
import { appendEvent, createRunDirectory } from "../../artifacts/run-storage.js";
import { resolveStepArtifactPaths } from "../../artifacts/step-artifacts.js";

function eventTypes(events: readonly Event[]): readonly string[] {
  return events.map((event) => event.type);
}

function event(overrides: Partial<Event> & Pick<Event, "id" | "type">): Event {
  return {
    runId: "history-run",
    workflowId: "history-workflow",
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: {},
    ...overrides,
  };
}

async function createRunWithEvents(events: readonly Event[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-"));
  const { runDir } = await createRunDirectory({ cwd, runName: "history-run" });

  for (const nextEvent of events) {
    await appendEvent(runDir, nextEvent);
  }

  return runDir;
}

function replayWorkflow(): Workflow<{ value: number }, { value: number }> {
  const secondStep = step({
    id: "second",
  }).do(({ value }: { value: number }) => done({ value: value + 1 }));

  const firstStep = step({
    id: "first",
  }).do(({ value }: { value: number }) => secondStep({ value: value + 1 }));

  return {
    id: "history-workflow",
    inputShape: { value: "number" },
    outputShape: { value: "number" },
    start(input) {
      return firstStep(input);
    },
  };
}

describe("runWorkflow resume", () => {
  it("resumes a failed two-step run by replaying the completed first step from its recorded position", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-"));
    let firstStepRuns = 0;
    let shouldFailSecondStep = true;

    const secondStep = step({
      id: "second",
    }).do(({ value }: { value: number }) => {
      if (shouldFailSecondStep) {
        throw new Error("second step unavailable");
      }

      return done({ value: value + 1 });
    });

    const firstStep = step({
      id: "first",
    }).do(({ value }: { value: number }) => {
      firstStepRuns += 1;
      return secondStep({ value: value + 1 });
    });

    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "resumable-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return firstStep(input);
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "resume-me",
      cwd,
    });

    expect(failed.status).toBe("failure");
    expect(firstStepRuns).toBe(1);

    shouldFailSecondStep = false;
    const resumed = await runWorkflow({ workflow, resume: { runDir: failed.runDir } });

    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") {
      throw new Error(resumed.failure.message);
    }

    expect(resumed.runId).toBe(failed.runId);
    expect(resumed.runDir).toBe(failed.runDir);
    expect(resumed.output).toEqual({ value: 3 });
    // A no-prompt step's .do(...) is both its computation and its continuation
    // decision fused into one closure — unlike the old separate run()'s plain,
    // serializable output, there is nothing to persist and feed back in its place.
    // Resuming past a completed no-prompt step therefore re-invokes its .do(...)
    // (from the same input) rather than skipping it, so firstStepRuns goes to 2.
    expect(firstStepRuns).toBe(2);
    expect(eventTypes(resumed.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.started",
      "step.failed",
      "workflow.failed",
      "workflow.resumed",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
    expect(resumed.events[6]).toMatchObject({
      type: "workflow.resumed",
      payload: {
        resumedFromRunDir: failed.runDir,
        resumedStepId: "second",
        sourceFailureEventId: failed.events[4]?.id,
      },
    });

    const persistedEvents = (await readFile(join(failed.runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Event);
    expect(eventTypes(persistedEvents)).toEqual(eventTypes(resumed.events));
  });

  it("resumes into the second occurrence of a looping step id, not the first completed occurrence (take-it-away story-queue shape)", async () => {
    // Mirrors take-it-away's story queue: implement-story and
    // review-story-implementation loop, re-using the same step ids once per
    // queued story, until review-story-implementation's .do() returns
    // done(...) instead of looping back into implementStoryStep(...) again.
    // Story 0's implement-story/review-story-implementation both complete;
    // story 1's implement-story then fails. The target step id
    // ("implement-story") therefore also matches story 0's already-completed
    // occurrence earlier in history -- resume must not mistake that first
    // occurrence for "the target step already completed."
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-loop-"));
    let implementRuns = 0;
    let reviewRuns = 0;
    let shouldFailStoryTwo = true;
    const storyCount = 2;
    const implementDocPaths: string[] = [];
    const reviewDocPaths: string[] = [];

    const reviewStoryStep: StepFactory<{ storyIndex: number }, { storyIndex: number }> = step({
      id: "review-story-implementation",
    }).do(async ({ storyIndex }: { storyIndex: number }) => {
      reviewRuns += 1;
      const reviewDoc = await document(`reviewed story ${storyIndex}`);
      reviewDocPaths.push(reviewDoc.path);
      const nextIndex = storyIndex + 1;
      if (nextIndex < storyCount) {
        return implementStoryStep({ storyIndex: nextIndex });
      }
      return done({ implemented: nextIndex });
    });

    const implementStoryStep: StepFactory<{ storyIndex: number }, { storyIndex: number }> = step({
      id: "implement-story",
    }).do(async ({ storyIndex }: { storyIndex: number }) => {
      implementRuns += 1;
      if (storyIndex === 1 && shouldFailStoryTwo) {
        throw new Error("story two implementation unavailable");
      }
      const implementDoc = await document(`implemented story ${storyIndex}`);
      implementDocPaths.push(implementDoc.path);
      return reviewStoryStep({ storyIndex });
    });

    const workflow: Workflow<{ storyIndex: number }, { implemented: number }> = {
      id: "take-it-away-like-workflow",
      inputShape: { storyIndex: "number" },
      outputShape: { implemented: "number" },
      start(input) {
        return implementStoryStep(input);
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: { storyIndex: 0 },
      runName: "loop-resume-me",
      cwd,
    });

    expect(failed.status).toBe("failure");
    expect(implementRuns).toBe(2);
    expect(reviewRuns).toBe(1);

    shouldFailStoryTwo = false;
    const resumed = await runWorkflow({ workflow, resume: { runDir: failed.runDir } });

    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") {
      throw new Error(resumed.failure.message);
    }

    expect(resumed.output).toEqual({ implemented: 2 });
    // Replay re-invokes both of story 0's completed no-prompt steps' .do()
    // (see the "firstStepRuns goes to 2" comment above) before the live
    // continuation dispatches story 1's implement-story/review pair fresh, so
    // each counter gains 2 rather than 1: +1 from replaying story 0, +1 from
    // story 1 actually running live this time.
    expect(implementRuns).toBe(4);
    expect(reviewRuns).toBe(3);
    expect(eventTypes(resumed.events)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "step.started",
      "step.failed",
      "workflow.failed",
      "workflow.resumed",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
    expect(resumed.events[8]).toMatchObject({
      type: "workflow.resumed",
      payload: {
        resumedFromRunDir: failed.runDir,
        resumedStepId: "implement-story",
        sourceFailureEventId: failed.events[6]?.id,
      },
    });

    // Pre-resume, steps 1-3 (0001-implement-story, 0002-review-story-implementation,
    // 0003-implement-story) were already recorded on disk. The post-resume live
    // continuation must number its newly-dispatched steps 4 and 5, continuing
    // that sequence, rather than restarting the on-disk index at 1 and 2 --
    // which would collide with (and shadow) the pre-resume steps' own directories.
    expect(implementDocPaths.at(-1)).toBe(
      join(failed.runDir, "steps", "0004-implement-story", "document-1.md"),
    );
    expect(reviewDocPaths.at(-1)).toBe(
      join(failed.runDir, "steps", "0005-review-story-implementation", "document-1.md"),
    );
  });

  it("rejects a missing target with a specific failure code", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-"));
    const missingRunDir = join(cwd, ".trailstep", "runs", "missing-run");

    const result = await runWorkflow({
      workflow: replayWorkflow(),
      resume: { runDir: missingRunDir },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected missing target resume to fail.");
    }
    expect(result.runId).toBe("missing-run");
    expect(result.runDir).toBe(missingRunDir);
    expect(result.events).toEqual([]);
    expect(result.failure.code).toBe("resume_target_not_found");
  });

  it("rejects unsupported failed histories with specific failure codes", async () => {
    const workflow = replayWorkflow();

    const cases: readonly {
      readonly name: string;
      readonly events: readonly Event[];
      readonly code: string;
    }[] = [
      {
        name: "multiple failed steps",
        code: "resume_multiple_failed_steps",
        events: [
          event({ id: "started", type: "workflow.started", payload: { input: { value: 1 } } }),
          event({ id: "first-started", type: "step.started", stepId: "first" }),
          event({ id: "first-failed", type: "step.failed", stepId: "first" }),
          event({ id: "second-started", type: "step.started", stepId: "second" }),
          event({ id: "second-failed", type: "step.failed", stepId: "second" }),
          event({ id: "workflow-failed", type: "workflow.failed" }),
        ],
      },
      {
        name: "recovered onError flows",
        code: "resume_unsupported_history",
        events: [
          event({ id: "started", type: "workflow.started", payload: { input: { value: 1 } } }),
          event({ id: "first-started", type: "step.started", stepId: "first" }),
          event({ id: "first-failed", type: "step.failed", stepId: "first" }),
          event({
            id: "first-recovered-completed",
            type: "step.completed",
            stepId: "first",
            payload: { output: { value: 2 } },
          }),
          event({ id: "second-started", type: "step.started", stepId: "second" }),
          event({ id: "second-failed", type: "step.failed", stepId: "second" }),
          event({ id: "workflow-failed", type: "workflow.failed" }),
        ],
      },
      {
        name: "step id drift",
        code: "resume_step_id_drift",
        events: [
          event({ id: "started", type: "workflow.started", payload: { input: { value: 1 } } }),
          event({ id: "renamed-started", type: "step.started", stepId: "renamed-first" }),
          event({
            id: "renamed-completed",
            type: "step.completed",
            stepId: "renamed-first",
            payload: { output: { value: 2 } },
          }),
          event({ id: "second-started", type: "step.started", stepId: "second" }),
          event({ id: "second-failed", type: "step.failed", stepId: "second" }),
          event({ id: "workflow-failed", type: "workflow.failed" }),
        ],
      },
    ];

    for (const testCase of cases) {
      const runDir = await createRunWithEvents(testCase.events);
      const result = await runWorkflow({ workflow, resume: { runDir } });

      expect(result.status, testCase.name).toBe("failure");
      if (result.status !== "failure") {
        throw new Error(`Expected ${testCase.name} resume to fail.`);
      }
      expect(result.failure.code, testCase.name).toBe(testCase.code);
    }
  });

  it("resumes through a completed no-prompt orchestration-only step", async () => {
    // There is no separate "orchestration step" kind — a step with no .prompt(...) is
    // always just a no-prompt step, whether its .do(...) does arithmetic or pure
    // branching. Resume treats every no-prompt step identically (only a step with a
    // prompt makes resume-through-it unsupported), so this now succeeds.
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "history-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        const secondStep = step({
          id: "second",
        }).do(({ value }: { value: number }) => done({ value: value + 1 }));

        const orchestrationStep = step({
          id: "orchestration",
        }).do((firstOutput: { value: number }) => secondStep(firstOutput));

        return orchestrationStep(input);
      },
    };
    const runDir = await createRunWithEvents([
      event({ id: "started", type: "workflow.started", payload: { input: { value: 1 } } }),
      event({ id: "orchestration-started", type: "step.started", stepId: "orchestration" }),
      event({
        id: "orchestration-completed",
        type: "step.completed",
        stepId: "orchestration",
        payload: {},
      }),
      event({ id: "second-started", type: "step.started", stepId: "second" }),
      event({ id: "second-failed", type: "step.failed", stepId: "second" }),
      event({ id: "workflow-failed", type: "workflow.failed" }),
    ]);

    const result = await runWorkflow({ workflow, resume: { runDir } });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.status === "failure" ? result.failure.message : "resume failed");
    }
    expect(result.output).toEqual({ value: 2 });
  });

  it("rejects completed runs and workflow mismatch with specific failure codes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-"));
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "completed-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return step({
          id: "only",
        }).do(({ value }: { value: number }) => done({ value }))(input);
      },
    };

    const completed = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "completed-run",
      cwd,
    });
    expect(completed.status).toBe("success");

    const completedResume = await runWorkflow({ workflow, resume: { runDir: completed.runDir } });
    expect(completedResume.status).toBe("failure");
    if (completedResume.status !== "failure") {
      throw new Error("Expected completed resume to fail.");
    }
    expect(completedResume.failure.code).toBe("resume_target_not_failed");

    const mismatchedWorkflow: Workflow<{ value: number }, { value: number }> = {
      ...workflow,
      id: "different-workflow",
    };
    const mismatchResume = await runWorkflow({
      workflow: mismatchedWorkflow,
      resume: { runDir: completed.runDir },
    });
    expect(mismatchResume.status).toBe("failure");
    if (mismatchResume.status !== "failure") {
      throw new Error("Expected mismatch resume to fail.");
    }
    expect(mismatchResume.failure.code).toBe("resume_workflow_mismatch");
  });

  it("reattaches a run killed mid-interactive-session without spawning a new agent process", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-killed-"));
    const workflow: Workflow<{ task: string }, { notes: string }> = {
      id: "killed-mid-session-workflow",
      inputShape: { task: "string" },
      outputShape: { notes: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { notes: "string" },
            agent: "reviewer",
            mode: "interactive",
          })
          .do((output: { notes: string }) => done({ notes: output.notes }))(input);
      },
    };

    const { runDir } = await createRunDirectory({ cwd, runName: "killed-mid-session-run" });
    const danglingEvents: Event[] = [
      event({
        id: "started",
        type: "workflow.started",
        workflowId: workflow.id,
        payload: { input: { task: "ship it" } },
      }),
      event({
        id: "review-started",
        type: "step.started",
        workflowId: workflow.id,
        stepId: "review",
      }),
      event({
        id: "review-session-started",
        type: "interactive.sessionStarted",
        workflowId: workflow.id,
        stepId: "review",
        payload: { roleName: "reviewer", stepIndex: 1 },
      }),
    ];
    for (const nextEvent of danglingEvents) {
      await appendEvent(runDir, nextEvent);
    }

    const artifactPaths = resolveStepArtifactPaths({ runDir, stepId: "review", stepIndex: 1 });
    await mkdir(artifactPaths.stepDir, { recursive: true });
    await writeFile(
      artifactPaths.outputFile,
      `${JSON.stringify({ notes: "Approved while orchestrator was down." })}\n`,
      "utf8",
    );
    await writeFile(
      artifactPaths.interactiveFile,
      `${JSON.stringify(
        {
          status: "completed",
          stepId: "review",
          artifactStepId: artifactPaths.artifactStepId,
          outputMode: "json",
          runDir,
          stepDir: artifactPaths.stepDir,
          promptFile: artifactPaths.promptFile,
          outputFile: artifactPaths.outputFile,
          interactiveFile: artifactPaths.interactiveFile,
          runRelativeStepDir: artifactPaths.runRelativeStepDir,
          outputSchema: {
            type: "object",
            properties: { notes: { type: "string" } },
            required: ["notes"],
            additionalProperties: false,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    let processRunnerCalls = 0;
    const resumed = await runWorkflow({
      workflow,
      resume: { runDir },
      stepkitConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async () => {
        processRunnerCalls += 1;
        throw new Error("no new agent process should be spawned on reattach");
      },
    });

    expect(processRunnerCalls).toBe(0);
    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") {
      throw new Error(resumed.failure.message);
    }
    expect(resumed.output).toEqual({ notes: "Approved while orchestrator was down." });
    expect(eventTypes(resumed.events)).toEqual([
      "workflow.started",
      "step.started",
      "interactive.sessionStarted",
      "workflow.resumed",
      "workflow.completed",
    ]);
    expect(resumed.events[3]).toMatchObject({
      type: "workflow.resumed",
      payload: {
        resumedFromRunDir: runDir,
        resumedStepId: "review",
        sourceFailureEventId: "review-session-started",
      },
    });

    const persistedEvents = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Event);
    expect(eventTypes(persistedEvents)).toEqual(eventTypes(resumed.events));
  });

  it("resumes through an already-completed document-producing prompt step to a later failed step, reconstructing a real Document from the replayed output", async () => {
    // This is the exact scenario the resume-correctness fix targets: a completed
    // step whose output schema is `Document` gets its recorded output
    // replayed from events.jsonl as a plain JSON object (never a live Document
    // instance). Before the duck-typing fix, `Document.assert(...)` would
    // reject that plain object with a validation failure because of an
    // `instanceof Document` check. It must now succeed and hand the "draft"
    // step's `.do()` continuation a genuine, working `Document`.
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-document-"));
    let shouldFailReview = true;
    const receivedDocs: Document[] = [];

    const reviewStep = step({ id: "review" }).do(({ content }: { content: string }) => {
      if (shouldFailReview) {
        throw new Error("review unavailable");
      }
      return done({ content });
    });

    const draftStep = step({ id: "draft" })
      .prompt(({ input }) => `Draft notes about ${input.topic}.`, {
        output: Document,
        agent: "writer",
      })
      .do((doc) => {
        receivedDocs.push(doc);
        return reviewStep({ content: doc.content });
      });

    const workflow: Workflow<{ topic: string }, { content: string }> = {
      id: "resume-through-document-workflow",
      inputShape: { topic: "string" },
      outputShape: { content: "string" },
      agents: { writer: { size: "medium" } },
      start(input) {
        return draftStep(input);
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: { topic: "resume correctness" },
      runName: "resume-through-document-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: { medium: [{ provider: "worker" }] },
      }),
      workingAgentProcessRunner: async (request) => {
        await writeFile(request.outputFile, "# Draft\n\nOriginal live-captured draft.", "utf8");
        return { exitCode: 0 };
      },
    });

    expect(failed.status).toBe("failure");
    expect(receivedDocs).toHaveLength(1);
    expect(receivedDocs[0]).toBeInstanceOf(Document);

    const documentPath = join(failed.runDir, "steps", "0001-draft", "document-1.md");
    expect(receivedDocs[0]?.path).toBe(documentPath);

    shouldFailReview = false;
    const resumed = await runWorkflow({ workflow, resume: { runDir: failed.runDir } });

    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") {
      throw new Error(resumed.failure.message);
    }
    expect(resumed.output).toEqual({ content: "# Draft\n\nOriginal live-captured draft." });

    // The replay re-invoked draft's .do() continuation a second time with the
    // reconstructed Document -- assert that reconstruction produced a working
    // Document with the exact same content/path as the original live capture.
    expect(receivedDocs).toHaveLength(2);
    const replayedDoc = receivedDocs[1];
    expect(replayedDoc).toBeInstanceOf(Document);
    expect(replayedDoc?.content).toBe("# Draft\n\nOriginal live-captured draft.");
    expect(replayedDoc?.path).toBe(documentPath);
  });

  it("overwrites a document(...) file on disk with the second run's content when its step is retried after resume", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-resume-document-retry-"));
    let attempt = 1;
    let shouldFailReview = true;

    const reviewStep = step({ id: "review" }).do(({ path }: { path: string }) => {
      if (shouldFailReview) {
        throw new Error("review unavailable");
      }
      return done({ path });
    });

    const draftStep = step({ id: "draft" }).do(async (_input: { topic: string }) => {
      const content = attempt === 1 ? "first attempt content" : "second attempt content";
      const doc = await document(content);
      return reviewStep({ path: doc.path });
    });

    const workflow: Workflow<{ topic: string }, { path: string }> = {
      id: "resume-document-retry-workflow",
      inputShape: { topic: "string" },
      outputShape: { path: "string" },
      start(input) {
        return draftStep(input);
      },
    };

    const failed = await runWorkflow({
      workflow,
      input: { topic: "retry-overwrite" },
      runName: "resume-document-retry-run",
      cwd,
    });

    expect(failed.status).toBe("failure");

    const documentPath = join(failed.runDir, "steps", "0001-draft", "document-1.md");
    await expect(readFile(documentPath, "utf8")).resolves.toBe("first attempt content");

    attempt = 2;
    shouldFailReview = false;
    const resumed = await runWorkflow({ workflow, resume: { runDir: failed.runDir } });

    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") {
      throw new Error(resumed.failure.message);
    }
    expect(resumed.output).toEqual({ path: documentPath });

    // Rerunning draft's .do() on resume overwrites the same document-1.md file
    // in place with the second run's content, rather than appending to it or
    // failing because the file already exists.
    await expect(readFile(documentPath, "utf8")).resolves.toBe("second attempt content");
  });
});
