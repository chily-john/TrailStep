import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type InteractiveProcessRunner,
  jsonSchema,
  type PlainObject,
  type Result,
  runWorkflow,
  type Workflow,
} from "../../index.js";

describe("interactive file output (deprecated static workflow compatibility)", () => {
  it("reads and validates a file-based interactive output before running the next step", async () => {
    const cwd = await testCwd();
    const sessionCompletedPayloads: unknown[] = [];
    const workflow = fileOutputWorkflow();

    const processRunner: InteractiveProcessRunner = async (call) => {
      await writeFile(join(call.cwd, "result.json"), JSON.stringify({ answer: "from file" }));
      return { exitCode: 0 };
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "interactive-file-run",
      cwd,
      processRunner,
      eventSink: (event) => {
        if (event.type === "interactive.sessionCompleted") {
          sessionCompletedPayloads.push(event.payload);
        }
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ received: "from file" });
    expect(sessionCompletedPayloads).toContainEqual({ exitCode: 0, outputMode: "file" });
  });

  it("fails with a structured failure when the result file is missing", async () => {
    const result = await runWorkflow({
      workflow: fileOutputWorkflow(),
      input: {},
      runName: "interactive-file-missing-result",
      cwd: await testCwd(),
      processRunner: async () => ({ exitCode: 0 }),
    });

    expectFailure(result, "interactive_result_file_unreadable", "result file could not be read");
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "interactive.sessionStarted",
      "step.failed",
      "workflow.failed",
    ]);
  });

  it.each([
    ["invalid JSON", "{"],
    ["non-object JSON", JSON.stringify(["not", "an", "object"])],
  ])("fails with a structured failure when the result file contains %s", async (_label, contents) => {
    const result = await runWorkflow({
      workflow: fileOutputWorkflow(),
      input: {},
      runName: "interactive-file-invalid-json",
      cwd: await testCwd(),
      processRunner: async (call) => {
        await writeFile(join(call.cwd, "result.json"), contents);
        return { exitCode: 0 };
      },
    });

    expectFailure(
      result,
      "interactive_result_file_invalid_json",
      "result file must contain valid JSON object output",
    );
  });

  it("fails the step through normal output schema validation when result JSON is schema-invalid", async () => {
    const result = await runWorkflow({
      workflow: fileOutputWorkflow(),
      input: {},
      runName: "interactive-file-schema-invalid",
      cwd: await testCwd(),
      processRunner: async (call) => {
        await writeFile(join(call.cwd, "result.json"), JSON.stringify({ answer: 42 }));
        return { exitCode: 0 };
      },
    });

    expectFailure(result, "validation_failed", "step ask-agent output failed schema validation");
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "interactive.sessionStarted",
      "interactive.sessionCompleted",
      "step.failed",
      "workflow.failed",
    ]);
  });

  it("rejects relative result file paths that escape the run directory", async () => {
    let processStarted = false;
    const result = await runWorkflow({
      workflow: fileOutputWorkflow({ resultFile: "../outside.json" }),
      input: {},
      runName: "interactive-file-unsafe-result-path",
      cwd: await testCwd(),
      processRunner: async () => {
        processStarted = true;
        return { exitCode: 0 };
      },
    });

    expectFailure(
      result,
      "interactive_result_file_invalid",
      "result file must stay under the run directory",
    );
    expect(processStarted).toBe(false);
  });

  it.each([
    ["omitted", undefined],
    ["non-string", 42],
  ])("rejects a file-mode interactive step with an %s result file declaration", async (_label, resultFile) => {
    const result = await runWorkflow({
      workflow: fileOutputWorkflow({ resultFile }),
      input: {},
      runName: "interactive-file-invalid-declaration",
      cwd: await testCwd(),
      processRunner: async () => ({ exitCode: 0 }),
    });

    expectFailure(result, "interactive_result_file_invalid", "must declare a result file path");
  });
});

function fileOutputWorkflow(
  options: { readonly resultFile?: unknown } = {},
): Workflow<Record<string, never>, { received: string }> {
  const objectSchema = jsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
    additionalProperties: false,
  });

  return {
    id: "interactive-file-workflow",
    input: objectSchema,
    output: jsonSchema<{ received: string }>({
      type: "object",
      properties: { received: { type: "string" } },
      required: ["received"],
      additionalProperties: false,
    }),
    steps: [
      {
        kind: "interactive",
        id: "ask-agent",
        command: "agent --result result.json",
        prompt: "Write structured output.",
        outputMode: "file",
        resultFile: "resultFile" in options ? options.resultFile : "result.json",
        output: jsonSchema<{ answer: string }>({
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        }),
      },
      {
        id: "consume-output",
        input: jsonSchema<{ answer: string }>({
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        }),
        output: jsonSchema<{ received: string }>({
          type: "object",
          properties: { received: { type: "string" } },
          required: ["received"],
          additionalProperties: false,
        }),
        run(input) {
          return { received: input.answer };
        },
      },
    ],
  } as Workflow<Record<string, never>, { received: string }>;
}

async function testCwd(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "stepkit-core-interactive-file-output-"));
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
