import { describe, expect, it } from "vitest";

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
