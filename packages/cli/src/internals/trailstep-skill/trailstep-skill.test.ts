import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../");
const usageSkillPath = join(cliRoot, "trailstep-skill/SKILL.md");
const authoringSkillPath = join(cliRoot, "trailstep-authoring-skill/SKILL.md");

describe("packaged TrailStep skill content", () => {
  it("documents public TrailStep operations and provider guidance", async () => {
    const skill = await readFile(usageSkillPath, "utf8");

    for (const requiredText of [
      "name: trailstep",
      "trailstep init",
      "trailstep update",
      "trailstep agents",
      "trailstep providers add",
      "trailstep providers inspect",
      "trailstep providers test",
      "trailstep workflows",
      "trailstep add",
      "trailstep <workflow-ref> --input-file",
      "trailstep continue",
      "trailstep answer",
      "trailstep retry",
      "trailstep open",
      "JSON object",
      "Do not manually edit `.trailstep/runs`.",
      "retry instead of inventing a separate resume mechanism",
      "./workflows/review.ts#review",
      "project/review",
      "@acme/workflows#review",
      "direct refs",
      "registered refs",
      "bundle refs",
      "Local run artifacts are runtime outputs, not source of truth.",
      "manifest-only provider",
      "hook-based provider package",
      "trailstepProvider",
      "Do not embed functions in manifests.",
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

  it("documents public TrailStep workflow authoring and architecture guidance", async () => {
    const skill = await readFile(authoringSkillPath, "utf8");

    for (const requiredText of [
      "name: trailstep-authoring",
      "defineWorkflow({ start })",
      "step({ id }).prompt(...).do(...)",
      ".display(...)",
      ".wait(...)",
      "done(...)",
      "fail(...)",
      "shape(...)",
      "jsonSchema(...)",
      "workflow-level `agents`",
      "step-level `agent`",
      "pass/fail",
      "generated workflow skills",
      "./workflows/review.ts#review",
      "project/review",
      "@acme/workflows#review",
    ]) {
      expect(skill).toContain(requiredText);
    }
  });
});
