import { describe, expect, it } from "vitest";

import { confirmAgentConfigSave } from "./save-confirm-flow.js";

describe("confirmAgentConfigSave", () => {
  it("offers feature-doc save branches for named agents and workflow roles", async () => {
    const prompts = {
      text: async () => "",
      async select(_: string, choices: readonly string[]) {
        expect(choices).toEqual(["Save to original", "Create new agent", "Discard"]);
        return "Create new agent";
      },
    };

    await expect(
      confirmAgentConfigSave({
        context: { kind: "named-agent-edit", name: "workerA" },
        prompts,
      }),
    ).resolves.toBe("create-new-agent");
  });

  it("offers workflow ref fork and detach choices", async () => {
    await expect(
      confirmAgentConfigSave({
        context: {
          kind: "workflow-role-ref",
          workflowId: "release",
          roleName: "reviewer",
          ref: "shared",
        },
        prompts: {
          text: async () => "",
          async select(_, choices) {
            expect(choices).toEqual([
              "Save to original (shared, affects every other referrer)",
              "Create new agent (fork — only this role repoints)",
              "Save as just a workflow agent (detach to one-off)",
              "Discard",
            ]);
            return "Save as just a workflow agent (detach to one-off)";
          },
        },
      }),
    ).resolves.toBe("detach-one-off");
  });
});
