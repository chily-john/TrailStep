import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  generateWorkflowSkillContent,
  type WorkflowSkillContentInput,
} from "./workflow-skill-content.js";

export interface WriteProjectWorkflowSkillInput extends WorkflowSkillContentInput {
  readonly cwd: string;
}

export interface WrittenWorkflowSkill {
  readonly skillName: string;
  readonly skillDirectory: string;
}

export async function writeProjectWorkflowSkill(
  input: WriteProjectWorkflowSkillInput,
): Promise<WrittenWorkflowSkill> {
  const { skillName, markdown } = generateWorkflowSkillContent(input);
  const skillDirectory = join(input.cwd, ".stepkit", "skills", skillName);

  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), markdown, "utf8");

  return { skillName, skillDirectory };
}
