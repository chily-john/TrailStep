import type { CliCommandContext } from "../command.types.js";
import {
  type BundleWorkflowSpecifier,
  listBundleWorkflowNames,
  loadBundleWorkflow,
} from "../workflow-resolution/bundle-resolver.js";
import { distributeWorkflowSkill, type SkillsCliDistributionTarget } from "./skills-cli.js";
import type { WorkflowSkillMetadata } from "./workflow-skill-content.js";
import { writeProjectWorkflowSkill } from "./workflow-skill-writer.js";

/**
 * A workflow package that is already tracked (has registered workflow entries) together
 * with the workflow names those entries cover. Workflow exports of the installed package
 * outside that set are "untracked workflows": they gained no generated skill at add time.
 */
export interface UntrackedWorkflowSkillSource {
  readonly packageName: string;
  readonly installRoot: string;
  readonly registeredWorkflowNames: readonly string[];
}

export interface UntrackedWorkflowSkillPlanEntry {
  readonly packageName: string;
  readonly workflowName: string;
  readonly bundleRef: string;
}

export interface UntrackedWorkflowSkillInstall {
  readonly packageName: string;
  readonly workflowName: string;
  readonly bundleRef: string;
  readonly skillName: string;
  readonly skillDirectory: string;
  readonly distributedTargets: readonly SkillsCliDistributionTarget[];
}

const SKILL_DISTRIBUTION_TARGETS: readonly SkillsCliDistributionTarget[] = ["project", "user"];

export async function findUntrackedWorkflowNames(
  source: UntrackedWorkflowSkillSource,
): Promise<readonly string[]> {
  let workflowNames: readonly string[];
  try {
    workflowNames = await listBundleWorkflowNames(source.packageName, {
      cwd: source.installRoot,
    });
  } catch {
    // Unreadable/uninstalled packages contribute no untracked workflows; update's
    // dependency handling already reports those problems separately.
    return [];
  }

  const registered = new Set(source.registeredWorkflowNames);
  return workflowNames.filter((workflowName) => !registered.has(workflowName));
}

export async function planUntrackedWorkflowSkillInstalls(
  sources: readonly UntrackedWorkflowSkillSource[],
): Promise<readonly UntrackedWorkflowSkillPlanEntry[]> {
  const plan: UntrackedWorkflowSkillPlanEntry[] = [];
  for (const source of sources) {
    for (const workflowName of await findUntrackedWorkflowNames(source)) {
      plan.push({
        packageName: source.packageName,
        workflowName,
        bundleRef: `${source.packageName}#${workflowName}`,
      });
    }
  }
  return plan;
}

/**
 * Writes generated project skills for workflow exports without a registry entry and
 * distributes each skill to project and user skill targets. Skill writes and
 * distributions are best-effort: failures are warnings and never fail the update.
 */
export async function installUntrackedWorkflowSkills(
  context: CliCommandContext,
  sources: readonly UntrackedWorkflowSkillSource[],
): Promise<readonly UntrackedWorkflowSkillInstall[]> {
  const installs: UntrackedWorkflowSkillInstall[] = [];

  for (const source of sources) {
    for (const workflowName of await findUntrackedWorkflowNames(source)) {
      const bundleRef = `${source.packageName}#${workflowName}`;
      const workflow = await loadUntrackedWorkflowMetadata(
        { packageName: source.packageName, workflowName },
        source.installRoot,
      );

      let written: { readonly skillName: string; readonly skillDirectory: string };
      try {
        written = await writeProjectWorkflowSkill({
          cwd: context.cwd,
          registeredRef: bundleRef,
          namespace: "",
          name: workflowName,
          untracked: true,
          ...(workflow === undefined ? {} : { workflow }),
        });
      } catch (error) {
        context.io.writeError(
          `Warning: could not write workflow skill for untracked workflow ${bundleRef}: ${errorMessage(error)}`,
        );
        continue;
      }

      const distributedTargets: SkillsCliDistributionTarget[] = [];
      for (const target of SKILL_DISTRIBUTION_TARGETS) {
        try {
          await distributeWorkflowSkill({
            skillDirectory: written.skillDirectory,
            target,
            resolver: context.skillsCliResolver,
            runner: context.skillsCliProcessRunner,
          });
          distributedTargets.push(target);
        } catch (error) {
          context.io.writeError(
            `Warning: could not distribute ${target} workflow skill ${written.skillName} for untracked workflow ${bundleRef}: ${errorMessage(error)}`,
          );
        }
      }

      installs.push({
        packageName: source.packageName,
        workflowName,
        bundleRef,
        skillName: written.skillName,
        skillDirectory: written.skillDirectory,
        distributedTargets,
      });
    }
  }

  return installs;
}

async function loadUntrackedWorkflowMetadata(
  specifier: BundleWorkflowSpecifier,
  installRoot: string,
): Promise<WorkflowSkillMetadata | undefined> {
  try {
    const resolved = await loadBundleWorkflow(specifier, { cwd: installRoot, freshImport: true });
    return resolved.workflow as WorkflowSkillMetadata;
  } catch {
    // Without workflow metadata the generated skill falls back to generic content,
    // mirroring `trailstep add`'s bundle candidate fallback.
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
