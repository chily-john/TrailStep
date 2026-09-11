import { describe, expect, it } from "vitest";

import { generateWorkflowSkillContent, workflowSkillName } from "./workflow-skill-content.js";

describe("workflowSkillName", () => {
  it("prefixes sanitized workflow names without appending the namespace", () => {
    expect(workflowSkillName("Project Tools", "Review_Workflow!!")).toBe("trst-review-workflow");
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

  it("uses workflow skill description before workflow description", () => {
    const { markdown } = generateWorkflowSkillContent({
      registeredRef: "project/review",
      namespace: "project",
      name: "review",
      workflow: {
        id: "review",
        description: "Generic workflow description.",
        skill: { description: "Use when an agent needs a focused review delegate." },
        start: () => ({ kind: "done", output: {} }),
      },
    });

    expect(markdown).toContain(
      'description: "[project] Use when an agent needs a focused review delegate."',
    );
    expect(markdown).not.toContain("Generic workflow description.");
  });

  it("preserves raw workflow skill markdown frontmatter and appends generated usage instructions", () => {
    const { markdown } = generateWorkflowSkillContent({
      registeredRef: "project/review",
      namespace: "project",
      name: "review",
      workflow: {
        id: "review",
        inputShape: { topic: "string" },
        skill: [
          "---",
          "name: custom-review",
          "description: Custom author-provided skill.",
          "x-trailstep-user-facing: false",
          "---",
          "",
          "# Custom review guidance",
          "",
          "Use only for delegated review work.",
        ].join("\n"),
        start: () => ({ kind: "done", output: {} }),
      },
    });

    expect(
      markdown.startsWith(
        "---\nname: custom-review\ndescription: Custom author-provided skill.\nx-trailstep-user-facing: false\n---",
      ),
    ).toBe(true);
    expect(markdown).toContain("Use only for delegated review work.");
    expect(markdown).toContain("Run the registered TrailStep workflow `project/review`.");
    expect(markdown).toContain(
      "trailstep project/review --input-file .trailstep/inputs/trst-review-input.json",
    );
  });

  it("wraps raw workflow skill markdown without frontmatter in generated frontmatter", () => {
    const { markdown } = generateWorkflowSkillContent({
      registeredRef: "project/review",
      namespace: "project",
      name: "review",
      workflow: {
        id: "review",
        description: "Review the current project changes.",
        skill: "# Custom review guidance\n\nUse only for delegated review work.",
        start: () => ({ kind: "done", output: {} }),
      },
    });

    expect(
      markdown.startsWith(
        '---\nname: trst-review\ndescription: "[project] Review the current project changes."\n---\n\n# Custom review guidance',
      ),
    ).toBe(true);
    expect(markdown).toContain("Use only for delegated review work.");
    expect(markdown).toContain("Run the registered TrailStep workflow `project/review`.");
  });

  it("wraps object markdown without frontmatter in generated name and description frontmatter", () => {
    const { markdown } = generateWorkflowSkillContent({
      registeredRef: "project/review",
      namespace: "project",
      name: "review",
      workflow: {
        id: "review",
        description: "Review the current project changes.",
        skill: {
          description: "Use when an agent needs a focused review delegate.",
          markdown: "# Review delegate\n\nUse for delegated review only.",
        },
        start: () => ({ kind: "done", output: {} }),
      },
    });

    expect(markdown.startsWith("---\nname: trst-review\n")).toBe(true);
    expect(markdown).toContain(
      'description: "[project] Use when an agent needs a focused review delegate."\n---\n\n# Review delegate',
    );
    expect(markdown).toContain("Use for delegated review only.");
    expect(markdown).toContain("trailstep project/review");
  });

  it("prepends custom workflow skill instructions while keeping generated usage instructions", () => {
    const { markdown } = generateWorkflowSkillContent({
      registeredRef: "project/review",
      namespace: "project",
      name: "review",
      workflow: {
        id: "review",
        inputShape: { topic: "string" },
        skill: {
          instructions:
            "Use this only as a sub-agent review tool. Keep the review focused on the requested topic.",
        },
        start: () => ({ kind: "done", output: {} }),
      },
    });

    expect(markdown).toContain(
      "Use this only as a sub-agent review tool. Keep the review focused on the requested topic.\n\nRun the registered TrailStep workflow `project/review`.",
    );
    expect(markdown).toContain("Create workflow input JSON");
    expect(markdown).toContain(
      "trailstep project/review --input-file .trailstep/inputs/trst-review-input.json",
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

    expect(skillName).toBe("trst-review");
    expect(markdown).toContain(".trailstep/inputs/trst-review-input.json");
    expect(markdown).toContain(
      "trailstep project/review --input-file .trailstep/inputs/trst-review-input.json",
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
      "Export dense conversation/session context to `.trailstep/inputs/trst-review-context.md`",
    );
    expect(markdown).toContain('{ "sessionFile": ".trailstep/inputs/trst-review-context.md" }');
    expect(markdown).toContain(
      "trailstep project/review --input-file .trailstep/inputs/trst-review-input.json",
    );
    expect(markdown).toContain('"sessionFile": {');
  });
});
