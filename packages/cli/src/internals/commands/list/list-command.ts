import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { discoverWorkflows } from "../../discovery/discovery.js";

export const listCommand: CliCommand<Record<string, never>> = {
  name: "list",
  parseArgs(): Record<string, never> {
    return {};
  },
  async run(_args: Record<string, never>, context: CliCommandContext): Promise<number> {
    const workflows = await discoverWorkflows({ cwd: context.cwd });
    for (const workflow of workflows) {
      context.io.writeLine(workflow.id);
    }
    return 0;
  },
};
