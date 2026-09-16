import { describe, expect, it } from "vitest";

import { defineWorkflow, done, jsonSchema, notify, step, subPrompt, workflow } from "./index.js";

describe("@trailstep/authoring exports", () => {
  it("exports workflow authoring primitives", () => {
    expect(defineWorkflow).toBeTypeOf("function");
    expect(step).toBeTypeOf("function");
    expect(subPrompt).toBeTypeOf("function");
    expect(done).toBeTypeOf("function");
    expect(notify.progress).toBeTypeOf("function");
    expect(workflow.input).toBeTypeOf("function");
  });

  it("exports subPrompt and related public types", () => {
    expect(subPrompt).toBeTypeOf("function");

    const assertPublicSubPromptTypes = () => {
      const output = jsonSchema<{ answer: string }>({
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      });
      const requiredInputSubPrompt = subPrompt<{ path: string }, { answer: string }>(
        ({ input }) => `Read ${input.path}`,
        { output },
      );
      requiredInputSubPrompt({ path: "story.md" });
      // @ts-expect-error required input keys must be provided.
      requiredInputSubPrompt();

      // biome-ignore lint/complexity/noBannedTypes: public subPrompt authoring supports `{}` as the no-required-input type.
      const optionalInputSubPrompt = subPrompt<{}, { answer: string }>("Answer briefly.", {
        output,
      });
      optionalInputSubPrompt();
      optionalInputSubPrompt({});

      const factory = requiredInputSubPrompt satisfies import("./index.js").SubPromptFactory<
        { path: string },
        { answer: string }
      >;
      const options = {
        output,
        agent: "researcher",
        adapter: async () => undefined,
        maxSubPrompts: 3,
      } satisfies import("./index.js").SubPromptOptions<{ answer: string }>;
      const optionsWithMode = {
        // @ts-expect-error subPrompt options intentionally do not support prompt mode selection.
        mode: "working",
      } satisfies import("./index.js").SubPromptOptions<{ answer: string }>;

      return { factory, options, optionsWithMode };
    };

    expect(assertPublicSubPromptTypes).toBeTypeOf("function");
  });
});
