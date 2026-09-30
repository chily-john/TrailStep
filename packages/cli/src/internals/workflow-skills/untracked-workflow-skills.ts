import { access } from "node:fs/promises";
import { join } from "node:path";

import type { CliCommandContext } from "../command.types.js";
import type { WorkflowSkillInstallTarget } from "../workflow-registry/workflow-registry.js";
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
  /**
   * Explicit skill targets the generated skills must be distributed to. Callers resolve
   * these via `resolveUntrackedWorkflowSkillTargets` (add-time preference, legacy
   * inference, or project-only default) instead of the installer hardcoding both targets.
   */
  readonly skillTargets: readonly WorkflowSkillInstallTarget[];
}

export interface UntrackedWorkflowSkillPlanEntry {
  readonly packageName: string;
  readonly workflowName: string;
  readonly bundleRef: string;
  readonly skillTargets: readonly WorkflowSkillInstallTarget[];
}

export interface UntrackedWorkflowSkillInstall {
  readonly packageName: string;
  readonly workflowName: string;
  readonly bundleRef: string;
  readonly skillName: string;
  readonly skillDirectory: string;
  readonly distributedTargets: readonly SkillsCliDistributionTarget[];
}

export type UntrackedWorkflowSkillTargetBasis =
  | "recorded-preference"
  | "inferred-from-existing-skills"
  | "default-project-only";

export interface UntrackedWorkflowSkillTargetResolution {
  readonly skillTargets: readonly WorkflowSkillInstallTarget[];
  readonly basis: UntrackedWorkflowSkillTargetBasis;
}

export interface ResolveUntrackedWorkflowSkillTargetsOptions {
  readonly cwd: string;
  readonly homeDir: string | undefined;
  readonly packageName: string;
  /**
   * Generated skill names of the package's tracked workflows (the skills `trailstep
   * add` created), used to infer skill targets for legacy registrations.
   */
  readonly trackedSkillNames: readonly string[];
  /**
   * Add-time skill choice persisted in workflow metadata. When present it is honored
   * verbatim (an empty array means the user explicitly chose no skills).
   */
  readonly recordedSkillTargets?: readonly WorkflowSkillInstallTarget[];
}

/**
 * Resolves the skill target(s) for untracked-workflow skill installs of one package:
 * 1. the skill targets recorded at `trailstep add` time when present;
 * 2. otherwise inferred from where the package's tracked skills currently exist —
 *    `<cwd>/.agents/skills` marks the project target, `<homeDir>/.agents/skills` the
 *    user target (the skills CLI distribution convention);
 * 3. otherwise project-only as the default, which callers should report.
 */
export async function resolveUntrackedWorkflowSkillTargets(
  options: ResolveUntrackedWorkflowSkillTargetsOptions,
): Promise<UntrackedWorkflowSkillTargetResolution> {
  if (options.recordedSkillTargets !== undefined) {
    return { skillTargets: [...options.recordedSkillTargets], basis: "recorded-preference" };
  }

  const inferred = new Set<WorkflowSkillInstallTarget>();
  for (const skillName of options.trackedSkillNames) {
    if (await pathExists(join(options.cwd, DISTRIBUTED_SKILLS_DIRECTORY, skillName))) {
      inferred.add("project");
    }
    if (
      options.homeDir !== undefined &&
      (await pathExists(join(options.homeDir, DISTRIBUTED_SKILLS_DIRECTORY, skillName)))
    ) {
      inferred.add("user");
    }
  }

  const skillTargets: WorkflowSkillInstallTarget[] = [];
  if (inferred.has("project")) {
    skillTargets.push("project");
  }
  if (inferred.has("user")) {
    skillTargets.push("user");
  }
  if (skillTargets.length > 0) {
    return { skillTargets, basis: "inferred-from-existing-skills" };
  }
  return { skillTargets: ["project"], basis: "default-project-only" };
}

const DISTRIBUTED_SKILLS_DIRECTORY = join(".agents", "skills");

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
        skillTargets: source.skillTargets,
      });
    }
  }
  return plan;
}

/**
 * Writes generated project skills for workflow exports without a registry entry and
 * distributes each skill to the skill target(s) resolved for its package (add-time
 * preference, legacy inference, or project-only default). Skill writes and
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
      for (const target of source.skillTargets) {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
