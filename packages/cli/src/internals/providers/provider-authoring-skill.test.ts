import { constants as fsConstants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const skillRoots = [join(repoRoot, ".agents", "skills"), join(repoRoot, "packages", "cli")];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectSkillFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".trailstep") {
        return [];
      }

      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return collectSkillFiles(entryPath);
      }

      return entry.isFile() && entry.name === "SKILL.md" ? [entryPath] : [];
    }),
  );

  return files.flat();
}

async function findProviderAuthoringSkills(): Promise<Array<{ path: string; content: string }>> {
  const skillFiles = (await Promise.all(skillRoots.map((root) => collectSkillFiles(root)))).flat();

  const skills = await Promise.all(
    skillFiles.map(async (path) => ({
      path,
      content: await readFile(path, "utf8"),
    })),
  );

  return skills.filter(
    (skill) =>
      skill.content.includes("trailstep-provider") || skill.content.includes("trailstepProvider"),
  );
}

describe("provider authoring skill", () => {
  it("exists and teaches manifest-only and hook-based provider authoring with safe validation", async () => {
    const skills = await findProviderAuthoringSkills();

    expect(
      skills.map((skill) => relative(repoRoot, skill.path)),
      "expected a provider-authoring skill in .agents/skills or packages/cli",
    ).not.toHaveLength(0);

    const skill = skills[0]?.content ?? "";

    expect(skill).toContain("trailstep-provider");
    expect(skill).toContain("trailstepProvider");
    expect(skill).toContain("trailstep providers inspect");
    expect(skill).toContain("trailstep providers test");
    expect(skill).toMatch(/manifest-only provider/i);
    expect(skill).toMatch(/hook-based provider package/i);
    expect(skill).toMatch(/do not embed functions in manifests/i);
    expect(skill).toMatch(/execute provider package code|trusted like installed npm/i);

    for (const checklistItem of [
      "provider id",
      "display",
      "working invocation",
      "prompt delivery",
      "output parsing",
      "thinking",
      "env",
      "interactive",
      "repair",
      "resume",
    ]) {
      expect(skill).toContain(checklistItem);
    }
  });
});
