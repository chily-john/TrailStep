import { describe, expect, it } from "vitest";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import { parseTrailStepConfig } from "./parse-trailstep-config.js";

describe("parseTrailStepConfig", () => {
  it("parses literal unified agent entries and custom providers", () => {
    const parsed = parseTrailStepConfig({
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
    const parsed = parseTrailStepConfig({
      version: 1,
      customProviders: {},
      agents: {
        workerA: [{ provider: "claude", model: "haiku" }],
        workerB: [{ provider: "codex" }, { ref: "workerA" }],
        medium: [{ ref: "workerB" }],
      },
      workflows: {
        review: {
          agents: {
            workerA: [{ provider: "gemini" }],
            reviewer: [{ ref: "workerA" }],
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
      parseTrailStepConfig({
        version: 1,
        customProviders: {},
        agents: {
          medium: [{ ref: "missing" }],
        },
      });
      throw new Error("Expected parseTrailStepConfig to reject unknown refs.");
    } catch (error) {
      expect(error).toBeInstanceOf(TrailStepFailureError);
      expect((error as TrailStepFailureError).failure.code).toBe("agent_ref_unknown");
      expect((error as TrailStepFailureError).failure.details).toEqual({
        diagnostics: ["agents.medium[0].ref references unknown agent 'missing'."],
      });
    }
  });

  it("fails with diagnostics for cyclic agent refs", () => {
    try {
      parseTrailStepConfig({
        version: 1,
        customProviders: {},
        agents: {
          workerA: [{ ref: "workerB" }],
          workerB: [{ ref: "workerA" }],
        },
      });
      throw new Error("Expected parseTrailStepConfig to reject cyclic refs.");
    } catch (error) {
      expect(error).toBeInstanceOf(TrailStepFailureError);
      expect((error as TrailStepFailureError).failure.code).toBe("agent_ref_cycle");
      expect((error as TrailStepFailureError).failure.details).toEqual({
        diagnostics: [
          "agents.workerA[0].ref creates an agent ref cycle: workerA -> workerB -> workerA.",
        ],
      });
    }
  });

  it("parses retry and numeric timeout settings", () => {
    const parsed = parseTrailStepConfig({
      version: 1,
      customProviders: {},
      agents: {},
      settings: { retry: { maxAttempts: 3 }, timeout: 30_000 },
      workflows: {
        review: { settings: { retry: { maxAttempts: 4 }, timeout: 10_000 } },
      },
    });

    expect(parsed.settings?.retry).toEqual({ maxAttempts: 3 });
    expect(parsed.settings?.timeout).toBe(30_000);
    expect(parsed.workflows?.review?.settings?.retry).toEqual({ maxAttempts: 4 });
    expect(parsed.workflows?.review?.settings?.timeout).toBe(10_000);
  });

  it("normalizes empty retry settings so they do not shadow lower-precedence policies", () => {
    const parsed = parseTrailStepConfig({
      version: 1,
      customProviders: {},
      agents: {},
      settings: { retry: {} },
      workflows: {
        review: { settings: { retry: {} } },
      },
    });

    expect(parsed.settings).toEqual({});
    expect(parsed.workflows?.review?.settings).toEqual({});
  });

  it("rejects object timeout settings", () => {
    try {
      parseTrailStepConfig({
        version: 1,
        customProviders: {},
        agents: {},
        settings: { timeout: { timeoutMs: 30_000 } },
        workflows: {
          review: { settings: { timeout: { timeoutMs: 10_000 } } },
        },
      });
      throw new Error("Expected parseTrailStepConfig to reject object timeout settings.");
    } catch (error) {
      expect(error).toBeInstanceOf(TrailStepFailureError);
      expect((error as TrailStepFailureError).failure.code).toBe("validation_failed");
      expect((error as TrailStepFailureError).failure.details).toEqual({
        diagnostics: [
          "settings.timeout must be a number when present.",
          "workflows.review.settings.timeout must be a number when present.",
        ],
      });
    }
  });

  it("requires the unified custom provider and agent mapping keys", () => {
    expect(() =>
      parseTrailStepConfig({
        version: 1,
      }),
    ).toThrow(TrailStepFailureError);
  });

  it("requires top-level and workflow agent mappings to use plain arrays", () => {
    try {
      parseTrailStepConfig({
        version: 1,
        customProviders: {},
        agents: {
          default: { items: [{ provider: "claude" }] },
        },
        workflows: {
          review: {
            agents: {
              reviewer: { items: [{ provider: "claude" }] },
            },
          },
        },
      });
      throw new Error("Expected parseTrailStepConfig to reject items-wrapped agent entries.");
    } catch (error) {
      expect(error).toBeInstanceOf(TrailStepFailureError);
      expect((error as TrailStepFailureError).failure.code).toBe("validation_failed");
      expect((error as TrailStepFailureError).failure.details).toEqual({
        diagnostics: [
          "agents.default must be an array.",
          "workflows.review.agents.reviewer must be an array.",
        ],
      });
    }
  });
});
