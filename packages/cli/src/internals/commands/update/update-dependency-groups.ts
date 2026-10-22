import type { PackageJsonDependencyUpdate } from "../../package-manager/package-json-rewrite.js";
import { preserveRangeStyle } from "../../package-manager/package-json-rewrite.js";
import type { WorkflowPackageUpdateTarget } from "./workflow-update-targets.js";

export interface DependencyUpdateGroup {
  readonly installRoot: string;
  readonly updates: readonly PackageJsonDependencyUpdate[];
}

/**
 * Groups the planned dependency updates by the directory whose `package.json`
 * is rewritten. Self updates land in the current project; workflow package
 * updates land in their own install root.
 */
export function createDependencyUpdateGroups({
  cwd,
  selfUpdates,
  workflowUpdates,
}: {
  readonly cwd: string;
  readonly selfUpdates: readonly PackageJsonDependencyUpdate[];
  readonly workflowUpdates: readonly WorkflowPackageUpdateTarget[];
}): readonly DependencyUpdateGroup[] {
  const groups = new Map<string, PackageJsonDependencyUpdate[]>();
  addDependencyUpdates(groups, cwd, selfUpdates);
  for (const update of workflowUpdates) {
    addDependencyUpdates(groups, update.installRoot, [update]);
  }
  return [...groups.entries()].map(([installRoot, updates]) => ({ installRoot, updates }));
}

function addDependencyUpdates(
  groups: Map<string, PackageJsonDependencyUpdate[]>,
  installRoot: string,
  updates: readonly PackageJsonDependencyUpdate[],
): void {
  if (updates.length === 0) {
    return;
  }

  let group = groups.get(installRoot);
  if (!group) {
    group = [];
    groups.set(installRoot, group);
  }

  for (const update of updates) {
    group.push({
      packageName: update.packageName,
      targetVersion: update.targetVersion,
      dependencySection: update.dependencySection,
    });
  }
}

/** True when the target version differs from the currently declared range. */
export function isChangedDependencyUpdate(update: {
  readonly currentRange: string;
  readonly targetVersion: string;
}): boolean {
  return preserveRangeStyle(update.currentRange, update.targetVersion) !== update.currentRange;
}
