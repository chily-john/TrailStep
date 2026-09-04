import { describe, expect, it } from "vitest";
import { TrailStepFailureError } from "../contracts/failures/failure.js";
import {
  parseTrailStepProviderManifest,
  parseTrailStepProviderRegistrations,
} from "./provider-manifest.js";

describe("provider manifest validation", () => {
  it("preserves provider-specific package manifest invocation fields", () => {
    const diagnostics: string[] = [];

    const manifest = parseTrailStepProviderManifest(
      "trailstepProvider.manifest",
      {
        schemaVersion: 1,
        id: "claude",
        displayName: "Claude",
        working: {
          supported: true,
          command: "claude",
          prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
          output: {
            style: "stdout-json-envelope",
            parsing: { resultField: "result" },
          },
        },
        interactive: {
          supported: true,
          command: "claude",
          requiresSystemPromptFile: true,
          systemPromptFileFlag: "--append-system-prompt-file",
          modelFlag: "--model",
          permissionBypassFlag: "--dangerously-skip-permissions",
        },
        model: { supported: true, flag: "--model" },
        thinking: {
          supported: true,
          flag: "--effort",
          levels: ["low", "medium", "high", "xhigh", "max"],
        },
      },
      diagnostics,
    );

    expect(diagnostics).toEqual([]);
    expect(manifest).toMatchObject({
      working: {
        prompt: { reference: "at-prefixed-argument" },
        output: { style: "stdout-json-envelope", parsing: { resultField: "result" } },
      },
      interactive: {
        requiresSystemPromptFile: true,
        systemPromptFileFlag: "--append-system-prompt-file",
        modelFlag: "--model",
        permissionBypassFlag: "--dangerously-skip-permissions",
      },
      model: { flag: "--model" },
      thinking: { flag: "--effort", levels: ["low", "medium", "high", "xhigh", "max"] },
    });
  });

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
