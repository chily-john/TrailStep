import { mkdtemp, readFile } from "node:fs/promises";
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

describe("subPrompt", () => {
  it("dispatches an adapter-backed subPrompt inside a code step and returns validated output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-sub-prompt-"));
    const resultShape = jsonSchema<{ answer: string }>({
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

    const adapter: AgentAdapter<{ topic: string }, { answer: string }> = async (request) => {
      expect(request.input).toEqual({ topic: "alpha" });
      expect(request.messages).toEqual([{ role: "user", content: "Choose alpha" }]);
      expect(request.requirements).toEqual({ size: "small", name: "helper" });
      expect(request.model).toEqual({ adapterKey: "custom", model: "helper" });
      expect(request.step.output).toBe(resultShape);
      const submitOutput = request.tools.find((tool) => tool.name === "submit_output");
      expect(submitOutput).toBeDefined();
      await submitOutput?.call({ answer: "chosen-alpha" });
    };

    const orchestrate = step({ id: "orchestrate" }).do(async (input: { topic: string }) => {
      const ask = subPrompt(({ input }) => `Choose ${input.topic}`, {
        output: resultShape,
        adapter,
        agent: "helper",
      });
      const answer = await ask(input);
      return done({ final: answer.answer });
    });

    const workflow: Workflow<{ topic: string }, { final: string }> = {
      id: "sub-prompt-workflow",
      inputShape: { topic: "string" },
      outputShape: finalShape,
      agents: { helper: { size: "small", name: "helper" } },
      start(input) {
        return orchestrate(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { topic: "alpha" },
      runName: "sub-prompt-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toEqual({ final: "chosen-alpha" });
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "subPrompt.started",
      "agent.toolCall",
      "subPrompt.completed",
      "step.completed",
      "workflow.completed",
    ]);

    const started = result.events.find((event) => event.type === "subPrompt.started");
    expect(started).toMatchObject({
      stepId: "orchestrate",
      payload: {
        parentStepId: "orchestrate",
        ordinal: 1,
        fingerprint: expect.any(String),
        artifactPaths: {
          promptFile: expect.stringMatching(
            /^steps\/0001-orchestrate\/subPrompts\/0001-[^/]+\/prompt\.txt$/,
          ),
          outputFile: expect.stringMatching(
            /^steps\/0001-orchestrate\/subPrompts\/0001-[^/]+\/output\.json$/,
          ),
        },
      },
    });

    const completed = result.events.find((event) => event.type === "subPrompt.completed");
    expect(completed).toMatchObject({
      stepId: "orchestrate",
      payload: {
        parentStepId: "orchestrate",
        ordinal: 1,
        fingerprint: started?.payload.fingerprint,
        output: { answer: "chosen-alpha" },
        artifactPaths: started?.payload.artifactPaths,
      },
    });

    const artifactPaths = started?.payload.artifactPaths as {
      readonly promptFile: string;
      readonly outputFile: string;
    };
    const promptFile = join(result.runDir, artifactPaths.promptFile);
    const outputFile = join(result.runDir, artifactPaths.outputFile);
    await expect(readFile(promptFile, "utf8")).resolves.toBe("Choose alpha");
    await expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({
      answer: "chosen-alpha",
    });
  });
});
