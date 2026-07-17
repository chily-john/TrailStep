import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentAdapterObject, jsonSchema, runWorkflow } from "@stepkit/core";
import { describe, expect, it } from "vitest";
import { defineWorkflow, done, step } from "./index.js";

describe("SDK agent step prompt rendering", () => {
  it("splits an agent prompt into adapter messages before a custom adapter is called", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-sdk-agent-prompt-"));
    const schema = jsonSchema<{ value: string }>({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    });
    const adapter: AgentAdapterObject<{ value: string }, { value: string }> = {
      async runAgentStep(request) {
        expect(request.messages).toEqual([
          { role: "user", content: "# Transform\n\nReturn the value with a suffix." },
        ]);
        await request.tools[0]?.call({ value: `${request.input.value}-done` });
      },
    };

    const workflow = defineWorkflow({
      id: "agent-prompt-workflow",
      inputShape: schema,
      outputShape: schema,
      start(input) {
        return step(
          {
            id: "agent",
            input,
            outputShape: schema,
            prompt: "# Transform\n\nReturn the value with a suffix.",
            requirements: { size: "tiny" },
            adapter,
          },
          (output) => done(output),
        );
      },
    });

    const result = await runWorkflow({
      workflow,
      input: { value: "input" },
      runName: "sdk-agent-prompt",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ value: "input-done" });
  });

  it("defines an agent step whose prompt function renders from live input", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-sdk-agent-function-prompt-"));
    const inputShape = jsonSchema<{ topic: string }>({
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
      additionalProperties: false,
    });
    const outputShape = jsonSchema<{ response: string }>({
      type: "object",
      properties: { response: { type: "string" } },
      required: ["response"],
      additionalProperties: false,
    });
    const adapter: AgentAdapterObject<{ topic: string }, { response: string }> = {
      async runAgentStep(request) {
        expect(request.messages).toEqual([
          { role: "user", content: "Explain live input for StepKit." },
        ]);
        await request.tools[0]?.call({ response: `prompted:${request.input.topic}` });
      },
    };

    const workflow = defineWorkflow({
      id: "agent-function-prompt-workflow",
      inputShape,
      outputShape,
      start(input) {
        return step(
          {
            id: "explain",
            input,
            outputShape,
            prompt: ({ input: liveInput }) => `Explain ${liveInput.topic} for StepKit.`,
            requirements: { size: "tiny" },
            adapter,
          },
          (output) => done(output),
        );
      },
    });

    const result = await runWorkflow({
      workflow,
      input: { topic: "live input" },
      runName: "sdk-agent-function-prompt",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ response: "prompted:live input" });
  });
});
