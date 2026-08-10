import type { Event } from "@trailstep/core";
import { runWorkflow } from "@trailstep/core";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { loadTrailStepConfig } from "../../config/config.js";
import { resolveRunsRoot } from "../../runs-root.js";
import { resolveWorkflowReference } from "../../workflow-resolution/workflow-resolution.js";
import { generateRunName } from "./generate-run-name.js";
import { loadJsonInput } from "./load-run-input.js";
import { parseRunInvocation } from "./parse-run-invocation.js";
import type { RunCommandArgs } from "./run-command.types.js";
import { createTerminalEventLogger } from "./terminal-event-logger.js";

export const runCommand: CliCommand<RunCommandArgs> = {
  name: "run",
  parseArgs(argv: readonly string[]): RunCommandArgs {
    return parseRunInvocation(argv);
  },
  async run(args: RunCommandArgs, context: CliCommandContext): Promise<number> {
    const { cwd, io } = context;
    const input = await loadJsonInput(args.input, cwd);
    const trailstepConfig = await loadTrailStepConfig(cwd);
    const resolvedWorkflow = await resolveWorkflowReference(args.workflowId, {
      cwd,
      homeDir: context.homeDir,
    });

    if (!resolvedWorkflow) {
      io.writeError(
        `Workflow not found: ${args.workflowId}. Run trailstep workflows to see available workflows.`,
      );
      return 1;
    }

    const terminalEventLogger = createTerminalEventLogger(io);
    const eventSink = (event: Event): void | Promise<void> => {
      terminalEventLogger(event);
      return context.eventSink?.(event);
    };

    const sharedRunOptions = {
      workflow: resolvedWorkflow.workflow,
      cwd,
      runsRoot: resolveRunsRoot(context),
      eventSink,
      ...(context.processRunner === undefined ? {} : { processRunner: context.processRunner }),
      ...(context.workingAgentProcessRunner === undefined
        ? {}
        : { workingAgentProcessRunner: context.workingAgentProcessRunner }),
      ...(trailstepConfig === undefined ? {} : { trailstepConfig }),
    };

    const workflowRunName =
      args.workflowRunName ??
      generateRunName({
        workflowRef: resolvedWorkflow.workflowRef,
        now: context.runNameClock,
        randomSuffix: context.runNameRandomSuffix,
      });

    const result = await runWorkflow({
      ...sharedRunOptions,
      input: input ?? {},
      runName: workflowRunName,
    });

    if (result.status === "success") {
      io.writeLine(`Workflow completed: ${resolvedWorkflow.id} at ${result.runDir}`);
      return 0;
    }

    io.writeError(
      `Workflow failed: ${resolvedWorkflow.id} at ${result.runDir}: ${result.failure.message}`,
    );
    return 1;
  },
};
