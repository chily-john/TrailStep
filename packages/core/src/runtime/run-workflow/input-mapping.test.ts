import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, jsonSchema, runWorkflow, step, type Workflow } from "../../index.js";

describe("step input mapping", () => {
  it("passes mapped input from workflow input and previous step output to a later step", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-input-mapping-"));
    const workflowInput = jsonSchema<{ starting: number; factor: number }>({
      type: "object",
      properties: {
        starting: { type: "number" },
        factor: { type: "number" },
      },
      required: ["starting", "factor"],
      additionalProperties: false,
    });
    const mappedInput = jsonSchema<{ value: number; multiplier: number; runName: string }>({
      type: "object",
      properties: {
        value: { type: "number" },
        multiplier: { type: "number" },
        runName: { type: "string" },
      },
      required: ["value", "multiplier", "runName"],
      additionalProperties: false,
    });
    const finalOutput = jsonSchema<{ result: number }>({
      type: "object",
      properties: { result: { type: "number" } },
      required: ["result"],
      additionalProperties: false,
    });

    const workflow: Workflow<{ starting: number; factor: number }, { result: number }> = {
      id: "mapped-workflow",
      inputShape: workflowInput,
      outputShape: finalOutput,
      start(input) {
        return seedStep(input);
      },
    };

    const seedStep = step({ id: "seed" }).do(
      async (stepInput: { starting: number; factor: number }) => {
        const seedOutput = { value: stepInput.starting + 1 };
        expect(seedOutput).toEqual({ value: 5 });

        return multiplyStep(
          mappedInput.assert(
            {
              value: seedOutput.value,
              multiplier: stepInput.factor,
              runName: "mapped-run",
            },
            "mapped continuation input",
          ),
        );
      },
    );

    const multiplyStep = step({ id: "multiply" }).do(
      async (stepInput: { value: number; multiplier: number; runName: string }) =>
        done({ result: stepInput.value * stepInput.multiplier }),
    );

    const result = await runWorkflow({
      workflow,
      input: { starting: 4, factor: 3 },
      runName: "mapped-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ result: 15 });
  });
});
