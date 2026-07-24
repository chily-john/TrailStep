import { describe, expect, it } from "vitest";

import { resolveStepOutputSchema } from "./resolve-step-output-schema.js";

describe("resolveStepOutputSchema", () => {
  it("uses an explicit output even when mode is interactive", () => {
    const schema = resolveStepOutputSchema({
      output: { value: "number" },
      mode: "interactive",
    });

    expect(schema).toBeDefined();
    expect(schema?.jsonSchema).toEqual({
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false,
    });
  });

  it("falls back to the default interactive output shape when mode is interactive with no output", () => {
    const schema = resolveStepOutputSchema({ mode: "interactive" });

    expect(schema).toBeDefined();
    expect(schema?.jsonSchema).toEqual({
      type: "object",
      properties: { sessionFile: { type: "string" } },
      required: ["sessionFile"],
      additionalProperties: false,
    });
  });

  it("returns undefined for working mode with no output", () => {
    const schema = resolveStepOutputSchema({ mode: "working" });

    expect(schema).toBeUndefined();
  });

  it("returns undefined when mode is omitted entirely and no output is given", () => {
    const schema = resolveStepOutputSchema({});

    expect(schema).toBeUndefined();
  });
});
