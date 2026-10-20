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
        hygiene: {
          tools: { flag: "--tools" },
          skills: { disableFlag: "--disable-slash-commands" },
          mcp: { disableFlag: "--strict-mcp-config" },
        },
        working: {
          supported: true,
          command: "claude",
          args: [
            "-p",
            "--output-format",
            "json",
            "{{#model}}",
            "--model",
            "{{model}}",
            "{{/model}}",
            "{{#thinking}}",
            "--effort",
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
              "--output-format",
              "json",
              "{{#model}}",
              "--model",
              "{{model}}",
              "{{/model}}",
              "{{#thinking}}",
              "--effort",
              "{{thinking}}",
              "{{/thinking}}",
              "{{tools}}",
              "{{skills}}",
              "{{mcpArgs}}",
              "{{extensionsArgs}}",
              "{{contextFilesArgs}}",
              "--resume",
              "{{sessionId}}",
              "@{{promptFile}}",
            ],
          },
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

describe("@trailstep/provider-claude hygiene capabilities", () => {
  it("declares supported execution fields as real single-token argv flags", () => {
    const hygiene = providerClaude.trailstepProvider.manifest.hygiene;
    expect(Object.keys(hygiene).sort()).toEqual(["mcp", "skills", "tools"]);
    const declaredFlags = [hygiene.tools.flag, hygiene.skills.disableFlag, hygiene.mcp.disableFlag];
    expect(declaredFlags.length).toBeGreaterThan(0);
    for (const flag of declaredFlags) {
      expect(flag.length, "hygiene flags must be non-empty").toBeGreaterThan(0);
      expect(flag, "hygiene flags must be single argv tokens").toMatch(/^\S+$/u);
    }
  });
});
