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
      timeout: 250,
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
        customProviders: {},
        agents: { default: [{ provider: "pi" }] },
      },
      providerWorkingRunner: async (request) => {
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
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]),
    ).resolves.toBe(true);
    expect(sawAbort).toBe(true);
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.failure).toMatchObject({
        code: "step_timeout",
        message: "Step slow-agent timed out after 250ms.",
        details: { stepId: "slow-agent", timeoutMs: 250 },
      });
    }
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);
  });
});
