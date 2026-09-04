import { openAgentSession } from "../../agent-sessions/open-agent-session.js";
import { type CliCommand, CliUsageError } from "../../command.types.js";
import { loadTrailStepConfig } from "../../config/config.js";

export interface OpenCommandArgs {
  readonly name?: string;
}

export const openCommand: CliCommand<OpenCommandArgs> = {
  name: "open",
  parseArgs(argv) {
    if (argv.length === 0) {
      return {};
    }
    if (argv[0] !== "open") {
      throw new CliUsageError("Expected `trailstep open`.");
    }
    if (argv.length > 2) {
      throw new CliUsageError("`trailstep open` accepts at most one agent or provider name.");
    }
    return argv[1] === undefined ? {} : { name: argv[1] };
  },
  async run(args, context) {
    const config = await loadTrailStepConfig(context.cwd, { homeDir: context.homeDir });
    const result = await openAgentSession({
      cwd: context.cwd,
      config,
      requestedName: args.name,
      runner: context.agentSessionTerminalRunner,
      now: context.runNameClock,
      randomSuffix: context.runNameRandomSuffix,
    });

    if (!result.ok) {
      context.io.writeError(result.message);
      return result.exitCode;
    }

    if (result.exitCode === 0) {
      context.io.writeLine(
        `Opened TrailStep agent session ${result.sessionId} at ${result.sessionDir}`,
      );
    }

    return result.exitCode;
  },
};
