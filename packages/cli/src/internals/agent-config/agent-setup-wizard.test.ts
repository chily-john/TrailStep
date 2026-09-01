import { describe, expect, it } from "vitest";

import { runAgentSetupWizard } from "./agent-setup-wizard.js";

describe("runAgentSetupWizard", () => {
  it("writes agent targets against registered provider ids when an official provider package is selected", async () => {
    await expect(
      runAgentSetupWizard({
        config: {
          providers: {
            pi: {
              source: {
                type: "npm",
                packageName: "@trailstep/provider-pi",
                spec: "@trailstep/provider-pi",
              },
              manifest: { id: "pi", displayName: "Pi" },
            },
          },
        },
        agentName: "default",
        prompts: {
          async text(prompt) {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
          async select(prompt, choices) {
            if (prompt === "Provider") {
              expect(choices).toEqual(["@trailstep/provider-pi", "custom"]);
              return "@trailstep/provider-pi";
            }
            if (prompt === "Model override") {
              expect(choices).toEqual(["Use provider default", "Type manually"]);
              return "Use provider default";
            }
            if (prompt === "Reasoning/thinking override") {
              expect(choices).toEqual([
                "Use provider default",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ]);
              return "Use provider default";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
        },
        providerChoices: ["@trailstep/provider-pi"],
      }),
    ).resolves.toEqual({
      providers: {
        pi: {
          source: {
            type: "npm",
            packageName: "@trailstep/provider-pi",
            spec: "@trailstep/provider-pi",
          },
          manifest: { id: "pi", displayName: "Pi" },
        },
      },
      agents: { default: [{ provider: "pi" }] },
    });
  });
});
