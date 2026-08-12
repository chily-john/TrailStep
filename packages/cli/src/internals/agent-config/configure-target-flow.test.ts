import { describe, expect, it, vi } from "vitest";

import type { TrailStepCliPrompts } from "../command.types.js";
import { configureLiteralAgentTarget } from "./configure-target-flow.js";

const WORKING_ARGS_PROMPT =
  "Working/print-mode args JSON array (blank for TrailStep defaults; placeholders: {{promptFile}}, {{outputFile}}, {{#model}}...{{/model}}, {{#thinking}}...{{/thinking}})";
const INTERACTIVE_ARGS_PROMPT =
  "Interactive args JSON array (blank for TrailStep defaults; placeholders: {{promptFile}}, {{prompt}}, {{#model}}...{{/model}}, {{#thinking}}...{{/thinking}})";

function fakePrompts(
  expected: readonly {
    readonly label: string;
    readonly choices?: readonly string[];
    readonly answer: string | readonly string[];
  }[],
): TrailStepCliPrompts {
  const queue = [...expected];
  return {
    async text(label) {
      const next = queue.shift();
      if (
        next === undefined ||
        next.label !== label ||
        next.choices !== undefined ||
        typeof next.answer !== "string"
      ) {
        throw new Error(`Unexpected text prompt ${label}`);
      }
      return next.answer;
    },
    async select(label, choices) {
      const next = queue.shift();
      if (
        next === undefined ||
        next.label !== label ||
        next.choices === undefined ||
        typeof next.answer !== "string"
      ) {
        throw new Error(`Unexpected select prompt ${label}`);
      }
      expect(choices).toEqual(next.choices);
      return next.answer;
    },
    async multiSelect(label, choices) {
      const next = queue.shift();
      if (
        next === undefined ||
        next.label !== label ||
        next.choices === undefined ||
        !Array.isArray(next.answer)
      ) {
        throw new Error(`Unexpected multiSelect prompt ${label}`);
      }
      expect(choices).toEqual(next.choices);
      return next.answer;
    },
    async confirm(label) {
      const next = queue.shift();
      if (
        next === undefined ||
        next.label !== label ||
        next.choices !== undefined ||
        typeof next.answer !== "string"
      ) {
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

  it("custom provider wizard collects standardized provider concepts", async () => {
    const history: Array<{
      readonly kind: "text" | "select" | "confirm" | "multiSelect";
      readonly label: string;
      readonly choices?: readonly string[];
    }> = [];
    const prompts: TrailStepCliPrompts = {
      async text(label) {
        history.push({ kind: "text", label });
        if (label === "Custom provider name") {
          return "local-agent";
        }
        if (label === "Custom provider binary") {
          return "agent-bin";
        }
        if (label === WORKING_ARGS_PROMPT) {
          return "";
        }
        if (label === INTERACTIVE_ARGS_PROMPT) {
          return "";
        }
        throw new Error(`Unexpected text prompt ${label}`);
      },
      async select(label, choices) {
        history.push({ kind: "select", label, choices });
        if (label === "Provider") {
          return "custom";
        }
        if (label === "Prompt input style") {
          return "Prompt file path ({{promptFile}})";
        }
        if (label === "Output style") {
          return "Output file path ({{outputFile}})";
        }
        if (label === "Model override") {
          return "Use provider default";
        }
        if (label === "Reasoning/thinking override") {
          return "Use provider default";
        }
        throw new Error(`Unexpected select prompt ${label}`);
      },
      async confirm(label) {
        history.push({ kind: "confirm", label });
        if (label === "Custom provider supports interactive steps?") {
          return true;
        }
        if (label === "Custom provider supports model overrides?") {
          return true;
        }
        if (label === "Custom provider supports thinking overrides?") {
          return true;
        }
        throw new Error(`Unexpected confirm prompt ${label}`);
      },
      async multiSelect(label, choices) {
        history.push({ kind: "multiSelect", label, choices });
        if (label === "Supported thinking levels") {
          return ["low", "high"];
        }
        throw new Error(`Unexpected multiSelect prompt ${label}`);
      },
    };

    await expect(
      configureLiteralAgentTarget({
        prompts,
        providerChoices: ["claude"],
      }),
    ).resolves.toMatchObject({
      customProvider: { name: "local-agent" },
      target: { provider: "local-agent" },
    });

    expect(history.map((entry) => entry.label)).toEqual(
      expect.arrayContaining([
        "Provider",
        "Custom provider name",
        "Custom provider binary",
        "Prompt input style",
        "Output style",
        "Custom provider supports interactive steps?",
        "Custom provider supports model overrides?",
        "Custom provider supports thinking overrides?",
        "Supported thinking levels",
        "Model override",
        "Reasoning/thinking override",
      ]),
    );
    expect(history.some((entry) => entry.label.startsWith("Working/print-mode args"))).toBe(true);
    expect(history.some((entry) => entry.label.startsWith("Interactive args JSON array"))).toBe(
      true,
    );
    expect(history.find((entry) => entry.label === "Supported thinking levels")?.choices).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(history.find((entry) => entry.label === "Reasoning/thinking override")?.choices).toEqual(
      ["Use provider default", "low", "high"],
    );
  });

  it("custom provider default choices omit model and thinking overrides", async () => {
    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["claude", "custom"], answer: "custom" },
          { label: "Custom provider name", answer: "local-agent" },
          { label: "Custom provider binary", answer: "agent-bin" },
          {
            label: "Prompt input style",
            choices: ["Prompt file path ({{promptFile}})"],
            answer: "Prompt file path ({{promptFile}})",
          },
          {
            label: "Output style",
            choices: ["Output file path ({{outputFile}})"],
            answer: "Output file path ({{outputFile}})",
          },
          { label: "Custom provider supports interactive steps?", answer: "no" },
          { label: "Custom provider supports model overrides?", answer: "yes" },
          { label: "Custom provider supports thinking overrides?", answer: "yes" },
          {
            label: "Supported thinking levels",
            choices: ["low", "medium", "high", "xhigh", "max"],
            answer: ["low", "high"],
          },
          { label: WORKING_ARGS_PROMPT, answer: "" },
          {
            label: "Model override",
            choices: ["Use provider default", "Type manually"],
            answer: "Use provider default",
          },
          {
            label: "Reasoning/thinking override",
            choices: ["Use provider default", "low", "high"],
            answer: "Use provider default",
          },
        ]),
        providerChoices: ["claude"],
      }),
    ).resolves.toEqual({
      customProvider: {
        name: "local-agent",
        config: {
          binary: "agent-bin",
          args: [
            "--prompt-file",
            "{{promptFile}}",
            "--output-file",
            "{{outputFile}}",
            "{{#model}}",
            "--model",
            "{{model}}",
            "{{/model}}",
            "{{#thinking}}",
            "--thinking",
            "{{thinking}}",
            "{{/thinking}}",
          ],
          model: { supported: true },
          thinking: { supported: true, levels: ["low", "high"] },
        },
      },
      target: { provider: "local-agent" },
    });
  });

  it("creates a custom provider when requested", async () => {
    await expect(
      configureLiteralAgentTarget({
        prompts: fakePrompts([
          { label: "Provider", choices: ["claude", "custom"], answer: "custom" },
          { label: "Custom provider name", answer: "local-agent" },
          { label: "Custom provider binary", answer: "agent-bin" },
          {
            label: "Prompt input style",
            choices: ["Prompt file path ({{promptFile}})"],
            answer: "Prompt file path ({{promptFile}})",
          },
          {
            label: "Output style",
            choices: ["Output file path ({{outputFile}})"],
            answer: "Output file path ({{outputFile}})",
          },
          { label: "Custom provider supports interactive steps?", answer: "no" },
          { label: "Custom provider supports model overrides?", answer: "yes" },
          { label: "Custom provider supports thinking overrides?", answer: "yes" },
          {
            label: "Supported thinking levels",
            choices: ["low", "medium", "high", "xhigh", "max"],
            answer: ["low", "medium", "high", "xhigh", "max"],
          },
          { label: WORKING_ARGS_PROMPT, answer: "" },
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
      customProvider: {
        name: "local-agent",
        config: {
          binary: "agent-bin",
          args: [
            "--prompt-file",
            "{{promptFile}}",
            "--output-file",
            "{{outputFile}}",
            "{{#model}}",
            "--model",
            "{{model}}",
            "{{/model}}",
            "{{#thinking}}",
            "--thinking",
            "{{thinking}}",
            "{{/thinking}}",
          ],
          model: { supported: true },
          thinking: { supported: true, levels: ["low", "medium", "high", "xhigh", "max"] },
        },
      },
      target: { provider: "local-agent" },
    });
  });
});
