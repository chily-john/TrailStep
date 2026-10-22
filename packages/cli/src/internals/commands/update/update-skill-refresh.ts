import type { CliCommandContext } from "../../command-framework/command.types.js";
import { refreshTrackedPackagedTrailStepSkills } from "../../trailstep-skill/trailstep-skill.js";

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
