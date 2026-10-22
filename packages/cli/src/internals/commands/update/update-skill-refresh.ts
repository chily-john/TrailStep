import type { CliCommandContext } from "../../command-framework/command.types.js";
import { refreshTrackedPackagedTrailStepSkills } from "../../trailstep-skill/trailstep-skill.js";
import type { UntrackedWorkflowSkillTargetResolution } from "../../workflow-skills/untracked-workflow-skills.js";

/**
 * Reports the skill targets that were inferred for untracked workflows. A
 * recorded add-time preference is silent; an inference from existing skills
 * and the project-only default are both spelled out.
 */
export function reportUntrackedWorkflowSkillTargetBases(
  context: CliCommandContext,
  plannedInstalls: readonly { readonly packageName: string }[],
  resolutions: ReadonlyMap<string, UntrackedWorkflowSkillTargetResolution>,
): void {
  const reported = new Set<string>();
  for (const entry of plannedInstalls) {
    if (reported.has(entry.packageName)) {
      continue;
    }
    reported.add(entry.packageName);
    const resolution = resolutions.get(entry.packageName);
    if (resolution === undefined || resolution.basis === "recorded-preference") {
      continue;
    }
    if (resolution.basis === "inferred-from-existing-skills") {
      context.io.writeLine(
        `Inferred untracked workflow skill targets for ${entry.packageName} from existing skills: ${resolution.skillTargets.join(", ")}.`,
      );
    } else {
      context.io.writeLine(
        `No recorded skill targets or existing skills for ${entry.packageName}; defaulting untracked workflow skills to ${resolution.skillTargets.join(", ")} skills.`,
      );
    }
  }
}

/** Refreshes the tracked TrailStep skill installation(s) after an update. */
export async function refreshTrailStepSkillsAfterUpdate(context: CliCommandContext): Promise<void> {
  try {
    const refreshed = await refreshTrackedPackagedTrailStepSkills(context);
    if (refreshed.length > 0) {
      context.io.writeLine("Refreshed tracked TrailStep skill installation(s).");
    }
  } catch (error) {
    context.io.writeError(
      `Warning: failed to refresh tracked TrailStep skill installation(s): ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}
