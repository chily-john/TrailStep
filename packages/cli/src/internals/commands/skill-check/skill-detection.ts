import { access } from "node:fs/promises";
import { join } from "node:path";

import type { DiscoveredWorkflow } from "../../discovery/discovery.js";

export interface MissingSkillReport {
  readonly packageName: string;
  readonly packageDir: string;
  readonly workflowIds: readonly string[];
}

export async function findPackagesMissingSkills(
  workflows: readonly DiscoveredWorkflow[],
): Promise<MissingSkillReport[]> {
  const packageGroups = groupWorkflowsByPackage(workflows);
  const reports: MissingSkillReport[] = [];

  for (const group of packageGroups) {
    if (await hasSkillFile(group.packageDir)) {
      continue;
    }

    reports.push(group);
  }

  return reports;
}

function groupWorkflowsByPackage(workflows: readonly DiscoveredWorkflow[]): MissingSkillReport[] {
  const groups = new Map<
    string,
    { packageName: string; packageDir: string; workflowIds: string[] }
  >();

  for (const workflow of workflows) {
    const key = `${workflow.packageName}\0${workflow.packageDir}`;
    const group = groups.get(key) ?? {
      packageName: workflow.packageName,
      packageDir: workflow.packageDir,
      workflowIds: [],
    };

    group.workflowIds.push(workflow.id);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, workflowIds: group.workflowIds.sort() }))
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
}

async function hasSkillFile(packageDir: string): Promise<boolean> {
  try {
    await access(join(packageDir, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}
