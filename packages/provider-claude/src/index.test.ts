import { describe, expect, it } from "vitest";

import * as providerClaude from "./index.js";

describe("@trailstep/provider-claude exports", () => {
  it("exports the claude provider manifest with package-owned official-provider semantics", () => {
    expect(providerClaude).toHaveProperty("trailstepProvider");
    expect(providerClaude.trailstepProvider).toMatchObject({
      manifest: {
        id: "claude",
        displayName: "Claude",
        model: { supported: true, flag: "--model" },
        thinking: {
          supported: true,
          flag: "--effort",
          levels: ["low", "medium", "high", "xhigh", "max"],
        },
        working: {
          supported: true,
          command: "claude",
          prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
          output: {
            style: "stdout-json-envelope",
            parsing: { resultField: "result" },
          },
        },
        interactive: {
          supported: true,
          command: "claude",
          requiresSystemPromptFile: true,
          systemPromptFileFlag: "--append-system-prompt-file",
        },
      },
      hooks: {
        extractOutput: { supported: true, source: "package" },
        repairOutput: { supported: true, source: "package" },
      },
    });
  });
});
