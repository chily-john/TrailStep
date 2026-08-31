import { describe, expect, it } from "vitest";

import { parseTrailStepConfig } from "../agent-targeting/parse-trailstep-config/parse-trailstep-config.js";

describe("package-backed provider hook metadata", () => {
  it("preserves serializable hook metadata on package provider registrations", () => {
    const parsed = parseTrailStepConfig({
      version: 1,
      customProviders: {},
      providers: {
        "hook-agent": {
          source: {
            type: "npm",
            packageName: "@example/hook-agent",
            spec: "@example/hook-agent",
            resolvedVersion: "1.2.3",
          },
          manifest: {
            schemaVersion: 1,
            id: "hook-agent",
            displayName: "Hook Agent",
            working: {
              supported: true,
              command: "hook-agent",
              args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
              prompt: { kind: "prompt-file" },
              output: { style: "provider-output-file" },
            },
            interactive: { supported: false, reason: "Working-agent only." },
            model: { supported: false },
            thinking: { supported: false },
            hooks: {
              extractOutput: { supported: true, source: "package" },
              repairOutput: { supported: true, source: "package" },
            },
          },
        },
      },
      agents: {
        default: [{ provider: "hook-agent" }],
      },
    });

    expect(
      (parsed.providers["hook-agent"]?.manifest as unknown as { hooks?: unknown }).hooks,
    ).toEqual({
      extractOutput: { supported: true, source: "package" },
      repairOutput: { supported: true, source: "package" },
    });
  });
});
