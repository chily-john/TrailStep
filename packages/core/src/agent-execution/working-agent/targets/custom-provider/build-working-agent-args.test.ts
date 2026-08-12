import { describe, expect, it } from "vitest";

import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import { buildWorkingAgentArgs } from "./build-working-agent-args.js";

describe("buildWorkingAgentArgs", () => {
  it("keeps default custom provider args omitting model when absent", () => {
    expect(
      buildWorkingAgentArgs({
        argv: undefined,
        promptFile: "/run/prompt.md",
        outputFile: "/run/output.json",
      }),
    ).toEqual(["--prompt-file", "/run/prompt.md", "--output-file", "/run/output.json"]);
  });

  it("drops conditional model and thinking blocks when overrides are omitted", () => {
    const args = buildWorkingAgentArgs({
      argv: [
        "--prompt-file",
        "{{promptFile}}",
        "{{#model}}",
        "--model",
        "{{model}}",
        "{{/model}}",
        "{{#thinking}}",
        "--thinking",
        "{{thinking}}",
        "{{/thinking}}",
      ],
      promptFile: "/run/prompt.md",
      outputFile: "/run/output.json",
    });

    expect(args).toEqual(["--prompt-file", "/run/prompt.md"]);
    expect(args).not.toContain("{{#model}}");
    expect(args).not.toContain("{{/model}}");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("");
    expect(args).not.toContain("--thinking");
  });

  it("includes conditional model and thinking blocks when overrides are present", () => {
    const args = buildWorkingAgentArgs({
      argv: [
        "{{promptFile}}",
        "{{outputFile}}",
        "{{#model}}",
        "--model",
        "{{model}}",
        "{{/model}}",
        "{{#thinking}}",
        "--thinking",
        "{{thinking}}",
        "{{/thinking}}",
      ],
      promptFile: "/run/prompt.md",
      outputFile: "/run/output.json",
      model: "fast",
      thinking: "high",
    });

    expect(args).toEqual([
      "/run/prompt.md",
      "/run/output.json",
      "--model",
      "fast",
      "--thinking",
      "high",
    ]);
  });

  it("rejects unguarded missing optional placeholders", () => {
    expect(() =>
      buildWorkingAgentArgs({
        argv: ["--model", "{{model}}"],
        promptFile: "/run/prompt.md",
        outputFile: "/run/output.json",
      }),
    ).toThrow(TrailStepFailureError);

    try {
      buildWorkingAgentArgs({
        argv: ["--model", "{{model}}"],
        promptFile: "/run/prompt.md",
        outputFile: "/run/output.json",
      });
      throw new Error("Expected unguarded model placeholder to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(TrailStepFailureError);
      expect((error as TrailStepFailureError).failure.code).toBe("agent_provider_invalid");
      expect((error as TrailStepFailureError).failure.message).toMatch(/guarded/i);
    }
  });
});
