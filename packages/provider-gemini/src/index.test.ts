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
        hygiene: {
          tools: { flag: "--allowed-tools" },
        },
        working: {
          supported: true,
          command: "gemini",
          args: [
            "-p",
            "@{{promptFile}}",
            "--output-format",
            "json",
            "{{#model}}",
            "-m",
            "{{model}}",
            "{{/model}}",
            "{{tools}}",
            "{{skills}}",
            "{{mcpArgs}}",
            "{{extensionsArgs}}",
            "{{contextFilesArgs}}",
          ],
          followUp: {
            supported: true,
            resumeArgs: [
              "-p",
              "@{{promptFile}}",
              "--output-format",
              "json",
              "{{#model}}",
              "-m",
              "{{model}}",
              "{{/model}}",
              "{{tools}}",
              "{{skills}}",
              "{{mcpArgs}}",
              "{{extensionsArgs}}",
              "{{contextFilesArgs}}",
              "--resume",
              "{{sessionId}}",
            ],
          },
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

describe("@trailstep/provider-gemini hygiene capabilities", () => {
  it("declares supported execution fields as real single-token argv flags", () => {
    const hygiene = providerGemini.trailstepProvider.manifest.hygiene;
    expect(Object.keys(hygiene).sort()).toEqual(["tools"]);
    const declaredFlags = [hygiene.tools.flag];
    expect(declaredFlags.length).toBeGreaterThan(0);
    for (const flag of declaredFlags) {
      expect(flag.length, "hygiene flags must be non-empty").toBeGreaterThan(0);
      expect(flag, "hygiene flags must be single argv tokens").toMatch(/^\S+$/u);
    }
  });
});
