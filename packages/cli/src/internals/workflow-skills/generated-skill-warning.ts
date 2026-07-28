import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { CliCommandContext } from "../command.types.js";
import { workflowSkillName } from "./workflow-skill-content.js";

export async function warnIfGeneratedSkillDirectoryExists(
  context: CliCommandContext,
  namespace: string,
  name: string,
): Promise<void> {
  const skillDirectory = join(
    context.cwd,
    ".stepkit",
    "skills",
    workflowSkillName(namespace, name),
  );
  if (await pathExists(skillDirectory)) {
    context.io.writeError(
      `Note: skill directory ${skillDirectory} was not removed; delete it manually if desired.`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
