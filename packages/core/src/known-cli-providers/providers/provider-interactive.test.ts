import { describe, expect, it } from "vitest";

import type { InteractiveProcessRequest } from "../../runtime/run-workflow/run-workflow.types.js";
import { providerRegistry } from "../registry/provider-registry.js";

describe("built-in provider interactive runners", () => {
  it("passes environment and abort signal through built-in interactive providers", async () => {
    const signal = new AbortController().signal;
    const env = { STEPKIT_INTERACTIVE_FILE: "/tmp/run/steps/0001-review/interactive.json" };
    const calls: Record<string, InteractiveProcessRequest> = {};

    for (const [providerId, provider] of Object.entries(providerRegistry)) {
      await provider.runInteractive(
        { prompt: `Pair with ${providerId}.`, cwd: "/tmp/run", env, signal },
        async (request) => {
          calls[providerId] = request;
          return { exitCode: 0 };
        },
      );
    }

    expect(Object.keys(calls).sort()).toEqual(["claude", "codex", "gemini", "pi"]);
    for (const call of Object.values(calls)) {
      expect(call.env?.STEPKIT_INTERACTIVE_FILE).toBe(env.STEPKIT_INTERACTIVE_FILE);
      expect(call.signal).toBe(signal);
    }
  });
});
