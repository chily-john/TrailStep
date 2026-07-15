import { describe, expect, it } from "vitest";

import { jsonSchema, runWorkflow } from "./index.js";

describe("@stepkit/core public API", () => {
  it("exports runtime APIs", () => {
    expect(runWorkflow).toBeTypeOf("function");
    expect(jsonSchema).toBeTypeOf("function");
  });
});
