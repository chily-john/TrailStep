import type { CliCommand, CliCommandContext } from "../../command-framework/command.types.js";

import { parseAgentsCommandArgs } from "./agents-args.js";
import type { AgentCommandArgs } from "./agents-command.types.js";
import { deleteAgent, renameAgent, setAgent } from "./agents-config.js";
import { explainAgent, explainWorkflow } from "./agents-listing.js";
import { runInteractiveAgents } from "./agents-setup-wizard.js";

export const agentsCommand: CliCommand<AgentCommandArgs> = {
  name: "agents",
  parseArgs(argv: readonly string[]): AgentCommandArgs {
    return parseAgentsCommandArgs(argv);
  },
  async run(args: AgentCommandArgs, context: CliCommandContext): Promise<number> {
    if (args.action === "set") {
      return setAgent(args, context);
    }
    if (args.action === "delete") {
      return deleteAgent(args, context);
    }
    if (args.action === "rename") {
      return renameAgent(args, context);
    }
    if (args.action === "explain") {
      return explainAgent(args, context);
    }
    if (args.action === "explain-workflow") {
      return explainWorkflow(args, context);
    }
    return runInteractiveAgents(context);
  },
};
