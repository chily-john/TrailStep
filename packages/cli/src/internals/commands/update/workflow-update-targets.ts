import { join } from "node:path";
import { parseBundleWorkflowId } from "../../workflow-reference/workflow-reference.js";
import {
  configPathForScope,
  listRegisteredWorkflowEntries,
  type RegisteredWorkflowEntry,
} from "../../workflow-registry/workflow-registry.js";
import { isDirectWorkflowFileReference } from "../../workflow-resolution/workflow-resolution.js";
import type { UpdateScope } from "./update-command.types.js";

export interface WorkflowPackageUpdateTarget {
  readonly packageName: string;
  readonly registeredRefs: readonly string[];
  readonly sourceFiles: readonly string[];
}

export interface WorkflowPackageUpdateSkip {
  readonly registeredRef: string;
  readonly reason: "local-file-source";
  readonly message: string;
}

export interface WorkflowPackageUpdatePlan {
  readonly targets: readonly WorkflowPackageUpdateTarget[];
  readonly skips: readonly WorkflowPackageUpdateSkip[];
}

export interface ResolveWorkflowPackageUpdateTargetsOptions {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly scope: Extract<UpdateScope, { kind: "all" | "workflows" | "workflow" }>;
}

interface MutableWorkflowPackageUpdateTarget {
  packageName: string;
  registeredRefs: string[];
  sourceFiles: string[];
}

export async function resolveWorkflowPackageUpdateTargets({
  cwd,
  homeDir,
  scope,
}: ResolveWorkflowPackageUpdateTargetsOptions): Promise<WorkflowPackageUpdatePlan> {
  const entries = await listRegisteredWorkflowEntries({ cwd, homeDir });
  const scopedEntries =
    scope.kind === "workflow" ? entriesForWorkflow(entries, scope.name) : entries;
  const targetsByPackageName = new Map<string, MutableWorkflowPackageUpdateTarget>();
  const skips: WorkflowPackageUpdateSkip[] = [];

  for (const entry of scopedEntries) {
    const registeredRef = `${entry.namespace}/${entry.name}`;
    const packageName = packageNameFromWorkflowTarget(entry.targetRef);
    if (packageName === undefined) {
      skips.push({
        registeredRef,
        reason: "local-file-source",
        message: `Skipped ${registeredRef}: local file source, no version to update.`,
      });
      continue;
    }

    addPackageTarget(targetsByPackageName, packageName, {
      registeredRef,
      sourceFile: configPathForScope(entry.scope, { cwd, homeDir }),
    });
  }

  if (scope.kind === "workflow" && scopedEntries.length === 0) {
    addPackageTarget(targetsByPackageName, packageNameFromRawWorkflowPackage(scope.name), {
      sourceFile: join(cwd, "package.json"),
    });
  }

  return {
    targets: [...targetsByPackageName.values()].map((target) => ({
      packageName: target.packageName,
      registeredRefs: target.registeredRefs,
      sourceFiles: target.sourceFiles,
    })),
    skips,
  };
}

function entriesForWorkflow(
  entries: readonly RegisteredWorkflowEntry[],
  workflowName: string,
): readonly RegisteredWorkflowEntry[] {
  return entries.filter(
    (entry) => `${entry.namespace}/${entry.name}` === workflowName || entry.name === workflowName,
  );
}

function addPackageTarget(
  targetsByPackageName: Map<string, MutableWorkflowPackageUpdateTarget>,
  packageName: string,
  options: { readonly registeredRef?: string; readonly sourceFile: string },
): void {
  const target = targetsByPackageName.get(packageName) ?? {
    packageName,
    registeredRefs: [],
    sourceFiles: [],
  };

  if (
    options.registeredRef !== undefined &&
    !target.registeredRefs.includes(options.registeredRef)
  ) {
    target.registeredRefs.push(options.registeredRef);
  }
  if (!target.sourceFiles.includes(options.sourceFile)) {
    target.sourceFiles.push(options.sourceFile);
  }

  targetsByPackageName.set(packageName, target);
}

function packageNameFromWorkflowTarget(targetRef: string): string | undefined {
  if (
    isDirectWorkflowFileReference(targetRef) ||
    targetRef === "~" ||
    targetRef.startsWith("~/") ||
    targetRef.startsWith("~\\")
  ) {
    return undefined;
  }

  const bundleRef = parseBundleWorkflowId(targetRef);
  if (bundleRef) {
    return bundleRef.packageName;
  }

  const legacySeparatorIndex = targetRef.lastIndexOf(":");
  if (legacySeparatorIndex > 0 && legacySeparatorIndex < targetRef.length - 1) {
    return targetRef.slice(0, legacySeparatorIndex);
  }

  return targetRef;
}

function packageNameFromRawWorkflowPackage(rawPackageName: string): string {
  const packageName = packageNameFromWorkflowTarget(rawPackageName);
  return packageName ?? rawPackageName;
}
