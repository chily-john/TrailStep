import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { launchInteractiveAgentTarget } from "./launch-interactive-agent-target.js";

describe("launchInteractiveAgentTarget", () => {
  it("launches manifest providers with interactive templating, no shell, and inherited stdio", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-launch-pi-"));
    const promptFile = join(cwd, "launch-prompt.md");
    const calls: unknown[] = [];

    const result = await launchInteractiveAgentTarget({
      cwd,
      prompt: "Managed session prompt",
      promptFile,
      config: {
        version: 1,
        customProviders: {},
        providers: {
          pi: {
            source: { type: "local-manifest", path: "./pi.trailstep-provider.json" },
            manifest: {
              schemaVersion: 1,
              id: "pi",
              displayName: "Pi",
              working: { supported: false },
              interactive: { supported: true, command: "pi" },
              model: { supported: true },
              thinking: { supported: true, levels: ["high"] },
            },
          },
        },
        agents: {},
      },
      target: {
        provider: "pi",
        model: "openai-codex/gpt-5.5",
        thinking: "high",
        args: [
          "--model",
          "{{model}}",
          "--thinking",
          "{{thinking}}",
          "--prompt-file",
          "{{promptFile}}",
        ],
      },
      runner: async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    });

    expect(result).toEqual({ exitCode: 0, promptInjectionMode: "visible-prompt-file" });
    expect(calls).toEqual([
      expect.objectContaining({
        command: "pi",
        args: [
          "--model",
          "openai-codex/gpt-5.5",
          "--thinking",
          "high",
          "--prompt-file",
          promptFile,
        ],
        cwd,
        shell: false,
        stdio: "inherit",
      }),
    ]);
    await expect(readFile(promptFile, "utf8")).resolves.toBe("Managed session prompt");
  });

  it("reports a helpful manifest provider message when the CLI is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-launch-missing-"));

    await expect(
      launchInteractiveAgentTarget({
        cwd,
        prompt: "Managed session prompt",
        promptFile: join(cwd, "launch-prompt.md"),
        config: {
          version: 1,
          customProviders: {},
          providers: {
            claude: {
              source: { type: "local-manifest", path: "./claude.trailstep-provider.json" },
              manifest: {
                schemaVersion: 1,
                id: "claude",
                displayName: "Claude",
                working: { supported: false },
                interactive: { supported: true, command: "claude" },
                model: { supported: true },
                thinking: { supported: false },
              },
            },
          },
          agents: {},
        },
        target: { provider: "claude" },
        runner: async () => {
          throw new Error("spawn claude ENOENT");
        },
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "agent_provider_spawn_error",
        message: expect.stringMatching(/claude.*not found on PATH/i),
      },
    });
  });

  it("launches custom providers with interactive templating, no shell, and inherited stdio", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-launch-custom-"));
    const promptFile = join(cwd, "launch-prompt.md");
    const calls: unknown[] = [];

    const result = await launchInteractiveAgentTarget({
      cwd,
      prompt: "Managed session prompt",
      promptFile,
      config: {
        version: 1,
        customProviders: {
          local: {
            binary: "local-agent",
            interactiveArgs: [
              "--prompt",
              "{{prompt}}",
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
          },
        },
        agents: {},
      },
      target: { provider: "local", model: "fast", thinking: "high" },
      runner: async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    });

    expect(result).toEqual({ exitCode: 0, promptInjectionMode: "visible-prompt-file" });
    expect(calls).toEqual([
      expect.objectContaining({
        command: "local-agent",
        args: [
          "--prompt",
          "Managed session prompt",
          "--prompt-file",
          promptFile,
          "--model",
          "fast",
          "--thinking",
          "high",
        ],
        cwd,
        shell: false,
        stdio: "inherit",
      }),
    ]);
    await expect(readFile(promptFile, "utf8")).resolves.toBe("Managed session prompt");
  });

  it("fails clearly when a custom provider has no interactive args", async () => {
    await expect(
      launchInteractiveAgentTarget({
        cwd: ".",
        prompt: "prompt",
        promptFile: "prompt.md",
        config: {
          version: 1,
          customProviders: { local: { binary: "local-agent" } },
          agents: {},
        },
        target: { provider: "local" },
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "agent_provider_interactive_unsupported",
        message: expect.stringMatching(/interactiveArgs/i),
      },
    });
  });
});
