import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { done, step } from "../../../authoring/authoring.js";
import type { Workflow } from "../../../authoring/workflow/workflow.types.js";
import type { Event } from "../../../runtime/run-workflow/run-workflow.types.js";
import { appendEvent, createRunDirectory } from "../../artifacts/run-storage.js";
import { resolveStepArtifactPaths } from "../../artifacts/step-artifacts.js";
import { reattachInProgressStep } from "./reattach-in-progress-step.js";

function event(overrides: Partial<Event> & Pick<Event, "id" | "type">): Event {
  return {
    runId: "reattach-run",
    workflowId: "reattach-workflow",
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: {},
    ...overrides,
  };
}

function reattachWorkflow(): Workflow<{ task: string }, { notes: string }> {
  return {
    id: "reattach-workflow",
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
}

async function createDanglingRun(): Promise<{ readonly runDir: string; readonly events: Event[] }> {
  const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-reattach-"));
  const { runDir } = await createRunDirectory({ cwd, runName: "reattach-run" });

  const events: Event[] = [
    event({ id: "started", type: "workflow.started", payload: { input: { task: "ship it" } } }),
    event({ id: "review-started", type: "step.started", stepId: "review" }),
    event({
      id: "review-session-started",
      type: "interactive.sessionStarted",
      stepId: "review",
      payload: { roleName: "reviewer", stepIndex: 1 },
    }),
  ];

  for (const nextEvent of events) {
    await appendEvent(runDir, nextEvent);
  }

  return { runDir, events };
}

async function writeInteractiveProtocol(
  runDir: string,
  status: "active" | "completed" | "cancelled",
  extra: Record<string, unknown> = {},
): Promise<{ readonly interactiveFile: string; readonly outputFile: string }> {
  const artifactPaths = resolveStepArtifactPaths({ runDir, stepId: "review", stepIndex: 1 });
  await mkdir(artifactPaths.stepDir, { recursive: true });
  await writeFile(
    artifactPaths.interactiveFile,
    `${JSON.stringify(
      {
        status,
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
        ...extra,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { interactiveFile: artifactPaths.interactiveFile, outputFile: artifactPaths.outputFile };
}

describe("reattachInProgressStep", () => {
  it("reads the output directly when the protocol already flipped to completed before the process died", async () => {
    const { runDir, events } = await createDanglingRun();
    const { outputFile } = await writeInteractiveProtocol(runDir, "completed");
    await writeFile(outputFile, `${JSON.stringify({ notes: "Approved before crash." })}\n`, "utf8");

    const result = await reattachInProgressStep({
      workflow: reattachWorkflow(),
      events,
      runDir,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.resumedStepId).toBe("review");
    expect(result.sourceFailureEventId).toBe("review-session-started");
    expect(result.node).toEqual({ kind: "done", output: { notes: "Approved before crash." } });
  });

  it("re-enters the file-polling wait and proceeds once a still-active protocol later flips to completed", async () => {
    const { runDir, events } = await createDanglingRun();
    const { interactiveFile, outputFile } = await writeInteractiveProtocol(runDir, "active");

    const reattachPromise = reattachInProgressStep({
      workflow: reattachWorkflow(),
      events,
      runDir,
    });

    await delay(150);
    const protocol = JSON.parse(await readFile(interactiveFile, "utf8"));
    await writeFile(outputFile, `${JSON.stringify({ notes: "Approved after delay." })}\n`, "utf8");
    await writeFile(
      interactiveFile,
      `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
      "utf8",
    );

    const result = await reattachPromise;

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.node).toEqual({ kind: "done", output: { notes: "Approved after delay." } });
  });

  it("fails with a resume failure when the protocol was cancelled", async () => {
    const { runDir, events } = await createDanglingRun();
    await writeInteractiveProtocol(runDir, "cancelled", { reason: "Requirements changed." });

    const result = await reattachInProgressStep({
      workflow: reattachWorkflow(),
      events,
      runDir,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected cancelled reattach to fail.");
    }
    expect(result.failure.code).toBe("resume_interactive_session_cancelled");
  });

  it("fails with a resume failure when interactive.json is missing entirely", async () => {
    const { runDir, events } = await createDanglingRun();

    const result = await reattachInProgressStep({
      workflow: reattachWorkflow(),
      events,
      runDir,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected missing protocol reattach to fail.");
    }
    expect(result.failure.code).toBe("resume_interactive_protocol_missing");
  });
});
