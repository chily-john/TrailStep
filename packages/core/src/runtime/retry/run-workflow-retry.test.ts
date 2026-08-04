import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  document,
  done,
  type Event,
  fail,
  parseStepKitConfig,
  runWorkflow,
  step,
  type Workflow,
} from "../../index.js";

function eventTypes(events: readonly Event[]): readonly string[] {
  return events.map((event) => event.type);
}

describe("runWorkflow retry", () => {
  it("manual retry targets a step that returned fail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-retry-fail-node-"));
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

  it("manual retry reports historical workflow failures without step metadata clearly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-retry-historical-workflow-failure-"));
    const runName = "retry-historical-workflow-failure";
    const runDir = join(cwd, ".stepkit", "runs", runName);
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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-retry-dangling-"));
    const runName = "retry-dangling";
    const runDir = join(cwd, ".stepkit", "runs", runName);
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
  });

  it("manual retry resumes the latest unresolved failure and continues artifact ordinals", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-retry-"));
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

  it("manual retry writes a failed prompt agent attempt and retried attempt to separate step artifact directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-retry-agent-"));
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

    const stepkitConfig = parseStepKitConfig({
      version: 1,
      customProviders: { worker: { binary: "worker-agent" } },
      agents: { small: [{ provider: "worker" }] },
    });

    const failed = await runWorkflow({
      workflow,
      input: { task: "artifact retry" },
      runName: "retry-agent",
      cwd,
      stepkitConfig,
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
      stepkitConfig,
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
