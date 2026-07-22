import { describe, expect, it } from "vitest";

import type { StepkitCliPrompts } from "../command.types.js";
import { configureLiteralAgentTarget } from "./configure-target-flow.js";

function fakePrompts(
  expected: readonly {
    readonly label: string;
    readonly choices?: readonly string[];
    readonly answer: string;
  }[],
): StepkitCliPrompts {
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
  it("prompts for a built-in provider, model, and thinking level", async () => {
    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["claude", "codex", "custom"], answer: "claude" },
          { label: "Model", answer: "sonnet" },
          {
            label: "Thinking",
            choices: ["none", "low", "medium", "high", "xhigh", "max"],
            answer: "high",
          },
        ]),
        providerChoices: ["claude", "codex"],
      }),
    ).resolves.toEqual({ target: { provider: "claude", model: "sonnet", thinking: "high" } });
  });

  it("creates a custom provider when requested", async () => {
    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["claude", "custom"], answer: "custom" },
          { label: "Custom provider name", answer: "local-agent" },
          { label: "Custom provider binary", answer: "agent-bin" },
          { label: "Model", answer: "" },
          {
            label: "Thinking",
            choices: ["none", "low", "medium", "high", "xhigh", "max"],
            answer: "none",
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
