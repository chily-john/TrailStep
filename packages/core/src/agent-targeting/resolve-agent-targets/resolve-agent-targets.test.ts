import { describe, expect, it } from "vitest";
import { StepKitFailureError } from "../../contracts/failures/failure.js";
import { parseStepKitConfig } from "../parse-stepkit-config/parse-stepkit-config.js";
import { resolveAgentTargets } from "./resolve-agent-targets.js";

describe("StepKit config", () => {
  it("resolves the unified precedence chain from workflow role, size, then default", () => {
    const config = parseStepKitConfig({
      version: 1,
      customProviders: {
        workflowReviewer: customProvider("workflow-reviewer"),
        mediumReviewer: customProvider("medium-reviewer"),
        defaultReviewer: customProvider("default-reviewer"),
      },
      agents: {
        medium: { items: [target("mediumReviewer")] },
        default: { items: [target("defaultReviewer")] },
      },
      workflows: {
        "review-workflow": {
          agents: {
            reviewer: { items: [target("workflowReviewer")] },
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
    ).toEqual([target("workflowReviewer"), target("mediumReviewer"), target("defaultReviewer")]);
  });

  it("falls back from empty size mapping to agents.default", () => {
    const config = parseStepKitConfig({
      version: 1,
      customProviders: {
        defaultReviewer: customProvider("default-reviewer"),
      },
      agents: {
        medium: { items: [] },
        default: { items: [target("defaultReviewer")] },
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
      parseStepKitConfig({
        version: 1,
        customProviders: {
          reviewer: customProvider("reviewer"),
        },
        agents: {
          default: { items: [target("missing")] },
        },
      }),
    ).toThrow(StepKitFailureError);
  });

  it("throws a structured failure when no usable target exists", () => {
    const config = parseStepKitConfig({
      version: 1,
      customProviders: {
        reviewer: customProvider("reviewer"),
      },
      agents: {
        default: { items: [] },
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
