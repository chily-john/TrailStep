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
        hygiene: {
          mcp: { disableFlag: "--config=mcp_servers={}" },
          extensions: { disableFlag: "--disable=plugins" },
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
            "{{tools}}",
            "{{skills}}",
            "{{mcpArgs}}",
            "{{extensionsArgs}}",
            "{{contextFilesArgs}}",
            "@{{promptFile}}",
          ],
          followUp: {
            supported: true,
            resumeArgs: [
              "exec",
              "resume",
              "{{sessionId}}",
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
              "{{tools}}",
              "{{skills}}",
              "{{mcpArgs}}",
              "{{extensionsArgs}}",
              "{{contextFilesArgs}}",
              "@{{promptFile}}",
            ],
          },
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

describe("@trailstep/provider-codex hygiene capabilities", () => {
  it("declares supported execution fields as real single-token argv flags", () => {
    const hygiene = providerCodex.trailstepProvider.manifest.hygiene;
    expect(Object.keys(hygiene).sort()).toEqual(["extensions", "mcp"]);
    const declaredFlags = [hygiene.mcp.disableFlag, hygiene.extensions.disableFlag];
    expect(declaredFlags.length).toBeGreaterThan(0);
    for (const flag of declaredFlags) {
      expect(flag.length, "hygiene flags must be non-empty").toBeGreaterThan(0);
      expect(flag, "hygiene flags must be single argv tokens").toMatch(/^\S+$/u);
    }
  });
});
