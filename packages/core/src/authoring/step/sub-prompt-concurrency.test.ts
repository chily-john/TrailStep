import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AgentAdapter,
  done,
  jsonSchema,
  runWorkflow,
  step,
  subPrompt,
  type Workflow,
} from "../../index.js";

const answerShape = jsonSchema<{ answer: string }>({
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
});

const finalShape = jsonSchema<{ final: string }>({
  type: "object",
  properties: { final: { type: "string" } },
  required: ["final"],
  additionalProperties: false,
});

interface PendingRequest {
  readonly path: string;
  resolve(): Promise<void>;
}

describe("subPrompt concurrency", () => {
  it("assigns stable ordinals by invocation order under Promise.all", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-sub-prompt-concurrency-"));
    const pendingRequests: PendingRequest[] = [];

    const adapter: AgentAdapter<{ path: string }, { answer: string }> = (request) => {
      return new Promise<void>((resolve, reject) => {
        pendingRequests.push({
          path: request.input.path,
          async resolve() {
            try {
              await request.tools
                .find((tool) => tool.name === "submit_output")
                ?.call({ answer: `chosen-${request.input.path}` });
              resolve();
            } catch (error) {
              reject(error);
            }
          },
        });
      });
    };

    const orchestrate = step({ id: "orchestrate" }).do(async () => {
      const ask = subPrompt(({ input }: { input: { path: string } }) => `Choose ${input.path}`, {
        output: answerShape,
        adapter,
        agent: "helper",
      });
      const [a, b] = await Promise.all([ask({ path: "a" }), ask({ path: "b" })]);
      return done({ final: `${a.answer},${b.answer}` });
    });

    const workflow: Workflow<Record<string, never>, { final: string }> = {
      id: "sub-prompt-concurrency-workflow",
      inputShape: {},
      outputShape: finalShape,
      agents: { helper: { size: "small" } },
      start() {
        return orchestrate({});
      },
    };

    const run = runWorkflow({
      workflow,
      input: {},
      runName: "sub-prompt-concurrency",
      cwd,
    });

    await expect
      .poll(() => pendingRequests.map((request) => request.path).sort())
      .toEqual(["a", "b"]);
    const requestA = pendingRequests.find((request) => request.path === "a");
    const requestB = pendingRequests.find((request) => request.path === "b");
    await requestB?.resolve();
    await requestA?.resolve();

    const result = await run;

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ final: "chosen-a,chosen-b" });

    const startedEvents = result.events.filter((event) => event.type === "subPrompt.started");
    const startedByOrdinal = new Map(startedEvents.map((event) => [event.payload.ordinal, event]));
    expect(startedByOrdinal.get(1)).toMatchObject({
      payload: {
        ordinal: 1,
        artifactPaths: {
          subPromptDir: expect.stringMatching(/\/0001-[^/]+$/),
        },
      },
    });
    expect(startedByOrdinal.get(2)).toMatchObject({
      payload: {
        ordinal: 2,
        artifactPaths: {
          subPromptDir: expect.stringMatching(/\/0002-[^/]+$/),
        },
      },
    });

    const completedEvents = result.events.filter((event) => event.type === "subPrompt.completed");
    expect(completedEvents).toMatchObject([
      {
        payload: {
          ordinal: 2,
          output: { answer: "chosen-b" },
          artifactPaths: startedByOrdinal.get(2)?.payload.artifactPaths,
        },
      },
      {
        payload: {
          ordinal: 1,
          output: { answer: "chosen-a" },
          artifactPaths: startedByOrdinal.get(1)?.payload.artifactPaths,
        },
      },
    ]);
  });
});
