import { describe, expect, it } from "vitest";

import { defineWorkflow, done, step } from "./index.js";

describe("@stepkit/sdk exports", () => {
  it("exports v0 workflow authoring primitives", () => {
    expect(defineWorkflow).toBeTypeOf("function");
    expect(step).toBeTypeOf("function");
    expect(done).toBeTypeOf("function");
  });
});
