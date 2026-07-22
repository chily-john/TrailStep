import { describe, expect, it } from "vitest";
import { StepKitFailureError } from "../../contracts/failures/failure.js";
import { parseStepKitConfig } from "./parse-stepkit-config.js";

describe("parseStepKitConfig", () => {
  it("parses literal unified agent entries and custom providers", () => {
    const parsed = parseStepKitConfig({
      version: 1,
      customProviders: {
        local: {
          binary: "local-agent",
          args: ["--json"],
          interactiveArgs: ["--tty"],
          cwd: ".",
          env: { STEP: "kit" },
        },
      },
      agents: {
        default: {
          items: [{ provider: "local", model: "fast" }],
        },
      },
      workflows: {
        review: {
          agents: {
            reviewer: {
              items: [{ provider: "claude", thinking: "high" }],
            },
          },
        },
      },
    });

    expect(parsed).toEqual({
      version: 1,
      customProviders: {
        local: {
          binary: "local-agent",
          args: ["--json"],
          interactiveArgs: ["--tty"],
          cwd: ".",
          env: { STEP: "kit" },
        },
      },
      agents: {
        default: [{ provider: "local", model: "fast" }],
      },
      workflows: {
        review: {
          agents: {
            reviewer: [{ provider: "claude", thinking: "high" }],
          },
        },
      },
    });
  });

  it("expands agent refs from the top-level reusable agents map", () => {
    const parsed = parseStepKitConfig({
      version: 1,
      customProviders: {},
      agents: {
        workerA: {
          items: [{ provider: "claude", model: "haiku" }],
        },
        workerB: {
          items: [{ provider: "codex" }, { ref: "workerA" }],
        },
        medium: {
          items: [{ ref: "workerB" }],
        },
      },
      workflows: {
        review: {
          agents: {
            workerA: {
              items: [{ provider: "gemini" }],
            },
            reviewer: {
              items: [{ ref: "workerA" }],
            },
          },
        },
      },
    });

    expect(parsed.agents.medium).toEqual([
      { provider: "codex" },
      { provider: "claude", model: "haiku" },
    ]);
    expect(parsed.workflows?.review?.agents?.reviewer).toEqual([
      { provider: "claude", model: "haiku" },
    ]);
  });

  it("fails with diagnostics for unknown agent refs", () => {
    try {
      parseStepKitConfig({
        version: 1,
        customProviders: {},
        agents: {
          medium: {
            items: [{ ref: "missing" }],
          },
        },
      });
      throw new Error("Expected parseStepKitConfig to reject unknown refs.");
    } catch (error) {
      expect(error).toBeInstanceOf(StepKitFailureError);
      expect((error as StepKitFailureError).failure.code).toBe("agent_ref_unknown");
      expect((error as StepKitFailureError).failure.details).toEqual({
        diagnostics: ["agents.medium.items[0].ref references unknown agent 'missing'."],
      });
    }
  });

  it("fails with diagnostics for cyclic agent refs", () => {
    try {
      parseStepKitConfig({
        version: 1,
        customProviders: {},
        agents: {
          workerA: {
            items: [{ ref: "workerB" }],
          },
          workerB: {
            items: [{ ref: "workerA" }],
          },
        },
      });
      throw new Error("Expected parseStepKitConfig to reject cyclic refs.");
    } catch (error) {
      expect(error).toBeInstanceOf(StepKitFailureError);
      expect((error as StepKitFailureError).failure.code).toBe("agent_ref_cycle");
      expect((error as StepKitFailureError).failure.details).toEqual({
        diagnostics: [
          "agents.workerA.items[0].ref creates an agent ref cycle: workerA -> workerB -> workerA.",
        ],
      });
    }
  });

  it("requires the unified custom provider and agent mapping keys", () => {
    expect(() =>
      parseStepKitConfig({
        version: 1,
      }),
    ).toThrow(StepKitFailureError);
  });

  it("requires top-level and workflow agent mappings to use item entry objects", () => {
    try {
      parseStepKitConfig({
        version: 1,
        customProviders: {},
        agents: {
          default: [{ provider: "claude" }],
        },
        workflows: {
          review: {
            agents: {
              reviewer: [{ provider: "claude" }],
            },
          },
        },
      });
      throw new Error("Expected parseStepKitConfig to reject raw agent arrays.");
    } catch (error) {
      expect(error).toBeInstanceOf(StepKitFailureError);
      expect((error as StepKitFailureError).failure.code).toBe("validation_failed");
      expect((error as StepKitFailureError).failure.details).toEqual({
        diagnostics: [
          "agents.default must be an object with an items array.",
          "workflows.review.agents.reviewer must be an object with an items array.",
        ],
      });
    }
  });
});
