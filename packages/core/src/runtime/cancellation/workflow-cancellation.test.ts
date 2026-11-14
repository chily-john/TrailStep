import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, jsonSchema, runWorkflow, step, type Workflow } from "../../index.js";
import { appendEvent } from "../artifacts/run-storage.js";
import { createEvent } from "../events/create-run-event.js";
import {
  cancellationPayload,
  readCancellationMarker,
  writeCancellationMarker,
} from "./cancellation.js";

describe("workflow cancellation", () => {
  it("recovers a cancelled run through retry and a fresh wait instead of continuing the terminated wait", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-cancel-waiting-"));
    let resumed = false;
    const workflow = waitingWorkflow(() => {
      resumed = true;
    });

    const waiting = await runWorkflow({ workflow, input: {}, runName: "waiting-run", cwd });
    expect(waiting.status).toBe("waiting");

    // Simulate `trailstep cancel`: a cancel.json marker plus the terminal
    // cancellation events the CLI appends.
    const { marker } = await writeCancellationMarker({
      runDir: waiting.runDir,
      reason: "No longer needed.",
      source: "test",
    });
    const anchor = waiting.events.at(-1);
    if (!anchor) {
      throw new Error("waiting run recorded no events");
    }
    for (const type of [
      "workflow.cancelRequested",
      "step.cancelled",
      "workflow.cancelled",
    ] as const) {
      await appendEvent(
        waiting.runDir,
        createEvent({
          runId: anchor.runId,
          workflowId: anchor.workflowId,
          ...(type === "step.cancelled" ? { stepId: "review" } : {}),
          type,
          payload: cancellationPayload(marker),
        }),
      );
    }

    // A `step.cancelled` terminates the wait: continuing the cancelled run is
    // not a valid recovery, because it would resurrect the terminated wait.
    // Retry re-enters the interrupted step, which parks on a fresh wait.
    const retried = await runWorkflow({
      workflow,
      cwd,
      retry: { runDir: waiting.runDir, kind: "manual" },
    });
    expect(retried.status).toBe("waiting");
    expect(await readCancellationMarker(waiting.runDir)).toBeUndefined();
    expect(retried.events.map((event) => event.type)).toContain("workflow.retryStarted");

    const retryWait = retried.events.filter((event) => event.type === "wait.started").at(-1);
    if (retryWait === undefined) {
      throw new Error("retried run did not record a fresh wait");
    }
    const artifactPaths = retryWait.payload.artifactPaths;
    if (
      typeof artifactPaths !== "object" ||
      artifactPaths === null ||
      !("answerFile" in artifactPaths) ||
      typeof artifactPaths.answerFile !== "string"
    ) {
      throw new Error("wait.started event is missing its answer artifact path");
    }
    await writeFile(
      join(waiting.runDir, ...artifactPaths.answerFile.split("/")),
      `${JSON.stringify({ approved: true })}\n`,
      "utf8",
    );

    const continued = await runWorkflow({
      workflow,
      cwd,
      continue: { runDir: waiting.runDir },
    });

    expect(continued.status).toBe("success");
    expect(resumed).toBe(true);
    const types = continued.events.map((event) => event.type);
    expect(types).toContain("workflow.cancelled");
    expect(types).toContain("workflow.resumed");
    expect(types).toContain("workflow.completed");
  });

  it("aborts a long-running working agent step when cancellation is requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-cancel-agent-"));
    const runDir = join(cwd, ".trailstep", "runs", "cancel-agent-run");
    let sawAbort = false;
    let markRunnerStarted: () => void = () => undefined;
    const runnerStarted = new Promise<void>((resolve) => {
      markRunnerStarted = resolve;
    });

    const workflow: Workflow = {
      id: "cancel-agent-workflow",
      agents: { default: { size: "default" } },
      start() {
        return step({ id: "slow-agent" })
          .prompt("Take too long.", {
            output: jsonSchema({
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            }),
          })
          .do((output) => done(output))({});
      },
    };

    const resultPromise = runWorkflow({
      workflow,
      input: {},
      runName: "cancel-agent-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: { default: [{ provider: "worker" }] },
      },
      workingAgentProcessRunner: async (request) => {
        markRunnerStarted();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) {
            sawAbort = true;
            resolve();
            return;
          }

          request.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return { exitCode: 1, stdout: "" };
      },
    });

    await runnerStarted;
    await writeCancellationMarker({ runDir, reason: "Stop work.", source: "test" });
    const result = await resultPromise;

    expect(sawAbort).toBe(true);
    expect(result.status).toBe("cancelled");
    // agent.attemptFailed is emitted by the working-agent catch while the
    // cancellation machinery emits step.cancelled concurrently, so their
    // relative order is not deterministic; assert presence separately.
    expect(
      result.events.map((event) => event.type).filter((type) => type !== "agent.attemptFailed"),
    ).toEqual([
      "workflow.started",
      "step.started",
      "step.progress",
      "agent.targetSelected",
      "agent.spawned",
      "agent.promptSent",
      "step.cancelled",
      "workflow.cancelRequested",
      "workflow.cancelled",
    ]);
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow.cancelled",
    );
  });

  it("emits branch identity on step.cancelled in parallel tracks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-cancel-parallel-"));
    const runDir = join(cwd, ".trailstep", "runs", "cancel-parallel-run");
    const started: string[] = [];
    let markBothStarted: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });

    const branchStep = (id: string) =>
      step({ id }).do(async () => {
        started.push(id);
        if (started.length === 2) {
          markBothStarted();
        }
        // The cancellation watch races this never-settling step promise.
        await new Promise<void>(() => undefined);
        return done({});
      });

    const workflow: Workflow = {
      id: "cancel-parallel-workflow",
      start() {
        return [branchStep("branch-a")({}), branchStep("branch-b")({})];
      },
    };

    const resultPromise = runWorkflow({
      workflow,
      input: {},
      runName: "cancel-parallel-run",
      cwd,
      scheduler: { workers: 2 },
    });

    await bothStarted;
    await writeCancellationMarker({ runDir, reason: "Stop both branches.", source: "test" });
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    const track = JSON.parse(await readFile(join(runDir, "track.json"), "utf8")) as {
      readonly branches?: unknown;
    };
    const branchIds = new Set(
      Array.isArray(track.branches)
        ? track.branches.filter((branchId): branchId is string => typeof branchId === "string")
        : [],
    );
    const cancellations = result.events.filter((event) => event.type === "step.cancelled");
    expect(cancellations.length).toBeGreaterThan(0);
    for (const cancellation of cancellations) {
      expect(branchIds.has(String(cancellation.payload.branchId))).toBe(true);
    }
  });

  it("leaves no cancellation marker behind when the runtime honours a cancellation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-cancel-marker-"));
    const runDir = join(cwd, ".trailstep", "runs", "cancel-marker-run");
    let markRunnerStarted: () => void = () => undefined;
    const runnerStarted = new Promise<void>((resolve) => {
      markRunnerStarted = resolve;
    });

    const workflow: Workflow = {
      id: "cancel-marker-workflow",
      agents: { default: { size: "default" } },
      start() {
        return step({ id: "slow-agent" })
          .prompt("Take too long.", {
            output: jsonSchema({
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            }),
          })
          .do((output) => done(output))({});
      },
    };

    const resultPromise = runWorkflow({
      workflow,
      input: {},
      runName: "cancel-marker-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: { default: [{ provider: "worker" }] },
      },
      workingAgentProcessRunner: async (request) => {
        markRunnerStarted();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) {
            resolve();
            return;
          }

          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { exitCode: 1, stdout: "" };
      },
    });

    await runnerStarted;
    await writeCancellationMarker({ runDir, reason: "Stop work.", source: "test" });
    // The marker is a pending request, so it exists while the request is
    // still unanswered.
    expect(await readCancellationMarker(runDir)).toBeDefined();

    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    // The runtime honoured the cancellation, so the pending request is
    // consumed: no marker is left behind for the next cancel/continue/retry
    // to misread as "requested but not yet acted on".
    expect(await readCancellationMarker(runDir)).toBeUndefined();
  });
});

function waitingWorkflow(onResumed: () => void): Workflow {
  return {
    id: "waiting-cancel-workflow",
    start() {
      return step({ id: "review" })
        .wait({
          id: "approval",
          kind: "input",
          message: "Approve?",
          output: { approved: "boolean" },
        })
        .do(() => {
          onResumed();
          return done({ ok: true });
        })({});
    },
  };
}
