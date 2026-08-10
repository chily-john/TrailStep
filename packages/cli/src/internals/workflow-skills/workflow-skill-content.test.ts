import { describe, expect, it } from "vitest";

import { generateWorkflowSkillContent, workflowSkillName } from "./workflow-skill-content.js";

describe("workflowSkillName", () => {
  it("prefixes sanitized workflow names without appending the namespace", () => {
    expect(workflowSkillName("Project Tools", "Review_Workflow!!")).toBe("sk-review-workflow");
  });
});

describe("generateWorkflowSkillContent", () => {
  it("uses workflow description in generated skill frontmatter", () => {
    const { markdown } = generateWorkflowSkillContent({
      registeredRef: "project/review",
      namespace: "project",
      name: "review",
      workflow: {
        id: "review",
        description: "Review the current project changes.",
        start: () => ({ kind: "done", output: {} }),
      },
    });

    expect(markdown).toContain('description: "[project] Review the current project changes."');
  });

  it("uses fallback description when workflow description is missing", () => {
    const { markdown } = generateWorkflowSkillContent({
      registeredRef: "project/review",
      namespace: "project",
      name: "review",
      workflow: { id: "review", start: () => ({ kind: "done", output: {} }) },
    });

    expect(markdown).toContain(
      'description: "[project] Run the TrailStep workflow \\"project/review\\"."',
    );
  });

  it("instructs no-input workflows to run without input export", () => {
    const { markdown } = generateWorkflowSkillContent({
      registeredRef: "project/review",
      namespace: "project",
      name: "review",
      workflow: { id: "review", start: () => ({ kind: "done", output: {} }) },
    });

    expect(markdown).toContain("trailstep project/review");
    expect(markdown).not.toContain("--input-file");
    expect(markdown).not.toContain("sessionFile");
    expect(markdown).not.toContain("Export dense conversation");
  });

  it("includes normalized inputShape schema and --input-file instructions", () => {
    const { skillName, markdown } = generateWorkflowSkillContent({
      registeredRef: "project/review",
      namespace: "project",
      name: "review",
      workflow: {
        id: "review",
        inputShape: { topic: "string", count: "number" },
        start: () => ({ kind: "done", output: {} }),
      },
    });

    expect(skillName).toBe("sk-review");
    expect(markdown).toContain(".trailstep/inputs/sk-review-input.json");
    expect(markdown).toContain(
      "trailstep project/review --input-file .trailstep/inputs/sk-review-input.json",
    );
    expect(markdown).toContain('"topic": {');
    expect(markdown).toContain('"type": "string"');
    expect(markdown).toContain('"count": {');
    expect(markdown).toContain('"required": [');
    expect(markdown).toContain('"topic"');
    expect(markdown).toContain('"count"');
  });

  it("uses dense sessionFile object instructions for workflow input schemas without inputShape", () => {
    const { markdown } = generateWorkflowSkillContent({
      registeredRef: "project/review",
      namespace: "project",
      name: "review",
      workflow: {
        id: "review",
        input: {
          validate: (value: unknown): value is Record<string, unknown> =>
            typeof value === "object" && value !== null && !Array.isArray(value),
          diagnostics: () => [],
          assert: (value) => value as Record<string, unknown>,
          jsonSchema: {
            type: "object",
            properties: { sessionFile: { type: "string" } },
            required: ["sessionFile"],
          },
        },
        start: () => ({ kind: "done", output: {} }),
      },
    });

    expect(markdown).toContain(
      "Export dense conversation/session context to `.trailstep/inputs/sk-review-context.md`",
    );
    expect(markdown).toContain('{ "sessionFile": ".trailstep/inputs/sk-review-context.md" }');
    expect(markdown).toContain(
      "trailstep project/review --input-file .trailstep/inputs/sk-review-input.json",
    );
    expect(markdown).toContain('"sessionFile": {');
  });
});
