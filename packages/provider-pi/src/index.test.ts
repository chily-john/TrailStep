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
        hygiene: {
          tools: { flag: "--tools" },
          skills: { flag: "--skill", disableFlag: "--no-skills" },
          mcp: { disableFlag: "--no-mcp" },
          extensions: { disableFlag: "--no-extensions" },
          contextFiles: { disableFlag: "--no-context-files" },
        },
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
            "{{tools}}",
            "{{skills}}",
            "{{mcpArgs}}",
            "{{extensionsArgs}}",
            "{{contextFilesArgs}}",
            "@{{promptFile}}",
          ],
          followUp: {
            supported: true,
            sessionIdFlag: "--session-id",
            resumeArgs: [
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
              "{{tools}}",
              "{{skills}}",
              "{{mcpArgs}}",
              "{{extensionsArgs}}",
              "{{contextFilesArgs}}",
              "--session",
              "{{sessionId}}",
              "@{{promptFile}}",
            ],
          },
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

describe("@trailstep/provider-pi hygiene capabilities", () => {
  it("declares supported execution fields as real single-token argv flags", () => {
    const hygiene = providerPi.trailstepProvider.manifest.hygiene;
    expect(Object.keys(hygiene).sort()).toEqual([
      "contextFiles",
      "extensions",
      "mcp",
      "skills",
      "tools",
    ]);
    const declaredFlags = [
      hygiene.tools.flag,
      hygiene.skills.flag,
      hygiene.skills.disableFlag,
      hygiene.mcp.disableFlag,
      hygiene.extensions.disableFlag,
      hygiene.contextFiles.disableFlag,
    ];
    expect(declaredFlags.length).toBeGreaterThan(0);
    for (const flag of declaredFlags) {
      expect(flag.length, "hygiene flags must be non-empty").toBeGreaterThan(0);
      expect(flag, "hygiene flags must be single argv tokens").toMatch(/^\S+$/u);
    }
  });
});
