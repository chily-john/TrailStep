import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchema, runWorkflow, type Workflow } from "@trailstep/core";
import { describe, expect, it } from "vitest";
import { defineWorkflow, done, step } from "./index.js";

interface GreetingInput extends Record<string, unknown> {
  readonly name: string;
}

interface GreetingOutput extends Record<string, unknown> {
  readonly message: string;
}

describe("authoring workflow builders", () => {
  it("defines a continuation workflow with step and done that runs through core", async () => {
    const greetingOutput = jsonSchema<GreetingOutput>({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    });

    const workflow = defineWorkflow({
      id: "greeting-workflow",
      description: "Builds a greeting from mapped input.",
      inputShape: jsonSchema<{ readonly person: string } & Record<string, unknown>>({
        type: "object",
        properties: { person: { type: "string" } },
        required: ["person"],
        additionalProperties: false,
      }),
      outputShape: greetingOutput,
      start(input) {
        return step({
          id: "greet",
        }).do((stepInput: GreetingInput) => done({ message: `Hello, ${stepInput.name}!` }))({
          name: input.person,
        });
      },
    });

    const assignableWorkflow: Workflow<
      { readonly person: string } & Record<string, unknown>,
      GreetingOutput
    > = workflow;

    expect(assignableWorkflow).toMatchObject({
      id: "greeting-workflow",
      description: "Builds a greeting from mapped input.",
    });

    const cwd = await mkdtemp(join(tmpdir(), "stepkit-authoring-builder-test-"));
    const result = await runWorkflow({
      workflow,
      input: { person: "Ada" },
      runName: "authoring-builder-test",
      cwd,
    });

    expect(result).toMatchObject({
      status: "success",
      output: { message: "Hello, Ada!" },
    });
  });

  it("defines a workflow with workflow-level agents and a step-level agent reference", () => {
    const workflow = defineWorkflow<
      { readonly path: string } & Record<string, unknown>,
      { readonly approved: boolean } & Record<string, unknown>
    >({
      id: "portable-review",
      agents: {
        reviewer: { description: "Reviews generated output.", size: "small" },
      },
      inputShape: { path: "string" },
      outputShape: { approved: "boolean" },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.path}.`, {
            output: { approved: "boolean" },
            agent: "reviewer",
          })
          .do(done)(input);
      },
    });

    const assignableWorkflow: Workflow<
      { readonly path: string } & Record<string, unknown>,
      { readonly approved: boolean } & Record<string, unknown>
    > = workflow;

    expect(assignableWorkflow.agents).toEqual({
      reviewer: { description: "Reviews generated output.", size: "small" },
    });
    expect(assignableWorkflow.start?.({ path: "README.md" })).toMatchObject({
      kind: "step",
      config: {
        id: "review",
        agent: "reviewer",
      },
    });
  });

  it("rejects missing or non-function starts", () => {
    const inputShape = jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    });

    expect(() =>
      defineWorkflow({
        id: "missing-start",
        inputShape,
        outputShape: inputShape,
      } as never),
    ).toThrow(/start function/i);

    expect(() =>
      defineWorkflow({
        id: "invalid-start",
        inputShape,
        outputShape: inputShape,
        start: "not a function",
      } as never),
    ).toThrow(/start function/i);
  });
});
