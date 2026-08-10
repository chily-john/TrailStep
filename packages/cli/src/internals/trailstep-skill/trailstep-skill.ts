import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CliCommandContext } from "../command.types.js";
import { distributeWorkflowSkill } from "../workflow-skills/skills-cli.js";

const TRAILSTEP_SKILL_DIRECTORY_NAME = "trailstep-skill";

export async function installPackagedTrailStepSkill(
  scope: "local" | "project" | "global",
  context: CliCommandContext,
): Promise<void> {
  await distributeWorkflowSkill({
    skillDirectory: await resolvePackagedTrailStepSkillDirectory(),
    target: scope === "global" ? "user" : "project",
    resolver: context.skillsCliResolver,
    runner: context.skillsCliProcessRunner,
  });
}

export async function resolvePackagedTrailStepSkillDirectory(): Promise<string> {
  const packageRoot = await findCliPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const skillDirectory = join(packageRoot, TRAILSTEP_SKILL_DIRECTORY_NAME);
  await access(join(skillDirectory, "SKILL.md"));
  return skillDirectory;
}

async function findCliPackageRoot(startDirectory: string): Promise<string> {
  let current = startDirectory;

  while (true) {
    if (await isTrailStepCliPackageRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not resolve @trailstep/cli package root for TrailStep skill.");
    }
    current = parent;
  }
}

async function isTrailStepCliPackageRoot(directory: string): Promise<boolean> {
  try {
    const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
      readonly name?: string;
    };
    return packageJson.name === "@trailstep/cli";
  } catch {
    return false;
  }
}
