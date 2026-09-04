import { describe, expect, it } from "vitest";

import * as providerCodex from "./index.js";

describe("@trailstep/provider-codex exports", () => {
  it("exports the codex provider manifest with package-owned official-provider semantics", () => {
    expect(providerCodex).toHaveProperty("trailstepProvider");
    expect(providerCodex.trailstepProvider).toMatchObject({
      manifest: {
        id: "codex",
        displayName: "Codex",
        model: { supported: true, flag: "-m" },
        thinking: {
          supported: true,
          flag: "-c model_reasoning_effort",
          levels: ["low", "medium", "high", "xhigh"],
        },
        working: {
          supported: true,
          command: "codex",
          args: [
            "exec",
            "-o",
            "{{outputFile}}",
            "{{#model}}",
            "-m",
            "{{model}}",
            "{{/model}}",
            "{{#thinking}}",
            "-c",
            "model_reasoning_effort={{thinking}}",
            "{{/thinking}}",
            "@{{promptFile}}",
          ],
          prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
          output: { style: "provider-output-file" },
        },
        interactive: {
          supported: true,
          command: "codex",
          modelFlag: "--model",
        },
      },
      hooks: {
        extractOutput: { supported: false },
        repairOutput: { supported: false },
      },
    });
  });
});
