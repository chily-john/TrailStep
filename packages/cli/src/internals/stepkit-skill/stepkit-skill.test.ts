import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const skillPath = join(dirname(fileURLToPath(import.meta.url)), "../../../stepkit-skill/SKILL.md");

describe("packaged StepKit skill content", () => {
  it("documents public StepKit workflow authoring and operations guidance", async () => {
    const skill = await readFile(skillPath, "utf8");

    for (const requiredText of [
      "name: stepkit",
      "defineWorkflow({ start })",
      "step(...)",
      "done(...)",
      "workflow-level `agents`",
      "step-level `agent`",
      "JSON object",
      "stepkit init",
      "stepkit workflows",
      "stepkit <workflow-ref> --input-file",
      "stepkit continue",
      "stepkit retry",
      "do not manually edit `.stepkit/runs`",
      "retry instead of inventing a separate resume mechanism",
      "./workflows/review.ts#review",
      "project/review",
      "@acme/workflows#review",
      "direct refs",
      "registered refs",
      "bundle refs",
      "local run artifacts are runtime outputs, not source of truth",
    ]) {
      expect(skill).toContain(requiredText);
    }

    for (const hiddenContextText of [
      "read `.pi/rules` first",
      ".pi/rules",
      "AGENTS.md",
      "private/local context",
    ]) {
      expect(skill).not.toContain(hiddenContextText);
    }
  });
});
