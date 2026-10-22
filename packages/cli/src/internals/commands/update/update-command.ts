import {
  type CliCommand,
  type CliCommandContext,
  CliUsageError,
} from "../../command-framework/command.types.js";
import { formatDeprecationFinding } from "../../deprecation-scan/deprecation-formatter.js";
import { NpmRegistryError } from "../../package-manager/npm-registry.js";
import { defaultPackageCommandRunner } from "../../package-manager/package-manager.js";
import { findStaleTrackedPackagedTrailStepSkillInstallations } from "../../trailstep-skill/trailstep-skill.js";
import {
  installUntrackedWorkflowSkills,
  planUntrackedWorkflowSkillInstalls,
  resolveUntrackedWorkflowSkillTargets,
  type UntrackedWorkflowSkillSource,
  type UntrackedWorkflowSkillTargetResolution,
} from "../../workflow-skills/untracked-workflow-skills.js";
import {
  type GlobalCliUpdatePlan,
  resolveGlobalCliUpdateTarget,
} from "./global-cli-update-target.js";
import { parseUpdateInvocation } from "./parse-update-invocation.js";
import type { UpdateCommandArgs } from "./update-command.types.js";
import {
  createDependencyUpdateGroups,
  isChangedDependencyUpdate,
} from "./update-dependency-groups.js";
import { installDependencyUpdateGroups } from "./update-dependency-install.js";
import { refreshRegisteredWorkflowMcpToolsAndReport } from "./update-mcp-refresh.js";
import { collectPreflightFindings } from "./update-preflight.js";
import {
  applyRecommendedConfigApplications,
  confirmRecommendedConfigAdditions,
  planRecommendedConfigApplications,
  recommendedConfigPackagesWithAdditions,
} from "./update-recommended-config.js";
import {
  refreshTrailStepSkillsAfterUpdate,
  reportUntrackedWorkflowSkillTargetBases,
} from "./update-skill-refresh.js";
import {
  resolveTrailStepSelfUpdateTargets,
  type TrailStepSelfUpdatePlan,
  UpdateTargetResolutionError,
} from "./update-targets.js";
import {
  resolveWorkflowPackageUpdateTargets,
  type WorkflowPackageUpdatePlan,
} from "./workflow-update-targets.js";

export const updateCommand: CliCommand<UpdateCommandArgs> = {
  name: "update",
  parseArgs: parseUpdateInvocation,
  async run(args, context) {
    try {
      const globalCliPlan =
        args.scope.kind === "global" || args.scope.kind === "all"
          ? await resolveGlobalCliUpdateTarget({
              cwd: context.cwd,
              packageCommandRunner: context.packageCommandRunner,
            })
          : undefined;
      const selfPlan =
        args.scope.kind === "project" || args.scope.kind === "all"
          ? await resolveTrailStepSelfUpdateTargets({
              cwd: context.cwd,
              packageCommandRunner: context.packageCommandRunner,
            })
          : undefined;
      const workflowPlan =
        args.scope.kind === "all" ||
        args.scope.kind === "workflows" ||
        args.scope.kind === "workflow"
          ? await resolveWorkflowPackageUpdateTargets({
              cwd: context.cwd,
              homeDir: context.homeDir,
              scope: args.scope,
              packageCommandRunner: context.packageCommandRunner,
            })
          : undefined;

      const workflowTargetsToApply = (workflowPlan?.targets ?? []).filter(
        isChangedDependencyUpdate,
      );
      const workflowPlanToApply =
        workflowPlan === undefined
          ? undefined
          : { ...workflowPlan, targets: workflowTargetsToApply };

      const findings = await collectPreflightFindings({
        args,
        context,
        selfPlan,
        workflowPlan: workflowPlanToApply,
      });
      const blocked = findings.some((finding) => finding.severity === "blocking");
      for (const finding of findings) {
        context.io.writeLine(formatDeprecationFinding(finding));
      }
      if (blocked && !args.force) {
        context.io.writeError(
          "Update blocked: blocking deprecation findings found. Re-run with --force to continue.",
        );
        return 1;
      }
      if (blocked && args.force) {
        context.io.writeLine(
          "Warning: --force set; continuing despite blocking deprecation findings.",
        );
      }

      for (const skip of workflowPlan?.skips ?? []) {
        context.io.writeLine(skip.message);
      }

      const recommendedConfigApplications = await planRecommendedConfigApplications(context);
      const hasRecommendedConfigAdditions = recommendedConfigApplications.some(
        (application) =>
          application.addedAgents.length > 0 || application.addedWorkflowRoles.length > 0,
      );
      for (const application of recommendedConfigApplications) {
        if (application.addedAgents.length > 0 || application.addedWorkflowRoles.length > 0) {
          context.io.writeLine(
            `Planned recommended config additions from ${application.packageName}: add ${application.addedAgents.length} agent(s), ${application.addedWorkflowRoles.length} workflow role mapping(s).`,
          );
        }
        for (const conflict of application.conflicts) {
          context.io.writeError(`Warning: recommended config conflict: ${conflict}`);
        }
      }

      const staleSkillInstallations =
        await findStaleTrackedPackagedTrailStepSkillInstallations(context);
      // Resolve each package's untracked-workflow skill targets up front: the add-time
      // preference recorded in workflow metadata when present, otherwise inferred from
      // existing skills, otherwise project-only (reported below).
      const workflowSkillTargetResolutions = new Map<
        string,
        UntrackedWorkflowSkillTargetResolution
      >();
      const workflowSkillSources: UntrackedWorkflowSkillSource[] = [];
      for (const target of workflowPlan?.targets ?? []) {
        const resolution = await resolveUntrackedWorkflowSkillTargets({
          cwd: context.cwd,
          homeDir: context.homeDir,
          packageName: target.packageName,
          trackedSkillNames: target.trackedSkillNames,
          ...(target.recordedSkillTargets === undefined
            ? {}
            : { recordedSkillTargets: target.recordedSkillTargets }),
        });
        workflowSkillTargetResolutions.set(target.packageName, resolution);
        workflowSkillSources.push({
          packageName: target.packageName,
          installRoot: target.installRoot,
          registeredWorkflowNames: target.registeredWorkflowNames,
          skillTargets: resolution.skillTargets,
        });
      }
      const plannedUntrackedWorkflowSkills = (
        await planUntrackedWorkflowSkillInstalls(workflowSkillSources)
      ).filter((entry) => entry.skillTargets.length > 0);
      const hasGlobalCliChanges = (globalCliPlan?.targets.length ?? 0) > 0;
      const hasSelfChanges = (selfPlan?.targets.length ?? 0) > 0;
      const hasWorkflowChanges = workflowTargetsToApply.length > 0;
      const hasSkillChanges = staleSkillInstallations.length > 0;
      const hasWorkflowSkillInstalls = plannedUntrackedWorkflowSkills.length > 0;
      if (
        !hasGlobalCliChanges &&
        !hasSelfChanges &&
        !hasWorkflowChanges &&
        !hasSkillChanges &&
        !hasWorkflowSkillInstalls &&
        !hasRecommendedConfigAdditions
      ) {
        if (workflowPlan !== undefined) {
          await refreshRegisteredWorkflowMcpToolsAndReport(context);
        }
        context.io.writeLine(noChangesMessage(args, globalCliPlan, selfPlan, workflowPlan));
        return 0;
      }

      if (hasGlobalCliChanges && globalCliPlan) {
        context.io.writeLine("Planned global TrailStep CLI update:");
        for (const target of globalCliPlan.targets) {
          context.io.writeLine(
            `${target.packageName}: ${target.currentVersion} -> ${target.targetVersion} (${target.command} ${target.args.join(" ")})`,
          );
        }
      }

      if (hasSelfChanges && selfPlan) {
        context.io.writeLine("Planned TrailStep package updates:");
        for (const target of selfPlan.targets) {
          context.io.writeLine(
            `${target.packageName}: ${target.currentRange} -> ${target.targetVersion}`,
          );
        }
      }

      if (hasWorkflowChanges) {
        context.io.writeLine("Planned workflow package updates:");
        for (const target of workflowTargetsToApply) {
          context.io.writeLine(
            `  ${target.packageName} (${target.installScope} install root: ${target.installRoot}): ${target.currentRange} -> ${target.targetVersion}`,
          );
        }
      }

      if (hasSkillChanges) {
        context.io.writeLine("Planned TrailStep packaged skill refresh:");
        for (const staleSkill of staleSkillInstallations) {
          context.io.writeLine(`  ${staleSkill.target} skills tracked in ${staleSkill.configPath}`);
        }
      }

      if (hasWorkflowSkillInstalls) {
        context.io.writeLine("Planned workflow skill installs for untracked workflows:");
        for (const entry of plannedUntrackedWorkflowSkills) {
          context.io.writeLine(
            `  ${entry.bundleRef} (skill targets: ${entry.skillTargets.join(", ")})`,
          );
        }
        reportUntrackedWorkflowSkillTargetBases(
          context,
          plannedUntrackedWorkflowSkills,
          workflowSkillTargetResolutions,
        );
      }

      const updateGroups = createDependencyUpdateGroups({
        cwd: context.cwd,
        selfUpdates: selfPlan?.targets ?? [],
        workflowUpdates: workflowTargetsToApply,
      });
      const hasOtherChanges =
        hasGlobalCliChanges ||
        hasSelfChanges ||
        hasWorkflowChanges ||
        hasSkillChanges ||
        hasWorkflowSkillInstalls;
      const confirmed = await confirmUpdate(args, context, {
        hasPackageChanges: hasGlobalCliChanges || hasSelfChanges || hasWorkflowChanges,
        hasSkillChanges,
        hasWorkflowSkillInstalls,
        hasRecommendedConfigAdditions,
      });
      if (!confirmed) {
        context.io.writeLine("Update cancelled.");
        return 0;
      }

      // Split consent: when recommended config additions ride along with other
      // changes, ask separately so accepting package/skill updates does not force
      // config additions. With --yes the blanket confirm already applies everything.
      let applyRecommendedConfig = hasRecommendedConfigAdditions;
      if (
        hasRecommendedConfigAdditions &&
        hasOtherChanges &&
        !args.assumeYes &&
        context.prompts?.confirm !== undefined
      ) {
        applyRecommendedConfig = await confirmRecommendedConfigAdditions(
          context.prompts.confirm,
          recommendedConfigApplications,
        );
        if (!applyRecommendedConfig) {
          context.io.writeLine(
            `Skipped recommended config additions from ${recommendedConfigPackagesWithAdditions(
              recommendedConfigApplications,
            ).join(", ")} (declined); applying the remaining updates.`,
          );
        }
      }

      const runPackageCommand = context.packageCommandRunner ?? defaultPackageCommandRunner;
      if (globalCliPlan) {
        for (const target of globalCliPlan.targets) {
          const installResult = await runPackageCommand({
            command: target.command,
            args: target.args,
            cwd: context.cwd,
          });
          if (installResult.exitCode !== 0) {
            context.io.writeError(
              `Global TrailStep CLI update failed with exit code ${installResult.exitCode}.`,
            );
            if (installResult.stderr) {
              context.io.writeError(installResult.stderr);
            }
            return 1;
          }
          context.io.writeLine(
            "Updated global TrailStep CLI. The updated binary will be used by the next trailstep process.",
          );
        }
      }

      const installFailure = await installDependencyUpdateGroups(
        updateGroups,
        context,
        runPackageCommand,
      );
      if (installFailure !== undefined) {
        context.io.writeError(
          `Install failed with exit code ${installFailure.exitCode} in ${installFailure.installRoot}.`,
        );
        if (installFailure.stderr) {
          context.io.writeError(installFailure.stderr);
        }
        return 1;
      }
      if (hasSkillChanges || hasGlobalCliChanges) {
        await refreshTrailStepSkillsAfterUpdate(context);
      }
      if (workflowPlan !== undefined) {
        // Re-detect after installs: updated packages may expose workflow exports that
        // were not present at plan time. These installs were covered by the confirmed
        // workflow plan (either as planned skill installs or as workflow package updates)
        // and use the skill targets resolved at plan time.
        const installs = await installUntrackedWorkflowSkills(
          context,
          workflowSkillSources.filter((source) => source.skillTargets.length > 0),
        );
        for (const install of installs) {
          context.io.writeLine(
            `Installed workflow skill ${install.skillName} for untracked workflow ${install.bundleRef}.`,
          );
        }
      }
      if (applyRecommendedConfig) {
        await applyRecommendedConfigApplications(recommendedConfigApplications, context);
      }
      if (workflowPlan !== undefined) {
        // Per-workflow MCP tool JSON is regenerated on every `update` covering
        // workflows, rewritten unconditionally (hash compare is logging-only).
        await refreshRegisteredWorkflowMcpToolsAndReport(context);
      }
      context.io.writeLine("Update complete.");
      return 0;
    } catch (error) {
      if (error instanceof NpmRegistryError || error instanceof UpdateTargetResolutionError) {
        context.io.writeError(error.message);
        return 1;
      }
      throw error;
    }
  },
};

function noChangesMessage(
  args: UpdateCommandArgs,
  globalCliPlan: GlobalCliUpdatePlan | undefined,
  selfPlan: TrailStepSelfUpdatePlan | undefined,
  workflowPlan: WorkflowPackageUpdatePlan | undefined,
): string {
  if (args.scope.kind === "global" && globalCliPlan) {
    return `Global TrailStep CLI is already current (@trailstep/cli ${globalCliPlan.currentVersion}).`;
  }
  if (args.scope.kind === "workflows" || args.scope.kind === "workflow") {
    return "No workflow package updates are available.";
  }
  if (args.scope.kind === "project" && (selfPlan?.currentPackageNames.length ?? 0) === 0) {
    return "No TrailStep package dependencies found in package.json; add @trailstep/cli to this project or update a global CLI install with your package manager.";
  }
  return (workflowPlan?.skips.length ?? 0) > 0
    ? "No package updates to apply."
    : "No changes needed.";
}

async function confirmUpdate(
  args: UpdateCommandArgs,
  context: CliCommandContext,
  plan: {
    readonly hasPackageChanges: boolean;
    readonly hasSkillChanges: boolean;
    readonly hasWorkflowSkillInstalls: boolean;
    readonly hasRecommendedConfigAdditions: boolean;
  },
): Promise<boolean> {
  if (args.assumeYes) {
    return true;
  }
  if (!context.prompts?.confirm) {
    throw new CliUsageError(
      "Update requires --yes, --assume-yes, or an interactive confirm prompt before writing.",
    );
  }
  return context.prompts.confirm(
    plan.hasPackageChanges
      ? "Apply package updates and run install?"
      : plan.hasSkillChanges
        ? "Refresh tracked TrailStep skills?"
        : plan.hasWorkflowSkillInstalls
          ? "Install workflow skills for untracked workflows?"
          : "Apply recommended config additions?",
  );
}
