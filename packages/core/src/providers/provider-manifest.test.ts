import { describe, expect, it } from "vitest";
import { TrailStepFailureError } from "../contracts/failures/failure.js";
import { parseTrailStepProviderRegistrations } from "./provider-manifest.js";

describe("provider manifest validation", () => {
  it("reports actionable diagnostics for malformed provider manifests", () => {
    try {
      parseTrailStepProviderRegistrations(
        "providers",
        {
          "echo-agent": {
            source: { type: "local-manifest", path: "./echo-provider.json" },
            manifest: {
              schemaVersion: 1,
              displayName: "Echo Agent",
              working: {
                supported: true,
                args: ["--prompt-file", "{{promptFile}}"],
                prompt: { kind: "prompt-file" },
                output: { style: "provider-output-file" },
              },
              interactive: { supported: false, reason: "No interactive mode" },
              model: { supported: false },
              thinking: { supported: false },
            },
          },
        },
        [],
      );
      throw new Error("Expected provider manifest parsing to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(TrailStepFailureError);
      expect((error as TrailStepFailureError).failure.details).toEqual({
        diagnostics: expect.arrayContaining([
          "providers.echo-agent.manifest.id must be a non-empty string.",
          "providers.echo-agent.manifest.working.command must be a non-empty string.",
        ]),
      });
    }
  });
});
