import { describe, expect, it } from "vitest";

import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import { renderCustomProviderArgs } from "./render-custom-provider-args.js";

describe("renderCustomProviderArgs", () => {
  it("renders interpolated at-prefixed prompt file arguments", () => {
    const args = renderCustomProviderArgs({
      argv: ["--prompt-file", "@{{promptFile}}", "--output-file", "{{outputFile}}"],
      values: { promptFile: "/run/prompt.md", outputFile: "/run/output.json" },
      errorCode: "agent_provider_invalid",
      commandDescription: "custom provider command",
    });

    expect(args).toEqual(["--prompt-file", "@/run/prompt.md", "--output-file", "/run/output.json"]);
  });

  it("keeps conditional model and thinking blocks only when overrides are present", () => {
    const argv = [
      "{{promptFile}}",
      "{{#model}}",
      "--model",
      "{{model}}",
      "{{/model}}",
      "{{#thinking}}",
      "-c",
      "model_reasoning_effort={{thinking}}",
      "{{/thinking}}",
    ];

    expect(
      renderCustomProviderArgs({
        argv,
        values: { promptFile: "/run/prompt.md" },
        errorCode: "agent_provider_invalid",
        commandDescription: "custom provider command",
      }),
    ).toEqual(["/run/prompt.md"]);

    expect(
      renderCustomProviderArgs({
        argv,
        values: { promptFile: "/run/prompt.md", model: "fast", thinking: "high" },
        errorCode: "agent_provider_invalid",
        commandDescription: "custom provider command",
      }),
    ).toEqual(["/run/prompt.md", "--model", "fast", "-c", "model_reasoning_effort=high"]);
  });

  it("rejects conditional sessionId blocks as unsupported template tokens", () => {
    expect(() =>
      renderCustomProviderArgs({
        argv: ["{{#sessionId}}", "--resume", "{{sessionId}}", "{{/sessionId}}"],
        values: { sessionId: "session-1" },
        errorCode: "agent_provider_invalid",
        commandDescription: "custom provider command",
      }),
    ).toThrow(TrailStepFailureError);
  });

  it("rejects unguarded placeholders when the value is unavailable", () => {
    expect(() =>
      renderCustomProviderArgs({
        argv: ["--prompt-file", "{{promptFile}}"],
        values: {},
        errorCode: "agent_provider_invalid",
        commandDescription: "custom provider command",
      }),
    ).toThrow(TrailStepFailureError);
  });
});
