import { describe, expect, it } from "vitest";

import * as providerPi from "./index.js";

describe("@trailstep/provider-pi exports", () => {
  it("exports the pi provider manifest and package-backed hook metadata", () => {
    expect(providerPi).toHaveProperty("trailstepProvider");
    expect(providerPi.trailstepProvider).toMatchObject({
      manifest: {
        id: "pi",
        displayName: "Pi",
        model: { supported: true },
        thinking: { supported: true, levels: ["low", "medium", "high", "xhigh", "max"] },
        working: {
          supported: true,
          command: "pi",
          args: [
            "-p",
            "--mode",
            "json",
            "{{#model}}",
            "--model",
            "{{model}}",
            "{{/model}}",
            "{{#thinking}}",
            "--thinking",
            "{{thinking}}",
            "{{/thinking}}",
            "@{{promptFile}}",
          ],
          prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
          output: {
            style: "stdout-jsonl-transcript",
            parsing: { resultField: "message" },
          },
        },
        interactive: {
          supported: true,
          command: "pi",
        },
      },
      hooks: {
        extractOutput: { supported: true, source: "package" },
      },
    });
  });
});
