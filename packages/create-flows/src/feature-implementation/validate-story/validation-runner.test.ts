import { describe, expect, it } from "vitest";
import { collectValidationCommands, runFocusedStoryValidation } from "./validation-runner.js";

const activeStory = {
  path: "story-001.md",
  content: [
    "### Story 001: Active widget story",
    "",
    "#### Goal",
    "Build the widget exporter core.",
    "",
    "#### Acceptance Criteria",
    "- Exports widgets through the public API.",
    "",
    "#### Red Phase",
    "Create widget-exporter.test.ts with a failing export assertion.",
    "",
    "#### Green Phase",
    "Implement the exporter.",
    "",
    "#### Validation Commands",
    "- `pnpm --filter @trailstep/create-flows test -- widget-exporter.test.ts`",
  ].join("\n"),
};

describe("validate-story deterministic runner", () => {
  it("collects focused validation commands from the story, context, and exploration", () => {
    const commands = collectValidationCommands(
      {
        currentStory: activeStory,
        attempt: 1,
        explorationBrief: {
          blocked: false,
          summary: "explored",
          relevantFiles: [],
          testSeams: [],
          recommendedValidationCommands: ["pnpm --filter @trailstep/create-flows typecheck"],
        },
      },
      ["#### Validation Commands", "- pnpm --filter @trailstep/create-flows lint"].join("\n"),
    );

    expect(commands).toEqual([
      "pnpm --filter @trailstep/create-flows test -- widget-exporter.test.ts",
      "pnpm --filter @trailstep/create-flows lint",
      "pnpm --filter @trailstep/create-flows typecheck",
    ]);
  });

  it("rejects unsafe or broad commands without invoking a validator agent", async () => {
    const output = await runFocusedStoryValidation({
      validationInput: {
        currentStory: {
          path: "story-002.md",
          content: [
            "### Story 002",
            "",
            "#### Validation Commands",
            "- pnpm test",
            "- rm -rf dist",
            "- pnpm --filter @trailstep/create-flows test | tee log.txt",
          ].join("\n"),
        },
        attempt: 1,
      },
      cwd: process.cwd(),
    });

    expect(output.blocked).toBe(true);
    expect(output.validationPassed).toBe(false);
    expect(output.commands).toEqual([
      {
        command: "pnpm test",
        result:
          "skipped: broad package validation belongs to final validation; add --filter, a package path, or a specific test file for story validation",
      },
      { command: "rm -rf dist", result: "skipped: command 'rm' is not allowlisted" },
      {
        command: "pnpm --filter @trailstep/create-flows test | tee log.txt",
        result: "skipped: shell metacharacter '|' is not allowlisted",
      },
    ]);
  });

  it("executes allowlisted focused commands and returns bounded command evidence", async () => {
    const output = await runFocusedStoryValidation({
      validationInput: {
        currentStory: {
          path: "story-003.md",
          content: [
            "### Story 003",
            "",
            "#### Validation Commands",
            "- node -e \"console.log('focused ok')\"",
          ].join("\n"),
        },
        attempt: 1,
      },
      cwd: process.cwd(),
    });

    expect(output.blocked).toBe(false);
    expect(output.validationPassed).toBe(true);
    expect(output.summary).toContain("Focused validation passed");
    expect(output.commands).toEqual([
      { command: "node -e \"console.log('focused ok')\"", result: "passed: focused ok" },
    ]);
  });
});
