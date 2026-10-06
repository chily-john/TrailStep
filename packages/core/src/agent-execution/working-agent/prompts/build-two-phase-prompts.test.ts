import { describe, expect, it } from "vitest";

import { buildFormatPrompt, buildWorkPrompt } from "./build-two-phase-prompts.js";

describe("buildWorkPrompt", () => {
  it("embeds the original prompt verbatim under the original prompt heading", () => {
    const prompt = "Fix the failing unit test in packages/core and report what you changed.";

    const workPrompt = buildWorkPrompt({ prompt });

    expect(workPrompt).toContain("## Original prompt");
    expect(workPrompt).toContain(prompt);
  });

  it("says nothing about output files, JSON, or schemas", () => {
    const workPrompt = buildWorkPrompt({ prompt: "Do the task." });

    expect(workPrompt).not.toMatch(/json/i);
    expect(workPrompt).not.toMatch(/schema/i);
    expect(workPrompt).not.toMatch(/output/i);
    expect(workPrompt).not.toMatch(/\.json/i);
  });
});

describe("buildFormatPrompt", () => {
  const outputSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "continue", "question", "blocked"] },
      summary: { type: "string" },
    },
    required: ["status", "summary"],
  };

  it("includes the stringified output schema", () => {
    const formatPrompt = buildFormatPrompt({ outputSchema });

    expect(formatPrompt).toContain(JSON.stringify(outputSchema, null, 2));
  });

  it("requires exactly one JSON object as the entire final answer", () => {
    const formatPrompt = buildFormatPrompt({ outputSchema });

    expect(formatPrompt).toMatch(/exactly one JSON object/);
    expect(formatPrompt).toMatch(/Do not include prose, markdown fences, or multiple JSON values/);
  });

  it("renders validation errors when provided", () => {
    const formatPrompt = buildFormatPrompt({
      outputSchema,
      validationErrors: ["status must be one of completed, continue, question, blocked."],
    });

    expect(formatPrompt).toContain("failed validation");
    expect(formatPrompt).toContain(
      "- status must be one of completed, continue, question, blocked.",
    );
  });

  it("omits the validation error section when validation errors are absent", () => {
    const formatPrompt = buildFormatPrompt({ outputSchema });

    expect(formatPrompt).not.toContain("failed validation");
  });

  it("omits the validation error section when validation errors are empty", () => {
    const formatPrompt = buildFormatPrompt({ outputSchema, validationErrors: [] });

    expect(formatPrompt).not.toContain("failed validation");
  });
});
