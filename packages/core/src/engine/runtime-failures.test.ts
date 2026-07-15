import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  done,
  type Event,
  jsonSchema,
  type PlainObject,
  type Result,
  runWorkflow,
  type Schema,
  step,
  type Workflow,
} from "../index.js";

describe("runWorkflow failure paths", () => {
  // Remaining `steps: []` cases in this block are deprecated static workflow compatibility coverage;
  // continuation-specific failure behavior is covered alongside them below.
  it("fails invalid workflow input before the first step starts", async () => {
    const cwd = await testCwd();
    const objectWithValue = valueSchema();
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "invalid-workflow-input-workflow",
      input: objectWithValue,
      output: objectWithValue,
      steps: [
        {
          id: "not-started",
          input: objectWithValue,
          output: objectWithValue,
          run: async (input) => input,
        },
      ],
    };

    const result = await runWorkflow({
      workflow,
      input: { value: "bad" } as unknown as { value: number },
      runName: "invalid-workflow-input",
      cwd,
    });

    expectFailure(result, "validation_failed", "workflow input failed schema validation");
    expect(result.events.map((event) => event.type)).toEqual(["workflow.failed"]);
    expect(result.events[0]).toMatchObject({
      schemaVersion: "v0",
      payload: { failure: result.failure },
    });
    await expectPersistedEventTypes(result.runDir, ["workflow.failed"]);
  });

  it("emits step.failed and workflow.failed when a step input violates its schema", async () => {
    const cwd = await testCwd();
    const objectWithValue = valueSchema();
    const objectWithName = nameSchema();
    const workflow: Workflow<{ value: number }, { name: string }> = {
      id: "invalid-step-input-workflow",
      input: objectWithValue,
      output: objectWithName,
      steps: [
        {
          id: "produce-value",
          input: objectWithValue,
          output: objectWithValue,
          run: async (input) => input,
        },
        {
          id: "needs-name",
          input: objectWithName,
          output: objectWithName,
          run: async (input) => input,
        },
      ],
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "invalid-step-input",
      cwd,
    });

    expectFailure(result, "validation_failed", "step needs-name input failed schema validation");
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.failed",
      "workflow.failed",
    ]);
    expect(result.events[3]).toMatchObject({
      stepId: "needs-name",
      payload: { failure: result.failure },
    });
  });

  it("emits step.failed and workflow.failed when a step output violates its schema", async () => {
    const cwd = await testCwd();
    const objectWithValue = valueSchema();
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "invalid-step-output-workflow",
      input: objectWithValue,
      output: objectWithValue,
      steps: [
        {
          id: "break-output",
          input: objectWithValue,
          output: objectWithValue,
          run: async () => ({ value: "not-a-number" }) as unknown as { value: number },
        },
      ],
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "invalid-step-output",
      cwd,
    });

    expectFailure(result, "validation_failed", "step break-output output failed schema validation");
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);
    expect(result.events[2]).toMatchObject({
      schemaVersion: "v0",
      stepId: "break-output",
      payload: { failure: result.failure },
    });
    expect(result.events[3]).toMatchObject({
      schemaVersion: "v0",
      payload: { failure: result.failure },
    });
    await expectPersistedEventTypes(
      result.runDir,
      result.events.map((event) => event.type),
    );
  });

  it("emits workflow.failed when workflow output violates its schema", async () => {
    const cwd = await testCwd();
    const objectWithValue = valueSchema();
    const objectWithName = nameSchema();
    const workflow: Workflow<{ value: number }, { name: string }> = {
      id: "invalid-workflow-output-workflow",
      input: objectWithValue,
      output: objectWithName,
      steps: [
        {
          id: "produce-value",
          input: objectWithValue,
          output: objectWithValue,
          run: async (input) => input,
        },
      ],
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "invalid-workflow-output",
      cwd,
    });

    expectFailure(result, "validation_failed", "workflow output failed schema validation");
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "workflow.failed",
    ]);
    expect(result.events[3]).toMatchObject({ payload: { failure: result.failure } });
  });

  it("fails clearly when workflow.start returns an invalid node", async () => {
    const cwd = await testCwd();
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "invalid-start-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start: () => ({ nope: true }) as never,
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "invalid-start-node",
      cwd,
    });

    expectFailure(
      result,
      "invalid_continuation",
      "workflow.start for workflow invalid-start-workflow returned an invalid continuation node",
    );
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "workflow.failed",
    ]);
  });

  it("fails clearly when a step continuation returns an invalid node", async () => {
    const cwd = await testCwd();
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "invalid-step-continuation-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return step(
          {
            id: "choose-next",
            input,
            outputShape: { value: "number" },
            run: (stepInput) => stepInput,
          },
          () => ({ nope: true }) as never,
          () => done({ value: 0 }),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "invalid-step-continuation",
      cwd,
    });

    expectFailure(
      result,
      "invalid_continuation",
      "step choose-next returned an invalid continuation node",
    );
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.failed",
      "workflow.failed",
    ]);
    expect(result.events[3]).toMatchObject({
      stepId: "choose-next",
      payload: { failure: result.failure },
    });
  });

  it("routes a thrown step error through an error continuation to done", async () => {
    const cwd = await testCwd();
    const workflow: Workflow<{ value: number }, { status: string; summary: string }> = {
      id: "recover-thrown-step-error-workflow",
      inputShape: { value: "number" },
      outputShape: { status: "string", summary: "string" },
      start(input) {
        return step(
          {
            id: "explode",
            input,
            outputShape: { value: "number" },
            run: () => {
              throw new Error("Boom");
            },
          },
          () => done({ status: "unexpected", summary: "should not continue" }),
          (error) => done({ status: "failed", summary: error.message }),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "recover-thrown-step-error",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected workflow to recover through onError.");
    }
    expect(result.output).toEqual({ status: "failed", summary: "Boom" });
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.completed",
    ]);
    expect(result.events[2]).toMatchObject({
      stepId: "explode",
      payload: { failure: { code: "step_execution_failed", message: "Boom" } },
    });
  });

  it("fails clearly when a continuation step declares both run and prompt", async () => {
    const cwd = await testCwd();
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "conflicting-step-mode-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return step(
          {
            id: "conflicting-mode",
            input,
            outputShape: { value: "number" },
            run: (stepInput) => stepInput,
            prompt: "This prompt conflicts with run.",
            requirements: { size: "tiny" },
            adapter: async (request) => {
              await request.tools[0]?.call({ value: 0 });
            },
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "conflicting-step-mode",
      cwd,
    });

    expectFailure(
      result,
      "step_execution_failed",
      "step conflicting-mode must declare exactly one execution mode: run or prompt",
    );
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.failed",
      "workflow.failed",
    ]);
  });

  it("routes a prompt rendering error through onError", async () => {
    const cwd = await testCwd();
    const workflow: Workflow<{ value: number }, { status: string; summary: string }> = {
      id: "recover-prompt-render-error-workflow",
      inputShape: { value: "number" },
      outputShape: { status: "string", summary: "string" },
      start(input) {
        return step(
          {
            id: "render-prompt",
            input,
            outputShape: { answer: "string" },
            prompt: () => {
              throw new Error("Cannot render prompt");
            },
            requirements: { size: "tiny" },
            adapter: async (request) => {
              await request.tools[0]?.call({ answer: "unexpected" });
            },
          },
          () => done({ status: "unexpected", summary: "should not continue" }),
          (error) => done({ status: "failed", summary: error.message }),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "recover-prompt-render-error",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected workflow to recover through onError.");
    }
    expect(result.output).toEqual({ status: "failed", summary: "Cannot render prompt" });
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.failed",
      "workflow.completed",
    ]);
    expect(result.events[1]).toMatchObject({
      stepId: "render-prompt",
      payload: { failure: { code: "step_execution_failed", message: "Cannot render prompt" } },
    });
  });

  it("fails clearly when an error continuation returns an invalid node", async () => {
    const cwd = await testCwd();
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "invalid-error-continuation-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return step(
          {
            id: "explode",
            input,
            outputShape: { value: "number" },
            run: () => {
              throw new Error("Boom");
            },
          },
          () => done({ value: 0 }),
          () => ({ nope: true }) as never,
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "invalid-error-continuation",
      cwd,
    });

    expectFailure(
      result,
      "invalid_continuation",
      "error continuation for step explode returned an invalid continuation node",
    );
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);
    expect(result.events[2]).toMatchObject({
      stepId: "explode",
      payload: { failure: { code: "step_execution_failed", message: "Boom" } },
    });
  });

  it("fails clearly when a continuation working agent needs config but none was provided", async () => {
    const cwd = await testCwd();
    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "missing-agent-config-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { builder: { size: "small" } },
      start(input) {
        return step(
          {
            id: "delegate",
            input,
            outputShape: { answer: "string" },
            agent: "builder",
            prompt: ({ input: stepInput }) => `Answer ${stepInput.task}.`,
          },
          (output) => done(output),
        );
      },
    };
    const requests: unknown[] = [];

    const result = await runWorkflow({
      workflow,
      input: { task: "without config" },
      runName: "missing-agent-config",
      cwd,
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        throw new Error("working agent runner should not be called without config");
      },
    });

    expectFailure(result, "missing_agent_config", "Missing .stepkit/config.json");
    expectFailure(result, "missing_agent_config", "agent 'builder'");
    expect(requests).toEqual([]);
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);
  });

  it("converts thrown code-step errors to stable structured failures", async () => {
    const cwd = await testCwd();
    const objectWithValue = valueSchema();
    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "thrown-step-error-workflow",
      input: objectWithValue,
      output: objectWithValue,
      steps: [
        {
          id: "explode",
          input: objectWithValue,
          output: objectWithValue,
          run: async () => {
            throw new Error("Boom from code step");
          },
        },
      ],
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "thrown-step-error",
      cwd,
    });

    expectFailure(result, "step_execution_failed", "Boom from code step");
    expect(result.failure.details).toEqual({ name: "Error" });
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);
  });
});

function valueSchema(): Schema<{ value: number }> {
  return jsonSchema<{ value: number }>({
    type: "object",
    properties: {
      value: { type: "number" },
    },
    required: ["value"],
    additionalProperties: false,
  });
}

function nameSchema(): Schema<{ name: string }> {
  return jsonSchema<{ name: string }>({
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  });
}

async function testCwd(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "stepkit-core-runtime-failures-"));
}

function expectFailure(
  result: Result<PlainObject>,
  code: string,
  message: string,
): asserts result is Extract<Result<PlainObject>, { status: "failure" }> {
  expect(result.status).toBe("failure");
  if (result.status !== "failure") {
    throw new Error("Expected workflow to fail.");
  }

  expect(result.failure).toMatchObject({
    code,
    message: expect.stringContaining(message),
  });
}

async function expectPersistedEventTypes(runDir: string, expectedTypes: readonly Event["type"][]) {
  const eventsJsonl = await readFile(join(runDir, "events.jsonl"), "utf8");
  const persistedEvents = eventsJsonl
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event);

  expect(persistedEvents.map((event) => event.type)).toEqual(expectedTypes);
}
