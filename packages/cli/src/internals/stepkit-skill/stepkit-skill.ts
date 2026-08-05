import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CliCommandContext } from "../command.types.js";
import { distributeWorkflowSkill } from "../workflow-skills/skills-cli.js";

const STEPKIT_SKILL_DIRECTORY_NAME = "stepkit-skill";

export async function installPackagedStepKitSkill(
  scope: "local" | "project" | "global",
  context: CliCommandContext,
): Promise<void> {
  await distributeWorkflowSkill({
    skillDirectory: await resolvePackagedStepKitSkillDirectory(),
    target: scope === "global" ? "user" : "project",
    resolver: context.skillsCliResolver,
    runner: context.skillsCliProcessRunner,
  });
}

export async function resolvePackagedStepKitSkillDirectory(): Promise<string> {
  const packageRoot = await findCliPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const skillDirectory = join(packageRoot, STEPKIT_SKILL_DIRECTORY_NAME);
  await access(join(skillDirectory, "SKILL.md"));
  return skillDirectory;
}

async function findCliPackageRoot(startDirectory: string): Promise<string> {
  let current = startDirectory;

  while (true) {
    if (await isStepKitCliPackageRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not resolve @stepkit/cli package root for StepKit skill.");
    }
    current = parent;
  }
}

async function isStepKitCliPackageRoot(directory: string): Promise<boolean> {
  try {
    const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
      readonly name?: string;
    };
    return packageJson.name === "@stepkit/cli";
  } catch {
    return false;
  }
}
