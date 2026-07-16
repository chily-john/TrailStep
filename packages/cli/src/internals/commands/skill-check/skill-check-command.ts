import { type CliCommand, type CliCommandContext, CliUsageError } from "../../command.types.js";
import { discoverWorkflows } from "../../discovery/discovery.js";
import { findPackagesMissingSkills } from "./skill-detection.js";

export const skillCheckCommand: CliCommand<Record<string, never>> = {
  name: "skill-check",
  parseArgs(argv: readonly string[]): Record<string, never> {
    if (argv.length !== 1 || argv[0] !== "skill-check") {
      throw new CliUsageError("Expected skill-check.");
    }
    return {};
  },
  async run(_args: Record<string, never>, context: CliCommandContext): Promise<number> {
    const workflows = await discoverWorkflows({ cwd: context.cwd });
    const reports = await findPackagesMissingSkills(workflows);

    for (const report of reports) {
      context.io.writeLine(
        `Missing SKILL.md for ${report.packageName}: ${report.workflowIds.join(", ")}`,
      );
    }

    return 0;
  },
};
