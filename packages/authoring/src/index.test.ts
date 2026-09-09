import { describe, expect, it } from "vitest";

import { defineWorkflow, done, notify, step, workflow } from "./index.js";

describe("@trailstep/authoring exports", () => {
  it("exports workflow authoring primitives", () => {
    expect(defineWorkflow).toBeTypeOf("function");
    expect(step).toBeTypeOf("function");
    expect(done).toBeTypeOf("function");
    expect(notify.progress).toBeTypeOf("function");
    expect(workflow.input).toBeTypeOf("function");
  });
});
