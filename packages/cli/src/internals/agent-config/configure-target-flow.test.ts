import { describe, expect, it, vi } from "vitest";

import type { TrailStepCliPrompts } from "../command.types.js";
import { configureLiteralAgentTarget } from "./configure-target-flow.js";

function fakePrompts(
  expected: readonly {
    readonly label: string;
    readonly choices?: readonly string[];
    readonly answer: string;
  }[],
): TrailStepCliPrompts {
  const queue = [...expected];
  return {
    async text(label) {
      const next = queue.shift();
      if (next === undefined || next.label !== label || next.choices !== undefined) {
        throw new Error(`Unexpected text prompt ${label}`);
      }
      return next.answer;
    },
    async select(label, choices) {
      const next = queue.shift();
      if (next === undefined || next.label !== label || next.choices === undefined) {
        throw new Error(`Unexpected select prompt ${label}`);
      }
      expect(choices).toEqual(next.choices);
      return next.answer;
    },
    async confirm(label) {
      const next = queue.shift();
      if (next === undefined || next.label !== label || next.choices !== undefined) {
        throw new Error(`Unexpected confirm prompt ${label}`);
      }
      return next.answer === "yes";
    },
  };
}

describe("configureLiteralAgentTarget", () => {
  it("omits model and thinking overrides when provider defaults are selected", async () => {
    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["claude", "custom"], answer: "claude" },
          {
            label: "Model override",
            choices: ["Use provider default", "Type manually"],
            answer: "Use provider default",
          },
          {
            label: "Reasoning/thinking override",
            choices: ["Use provider default", "low", "medium", "high", "xhigh", "max"],
            answer: "Use provider default",
          },
        ]),
        providerChoices: ["claude"],
      }),
    ).resolves.toEqual({ target: { provider: "claude" } });
  });

  it("prompts for a built-in provider, model, and thinking level", async () => {
    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["claude", "codex", "custom"], answer: "claude" },
          {
            label: "Model override",
            choices: ["Use provider default", "Type manually"],
            answer: "Type manually",
          },
          { label: "Model", answer: "sonnet" },
          {
            label: "Reasoning/thinking override",
            choices: ["Use provider default", "low", "medium", "high", "xhigh", "max"],
            answer: "high",
          },
        ]),
        providerChoices: ["claude", "codex"],
      }),
    ).resolves.toEqual({ target: { provider: "claude", model: "sonnet", thinking: "high" } });
  });

  it("filters thinking override choices by provider spec", async () => {
    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["codex", "custom"], answer: "codex" },
          {
            label: "Model override",
            choices: ["Use provider default", "Type manually"],
            answer: "Use provider default",
          },
          {
            label: "Reasoning/thinking override",
            choices: ["Use provider default", "low", "medium", "high", "xhigh"],
            answer: "xhigh",
          },
        ]),
        providerChoices: ["codex"],
      }),
    ).resolves.toEqual({ target: { provider: "codex", thinking: "xhigh" } });
  });

  it("skips thinking override for Gemini", async () => {
    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["gemini", "custom"], answer: "gemini" },
          {
            label: "Model override",
            choices: ["Use provider default", "Type manually"],
            answer: "Use provider default",
          },
        ]),
        providerChoices: ["gemini"],
      }),
    ).resolves.toEqual({ target: { provider: "gemini" } });
  });

  it("offers discovered Pi models in the model override prompt", async () => {
    const packageCommands: unknown[] = [];

    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["pi", "custom"], answer: "pi" },
          {
            label: "Model override",
            choices: [
              "Use provider default",
              "anthropic/claude-sonnet-4-5",
              "openai/gpt-5",
              "Type manually",
            ],
            answer: "anthropic/claude-sonnet-4-5",
          },
          {
            label: "Reasoning/thinking override",
            choices: ["Use provider default", "low", "medium", "high", "xhigh", "max"],
            answer: "Use provider default",
          },
        ]),
        providerChoices: ["pi"],
        cwd: "/project",
        io: { writeLine: vi.fn(), writeError: vi.fn() },
        packageCommandRunner: async (request) => {
          packageCommands.push(request);
          return {
            exitCode: 0,
            stdout: ["provider   model", "anthropic  claude-sonnet-4-5", "openai     gpt-5"].join(
              "\n",
            ),
          };
        },
      }),
    ).resolves.toEqual({ target: { provider: "pi", model: "anthropic/claude-sonnet-4-5" } });
    expect(packageCommands).toEqual([{ command: "pi", args: ["--list-models"], cwd: "/project" }]);
  });

  it("warns and falls back when Pi model discovery fails", async () => {
    const writeError = vi.fn();

    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["pi", "custom"], answer: "pi" },
          {
            label: "Model override",
            choices: ["Use provider default", "Type manually"],
            answer: "Use provider default",
          },
          {
            label: "Reasoning/thinking override",
            choices: ["Use provider default", "low", "medium", "high", "xhigh", "max"],
            answer: "Use provider default",
          },
        ]),
        providerChoices: ["pi"],
        cwd: "/project",
        io: { writeLine: vi.fn(), writeError },
        packageCommandRunner: async () => ({
          exitCode: 1,
          stderr: "pi unavailable",
        }),
      }),
    ).resolves.toEqual({ target: { provider: "pi" } });
    expect(writeError).toHaveBeenCalledWith(
      "Warning: Could not discover Pi models; continuing with manual model entry.",
    );
  });

  it("creates a custom provider when requested", async () => {
    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["claude", "custom"], answer: "custom" },
          { label: "Custom provider name", answer: "local-agent" },
          { label: "Custom provider binary", answer: "agent-bin" },
          {
            label: "Model override",
            choices: ["Use provider default", "Type manually"],
            answer: "Type manually",
          },
          { label: "Model", answer: "" },
          {
            label: "Reasoning/thinking override",
            choices: ["Use provider default", "low", "medium", "high", "xhigh", "max"],
            answer: "Use provider default",
          },
        ]),
        providerChoices: ["claude"],
      }),
    ).resolves.toEqual({
      customProvider: { name: "local-agent", config: { binary: "agent-bin" } },
      target: { provider: "local-agent" },
    });
  });
});
