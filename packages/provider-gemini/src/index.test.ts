import { describe, expect, it } from "vitest";

import * as providerGemini from "./index.js";

describe("@trailstep/provider-gemini exports", () => {
  it("exports the gemini provider manifest with package-owned official-provider semantics", () => {
    expect(providerGemini).toHaveProperty("trailstepProvider");
    expect(providerGemini.trailstepProvider).toMatchObject({
      manifest: {
        id: "gemini",
        displayName: "Gemini",
        model: { supported: true, flag: "-m" },
        thinking: { supported: false },
        working: {
          supported: true,
          command: "gemini",
          prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
          output: {
            style: "stdout-json-envelope",
            parsing: { resultField: "response" },
          },
        },
        interactive: {
          supported: true,
          command: "gemini",
          modelFlag: "-m",
        },
      },
      hooks: {
        extractOutput: { supported: true, source: "package" },
        repairOutput: { supported: false },
      },
    });
  });
});
