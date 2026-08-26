import { describe, expect, it } from "vitest";

import type { InteractiveProcessRequest } from "../../runtime/run-workflow/run-workflow.types.js";
import { providerRegistry } from "../registry/provider-registry.js";

describe("built-in provider interactive runners", () => {
  it("provider interactive specs expose managed-session prompt delivery capability", () => {
    expect(providerRegistry.claude.spec.interactive).toMatchObject({
      supported: true,
      managedSessionPrompt: { delivery: "hidden-system-prompt-file" },
    });

    expect(providerRegistry.pi.spec.interactive).toMatchObject({
      supported: true,
      managedSessionPrompt: { delivery: "hidden-system-prompt-file" },
    });

    for (const providerId of ["codex", "gemini"] as const) {
      expect(providerRegistry[providerId].spec.interactive).toMatchObject({
        supported: true,
        managedSessionPrompt: { delivery: "visible-prompt", mode: "visible-inline-prompt" },
      });
    }
  });

  it("passes environment and abort signal through built-in interactive providers", async () => {
    const signal = new AbortController().signal;
    const env = { TRAILSTEP_INTERACTIVE_FILE: "/tmp/run/steps/0001-review/interactive.json" };
    const calls: Record<string, InteractiveProcessRequest> = {};

    for (const [providerId, provider] of Object.entries(providerRegistry)) {
      await provider.runInteractive(
        {
          prompt: `Pair with ${providerId}.`,
          cwd: "/tmp/run",
          env,
          signal,
          systemPromptFile: "/tmp/run/steps/0001-review/prompt.txt",
        },
        async (request) => {
          calls[providerId] = request;
          return { exitCode: 0 };
        },
      );
    }

    expect(Object.keys(calls).sort()).toEqual(["claude", "codex", "gemini", "pi"]);
    for (const call of Object.values(calls)) {
      expect(call.env?.TRAILSTEP_INTERACTIVE_FILE).toBe(env.TRAILSTEP_INTERACTIVE_FILE);
      expect(call.signal).toBe(signal);
    }
  });
});
