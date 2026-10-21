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
  it("consumes the cancel marker and resumes a cancelled run on continue", async () => {
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

    // Answer the pending wait so the resumed run can finish.
    const waitStarted = waiting.events.find((event) => event.type === "wait.started");
    const artifactPaths = waitStarted?.payload.artifactPaths;
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

    // The cancelled run is not permanently bricked: continue consumes the
    // marker, re-opens the run with workflow.resumed, and runs to completion.
    expect(continued.status).toBe("success");
    expect(resumed).toBe(true);
    expect(await readCancellationMarker(waiting.runDir)).toBeUndefined();
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
