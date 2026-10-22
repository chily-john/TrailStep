import type { CliCommandContext } from "../../command-framework/command.types.js";
import { loadBundleWorkflow } from "../../workflow-resolution/bundle-resolver.js";
import {
  distributeWorkflowSkill,
  type SkillsCliDistributionTarget,
} from "../../workflow-skills/skills-cli.js";
import type { WorkflowSkillMetadata } from "../../workflow-skills/workflow-skill-content.js";
import { workflowSkillName } from "../../workflow-skills/workflow-skill-content.js";
import { writeProjectWorkflowSkill } from "../../workflow-skills/workflow-skill-writer.js";

import type { AddRegistryTarget, ResolvedAddCommandArgs } from "./add-command.types.js";

export async function tryWriteAndDistributeWorkflowSkill(
  args: ResolvedAddCommandArgs,
  registryTarget: AddRegistryTarget,
  context: CliCommandContext,
): Promise<number> {
  const skillName = workflowSkillName(args.namespace, args.name);

  let writtenSkill: { readonly skillName: string; readonly skillDirectory: string };
  try {
    const workflow =
      registryTarget.bundleSpecifier === undefined
        ? registryTarget.workflow
        : (
            await loadBundleWorkflow(registryTarget.bundleSpecifier, {
              cwd: context.cwd,
              freshImport: true,
            })
          ).workflow;

    writtenSkill = await writeProjectWorkflowSkill({
      cwd: context.cwd,
      registeredRef: registryTarget.targetRef,
      namespace: args.namespace,
      name: args.name,
      workflow: workflow as WorkflowSkillMetadata | undefined,
    });
  } catch {
    context.io.writeError(
      `Warning: registered ${args.namespace}/${args.name} but could not write project workflow skill ${skillName}.`,
    );
    return 1;
  }

  warnForSkillScopeMismatch(args, writtenSkill.skillName, context);

  let warnings = 0;
  if (args.projectSkill) {
    warnings += await tryDistributeWorkflowSkill(
      args,
      writtenSkill.skillDirectory,
      "project",
      context,
    );
  }
  if (args.userSkill) {
    warnings += await tryDistributeWorkflowSkill(
      args,
      writtenSkill.skillDirectory,
      "user",
      context,
    );
  }
  return warnings;
}

function warnForSkillScopeMismatch(
  args: ResolvedAddCommandArgs,
  skillName: string,
  context: CliCommandContext,
): void {
  if (args.projectSkill && (args.scope === "global" || args.scope === "local")) {
    context.io.writeError(
      `Warning: project workflow skill ${skillName} points at a ${args.scope}-scoped registration; teammates may not resolve it.`,
    );
  }
  if (args.userSkill && (args.scope === "project" || args.scope === "local")) {
    context.io.writeError(
      `Warning: user workflow skill ${skillName} points at a ${args.scope}-scoped registration and only works from this project.`,
    );
  }
}

async function tryDistributeWorkflowSkill(
  args: ResolvedAddCommandArgs,
  skillDirectory: string,
  target: SkillsCliDistributionTarget,
  context: CliCommandContext,
): Promise<number> {
  const skillName = workflowSkillName(args.namespace, args.name);

  try {
    await distributeWorkflowSkill({
      skillDirectory,
      target,
      resolver: context.skillsCliResolver,
      runner: context.skillsCliProcessRunner,
    });
    return 0;
  } catch (error) {
    context.io.writeError(
      `Warning: registered ${args.namespace}/${args.name} but could not distribute ${target} workflow skill ${skillName}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return 1;
  }
}
