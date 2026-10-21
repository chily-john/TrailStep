import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, jsonSchema, runWorkflow, step, type Workflow } from "../../index.js";

describe("workflow step timeouts", () => {
  it("fails the workflow and aborts a working provider when the effective step timeout elapses", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-timeout-"));
    let sawAbort = false;
    let markAbortObserved: () => void = () => undefined;
    const abortObserved = new Promise<void>((resolve) => {
      markAbortObserved = () => {
        sawAbort = true;
        resolve();
      };
    });

    const workflow: Workflow = {
      id: "timeout-workflow",
      timeout: 2_000,
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

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "timeout-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: { default: [{ provider: "worker" }] },
      },
      workingAgentProcessRunner: async (request) => {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) {
            markAbortObserved();
            resolve();
            return;
          }

          request.signal?.addEventListener(
            "abort",
            () => {
              markAbortObserved();
              setTimeout(resolve, 0);
            },
            { once: true },
          );
        });
        return { exitCode: 1, stdout: "" };
      },
    });

    await expect(
      Promise.race([
        abortObserved.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]),
    ).resolves.toBe(true);
    expect(sawAbort).toBe(true);
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.failure).toMatchObject({
        code: "step_timeout",
        message: "Step slow-agent timed out after 2000ms.",
        details: { stepId: "slow-agent", timeoutMs: 2_000 },
      });
    }
    // agent.attemptFailed is emitted by the working-agent catch while the
    // timeout machinery emits step.failed concurrently, so their relative
    // order is not deterministic; assert its presence separately. The catch
    // awaits an attempt-log disk write before emitting, so under load the
    // event can land just after runWorkflow resolves — poll the live events
    // array briefly before asserting.
    const attemptFailures = () =>
      result.events.filter((event) => event.type === "agent.attemptFailed");
    for (let waitedMs = 0; attemptFailures().length < 2 && waitedMs < 5_000; waitedMs += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // A step timeout is a TRANSIENT failure, so automatic step retry re-runs
    // the step once (built-in maxAttempts 2) before it fails for good. Each
    // attempt produces one working-agent attempt failure.
    expect(attemptFailures()).toHaveLength(2);
    expect(
      result.events.map((event) => event.type).filter((type) => type !== "agent.attemptFailed"),
    ).toEqual([
      "workflow.started",
      "step.started",
      "step.progress",
      "agent.targetSelected",
      "agent.spawned",
      "agent.promptSent",
      // first attempt timed out and is retried (transient failure)
      "step.attemptFailed",
      "step.progress",
      "agent.targetSelected",
      "agent.spawned",
      "agent.promptSent",
      "step.failed",
      "workflow.failed",
    ]);
  });
});
