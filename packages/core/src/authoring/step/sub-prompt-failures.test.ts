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

describe("subPrompt failure semantics", () => {
  it("fails clearly outside an active step context", async () => {
    const ask = subPrompt("Choose", { output: answerShape });

    await expect(ask({})).rejects.toThrow(/subPrompt.*active StepKit step run context/i);
  });

  it("fails with a prompt-style output requirement when output is missing inside a step", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-sub-prompt-failures-"));

    const orchestrate = step({ id: "orchestrate" }).do(async () => {
      const ask = subPrompt("Choose", {} as Parameters<typeof subPrompt>[1]);
      await ask({});
      return done({ final: "unreachable" });
    });

    const workflow: Workflow<Record<string, never>, { final: string }> = {
      id: "sub-prompt-missing-output-workflow",
      inputShape: {},
      outputShape: finalShape,
      agents: { helper: { size: "small" } },
      start() {
        return orchestrate({});
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "sub-prompt-missing-output",
      cwd,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected workflow to fail.");
    }
    expect(result.failure.message).toMatch(
      /subPrompt.*step orchestrate.*requires an output shape/i,
    );
  });

  it("emits subPrompt.failed before a caught validation failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-sub-prompt-failures-"));
    const adapter: AgentAdapter<Record<string, never>, { answer: string }> = async (request) => {
      await request.tools
        .find((tool) => tool.name === "submit_output")
        ?.call({ answer: 42 } as never);
    };

    const orchestrate = step({ id: "orchestrate" }).do(async () => {
      try {
        const ask = subPrompt("Choose", { output: answerShape, adapter, agent: "helper" });
        await ask({});
      } catch {
        return done({ final: "fallback" });
      }

      return done({ final: "unreachable" });
    });

    const workflow: Workflow<Record<string, never>, { final: string }> = {
      id: "sub-prompt-caught-failure-workflow",
      inputShape: {},
      outputShape: finalShape,
      agents: { helper: { size: "small" } },
      start() {
        return orchestrate({});
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "sub-prompt-caught-failure",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ final: "fallback" });
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "subPrompt.started",
      "subPrompt.failed",
      "step.completed",
      "workflow.completed",
    ]);
    expect(result.events.find((event) => event.type === "subPrompt.failed")).toMatchObject({
      stepId: "orchestrate",
      payload: {
        parentStepId: "orchestrate",
        ordinal: 1,
        fingerprint: expect.any(String),
        failure: {
          code: "validation_failed",
          message: expect.stringContaining("subPrompt output failed schema validation"),
        },
      },
    });
  });

  it("uncaught subPrompt failure fails the parent step", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-sub-prompt-failures-"));
    const adapter: AgentAdapter<Record<string, never>, { answer: string }> = async (request) => {
      await request.tools
        .find((tool) => tool.name === "submit_output")
        ?.call({ answer: 42 } as never);
    };

    const orchestrate = step({ id: "orchestrate" }).do(async () => {
      const ask = subPrompt("Choose", { output: answerShape, adapter, agent: "helper" });
      const output = await ask({});
      return done({ final: output.answer });
    });

    const workflow: Workflow<Record<string, never>, { final: string }> = {
      id: "sub-prompt-uncaught-failure-workflow",
      inputShape: {},
      outputShape: finalShape,
      agents: { helper: { size: "small" } },
      start() {
        return orchestrate({});
      },
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "sub-prompt-uncaught-failure",
      cwd,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected workflow to fail.");
    }
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "subPrompt.started",
      "subPrompt.failed",
      "step.failed",
      "workflow.failed",
    ]);
    expect(result.failure.message).toContain("subPrompt output failed schema validation");
  });
});
