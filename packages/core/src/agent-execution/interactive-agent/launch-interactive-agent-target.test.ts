import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { launchInteractiveAgentTarget } from "./launch-interactive-agent-target.js";

describe("launchInteractiveAgentTarget", () => {
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
