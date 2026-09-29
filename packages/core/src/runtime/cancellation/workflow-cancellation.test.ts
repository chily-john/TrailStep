import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, jsonSchema, runWorkflow, step, type Workflow } from "../../index.js";
import { readCancellationMarker, writeCancellationMarker } from "./cancellation.js";

describe("workflow cancellation", () => {
  it("cancels a waiting run durably and continue does not resume work", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-cancel-waiting-"));
    let resumed = false;
    const workflow = waitingWorkflow(() => {
      resumed = true;
    });

    const waiting = await runWorkflow({ workflow, input: {}, runName: "waiting-run", cwd });
    expect(waiting.status).toBe("waiting");

    await writeCancellationMarker({
      runDir: waiting.runDir,
      reason: "No longer needed.",
      source: "test",
    });
    await mkdir(join(waiting.runDir, "steps", "0001-review", "waits", "approval"), {
      recursive: true,
    });

    const continued = await runWorkflow({
      workflow,
      cwd,
      continue: { runDir: waiting.runDir },
    });

    expect(continued.status).toBe("cancelled");
    expect(resumed).toBe(false);
    expect(await readCancellationMarker(waiting.runDir)).toMatchObject({
      reason: "No longer needed.",
      source: "test",
    });
    expect(continued.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "wait.started",
      "workflow.cancelRequested",
      "workflow.cancelled",
    ]);
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
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
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
