import { describe, expect, it } from "vitest";
import { StepKitFailureError } from "../../shared/failure.js";
import { parseStepKitConfig, resolveAgentTargets } from "./targeting.js";

describe("StepKit config", () => {
  it("resolves a working role from workflow-specific mapping before size and default", () => {
    const config = parseStepKitConfig({
      version: 1,
      customAgents: {
        workflowReviewer: customAgent("workflow-reviewer"),
        mediumReviewer: customAgent("medium-reviewer"),
        defaultReviewer: customAgent("default-reviewer"),
      },
      workingAgents: {
        medium: [target("mediumReviewer")],
        default: [target("defaultReviewer")],
      },
      interactiveAgents: {
        default: [],
      },
      workflows: {
        "review-workflow": {
          workingAgents: {
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
        mode: "working",
      }),
    ).toEqual([target("workflowReviewer")]);
  });

  it("falls back from empty size mapping to workingAgents.default", () => {
    const config = parseStepKitConfig({
      version: 1,
      customAgents: {
        defaultReviewer: customAgent("default-reviewer"),
      },
      workingAgents: {
        medium: [],
        default: [target("defaultReviewer")],
      },
      interactiveAgents: {
        default: [],
      },
    });

    expect(
      resolveAgentTargets({
        config,
        workflowId: "review-workflow",
        roleName: "reviewer",
        roleSize: "medium",
        mode: "working",
      }),
    ).toEqual([target("defaultReviewer")]);
  });

  it("uses interactiveAgents for interactive mode and never workingAgents", () => {
    const config = parseStepKitConfig({
      version: 1,
      customAgents: {
        workingReviewer: customAgent("working-reviewer"),
        interactiveReviewer: customAgent("interactive-reviewer"),
      },
      workingAgents: {
        default: [target("workingReviewer")],
      },
      interactiveAgents: {
        medium: [target("interactiveReviewer")],
        default: [],
      },
    });

    expect(
      resolveAgentTargets({
        config,
        workflowId: "review-workflow",
        roleName: "reviewer",
        roleSize: "medium",
        mode: "interactive",
      }),
    ).toEqual([target("interactiveReviewer")]);
  });

  it("rejects targets that reference providers not declared in customAgents", () => {
    expect(() =>
      parseStepKitConfig({
        version: 1,
        customAgents: {
          reviewer: customAgent("reviewer"),
        },
        workingAgents: {
          default: [target("missing")],
        },
        interactiveAgents: {
          default: [],
        },
      }),
    ).toThrow(StepKitFailureError);
  });

  it("throws a structured failure when no usable target exists", () => {
    const config = parseStepKitConfig({
      version: 1,
      customAgents: {
        reviewer: customAgent("reviewer"),
      },
      workingAgents: {
        default: [],
      },
      interactiveAgents: {
        default: [],
      },
    });

    expect(() =>
      resolveAgentTargets({
        config,
        workflowId: "review-workflow",
        roleName: "reviewer",
        roleSize: "medium",
        mode: "working",
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: "agent_targets_unavailable",
          message: expect.stringContaining(
            "No working agent targets found for role reviewer with size medium in workflow review-workflow.",
          ),
        }),
      }),
    );
  });
});

function customAgent(binary: string) {
  return { binary, args: [] };
}

function target(provider: string) {
  return { provider };
}
