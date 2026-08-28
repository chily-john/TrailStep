import { describe, expect, it } from "vitest";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import { parseTrailStepConfig } from "../parse-trailstep-config/parse-trailstep-config.js";
import { resolveAgentTargets } from "./resolve-agent-targets.js";

describe("TrailStep config", () => {
  it("resolves the unified precedence chain from workflow role, top-level role, size, then default", () => {
    const config = parseTrailStepConfig({
      version: 1,
      customProviders: {
        workflowReviewer: customProvider("workflow-reviewer"),
        roleReviewer: customProvider("role-reviewer"),
        mediumReviewer: customProvider("medium-reviewer"),
        defaultReviewer: customProvider("default-reviewer"),
      },
      agents: {
        reviewer: [target("roleReviewer")],
        medium: [target("mediumReviewer")],
        default: [target("defaultReviewer")],
      },
      workflows: {
        "review-workflow": {
          agents: {
            reviewer: [target("workflowReviewer")],
          },
        },
      },
    });

    expect(
      resolveAgentTargets({
        config,
        workflowId: "review-workflow",
        roleName: "reviewer",
        roleSize: "medium",
      }),
    ).toEqual([
      target("workflowReviewer"),
      target("roleReviewer"),
      target("mediumReviewer"),
      target("defaultReviewer"),
    ]);
  });

  it("resolves a workflow role from the top-level agent with the same name", () => {
    const config = parseTrailStepConfig({
      version: 1,
      customProviders: {
        featureWriter: customProvider("feature-writer"),
      },
      agents: {
        featureWriter: [target("featureWriter")],
      },
    });

    expect(
      resolveAgentTargets({
        config,
        workflowId: "take-it-away",
        roleName: "featureWriter",
        roleSize: "medium",
      }),
    ).toEqual([target("featureWriter")]);
  });

  it("falls back from empty size mapping to agents.default", () => {
    const config = parseTrailStepConfig({
      version: 1,
      customProviders: {
        defaultReviewer: customProvider("default-reviewer"),
      },
      agents: {
        medium: [],
        default: [target("defaultReviewer")],
      },
    });

    expect(
      resolveAgentTargets({
        config,
        workflowId: "review-workflow",
        roleName: "reviewer",
        roleSize: "medium",
      }),
    ).toEqual([target("defaultReviewer")]);
  });

  it("rejects targets that reference providers not declared in customProviders", () => {
    expect(() =>
      parseTrailStepConfig({
        version: 1,
        customProviders: {
          reviewer: customProvider("reviewer"),
        },
        agents: {
          default: [target("missing")],
        },
      }),
    ).toThrow(TrailStepFailureError);
  });

  it("throws a structured failure when no usable target exists", () => {
    const config = parseTrailStepConfig({
      version: 1,
      customProviders: {
        reviewer: customProvider("reviewer"),
      },
      agents: {
        default: [],
      },
    });

    expect(() =>
      resolveAgentTargets({
        config,
        workflowId: "review-workflow",
        roleName: "reviewer",
        roleSize: "medium",
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: "agent_targets_unavailable",
          message: expect.stringContaining(
            "No agent targets found for role reviewer with size medium in workflow review-workflow.",
          ),
        }),
      }),
    );
  });
});

function customProvider(binary: string) {
  return { binary, args: [] };
}

function target(provider: string) {
  return { provider };
}
