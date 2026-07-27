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

const promptOutputShape = jsonSchema<{ topic: string }>({
  type: "object",
  properties: { topic: { type: "string" } },
  required: ["topic"],
  additionalProperties: false,
});

function workflowWithTwoSubPrompts(options?: {
  readonly workflowId?: string;
  readonly maxSubPrompts?: number;
  readonly dispatchCount?: { value: number };
}): Workflow<Record<string, never>, { final: string }> {
  const dispatchCount = options?.dispatchCount ?? { value: 0 };
  const adapter: AgentAdapter<{ path: string }, { answer: string }> = async (request) => {
    dispatchCount.value += 1;
    await request.tools
      .find((tool) => tool.name === "submit_output")
      ?.call({ answer: `chosen-${request.input.path}` });
  };

  const orchestrate = step({ id: "orchestrate" }).do(async () => {
    const ask = subPrompt(({ input }: { input: { path: string } }) => `Choose ${input.path}`, {
      output: answerShape,
      adapter,
      agent: "helper",
      maxSubPrompts: options?.maxSubPrompts,
    });

    await ask({ path: "a" });
    await ask({ path: "b" });
    return done({ final: "unreachable" });
  });

  return {
    id: options?.workflowId ?? "sub-prompt-limit-workflow",
    inputShape: {},
    outputShape: finalShape,
    agents: { helper: { size: "small" } },
    start() {
      return orchestrate({});
    },
  };
}

describe("subPrompt limits", () => {
  it("uses maxSubPrompts per-call override to stop dispatching over the limit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-sub-prompt-limit-"));
    const dispatchCount = { value: 0 };

    const result = await runWorkflow({
      workflow: workflowWithTwoSubPrompts({ maxSubPrompts: 1, dispatchCount }),
      input: {},
      runName: "sub-prompt-limit",
      cwd,
    });

    expect(result.status).toBe("failure");
    expect(dispatchCount.value).toBe(1);
    if (result.status !== "failure") {
      throw new Error("Expected run to fail after exceeding maxSubPrompts.");
    }
    expect(result.failure.message).toBe("workflow exceeded maxSubPrompts guard (1)");
    expect(result.events.filter((event) => event.type === "subPrompt.started")).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "subPrompt.failed")).toHaveLength(1);
    expect(result.events.find((event) => event.type === "subPrompt.failed")).toMatchObject({
      stepId: "orchestrate",
      payload: {
        ordinal: 2,
        failure: { message: "workflow exceeded maxSubPrompts guard (1)" },
      },
    });
  });

  it("uses workflow settings maxSubPrompts as the default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-sub-prompt-settings-limit-"));
    const dispatchCount = { value: 0 };
    const workflow = workflowWithTwoSubPrompts({
      workflowId: "settings-limit-workflow",
      dispatchCount,
    });

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "sub-prompt-settings-limit",
      cwd,
      stepkitConfig: {
        version: 1,
        customProviders: {},
        agents: {},
        workflows: {
          "settings-limit-workflow": {
            settings: { maxSubPrompts: 1 },
          },
        },
      },
    });

    expect(result.status).toBe("failure");
    expect(dispatchCount.value).toBe(1);
    if (result.status !== "failure") {
      throw new Error("Expected run to fail after exceeding configured maxSubPrompts.");
    }
    expect(result.failure.message).toBe("workflow exceeded maxSubPrompts guard (1)");
  });

  it("uses regular prompt options maxSubPrompts for subPrompts inside prompted step onOutput", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-sub-prompt-prompt-option-limit-"));
    let subPromptDispatchCount = 0;

    const promptAdapter: AgentAdapter<Record<string, never>, { topic: string }> = async (
      request,
    ) => {
      await request.tools.find((tool) => tool.name === "submit_output")?.call({ topic: "alpha" });
    };
    const subPromptAdapter: AgentAdapter<{ path: string }, { answer: string }> = async (
      request,
    ) => {
      subPromptDispatchCount += 1;
      await request.tools
        .find((tool) => tool.name === "submit_output")
        ?.call({ answer: `chosen-${request.input.path}` });
    };

    const prompted = step({ id: "prompted" })
      .prompt("Choose a topic", {
        output: promptOutputShape,
        adapter: promptAdapter,
        agent: "helper",
        maxSubPrompts: 1,
      })
      .do(async () => {
        const ask = subPrompt(({ input }: { input: { path: string } }) => `Choose ${input.path}`, {
          output: answerShape,
          adapter: subPromptAdapter,
          agent: "helper",
        });
        await ask({ path: "a" });
        await ask({ path: "b" });
        return done({ final: "unreachable" });
      });

    const workflow: Workflow<Record<string, never>, { final: string }> = {
      id: "prompt-option-limit-workflow",
      inputShape: {},
      outputShape: finalShape,
      agents: { helper: { size: "small" } },
      start() {
        return prompted({});
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "sub-prompt-prompt-option-limit",
      cwd,
    });

    expect(result.status).toBe("failure");
    expect(subPromptDispatchCount).toBe(1);
    if (result.status !== "failure") {
      throw new Error("Expected prompted step to fail after exceeding maxSubPrompts.");
    }
    expect(result.failure.message).toBe("workflow exceeded maxSubPrompts guard (1)");
  });
});
