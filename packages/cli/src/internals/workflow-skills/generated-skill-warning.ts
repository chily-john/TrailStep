import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { CliCommandContext } from "../command-framework/command.types.js";

export async function warnIfGeneratedSkillDirectoryExists(
  context: CliCommandContext,
  namespace: string,
  name: string,
): Promise<void> {
  const skillDirectory = join(
    context.cwd,
    ".trailstep",
    "skills",
    workflowSkillName(namespace, name),
  );
  if (await pathExists(skillDirectory)) {
    context.io.writeError(
      `Note: skill directory ${skillDirectory} was not removed; delete it manually if desired.`,
    );
  }
}

export function workflowSkillName(_namespace: string, name: string): string {
  return `trst-${sanitizeSkillNamePart(name) || "workflow"}`;
}

function sanitizeSkillNamePart(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
