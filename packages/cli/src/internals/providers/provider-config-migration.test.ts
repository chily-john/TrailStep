import { describe, expect, it } from "vitest";

describe("migrateLegacyCustomProvidersConfig", () => {
  it("rewrites legacy customProviders into providers without dropping interactiveArgs or env", async () => {
    const { migrateLegacyCustomProvidersConfig } = await import("./provider-config-migration.js");

    expect(
      migrateLegacyCustomProvidersConfig({
        customProviders: {
          local: {
            binary: "local-agent",
            args: ["--json"],
            interactiveArgs: ["--tty", "--session", "{{sessionId}}"],
            cwd: "./agents/local",
            env: { API_KEY: "secret", FEATURE_FLAG: "on" },
            model: { supported: true, flag: "--model" },
            thinking: { supported: true, flag: "--thinking", levels: ["low", "high"] },
          },
        },
        agents: {
          default: [{ provider: "local", model: "fast", thinking: "high" }],
        },
      }),
    ).toEqual({
      config: {
        providers: {
          local: {
            source: { type: "legacy-custom-provider" },
            manifest: {
              schemaVersion: 1,
              id: "local",
              displayName: "local",
              working: {
                supported: true,
                command: "local-agent",
                args: ["--json"],
                prompt: { kind: "prompt-file" },
                output: { style: "provider-output-file" },
              },
              interactive: {
                supported: true,
                command: "local-agent",
                args: ["--tty", "--session", "{{sessionId}}"],
              },
              model: { supported: true, flag: "--model" },
              thinking: { supported: true, flag: "--thinking", levels: ["low", "high"] },
              cwd: "./agents/local",
              env: { API_KEY: "secret", FEATURE_FLAG: "on" },
            },
          },
        },
        agents: {
          default: [{ provider: "local", model: "fast", thinking: "high" }],
        },
      },
      diagnostics: [],
    });
  });
});
