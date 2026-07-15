import { runWorkflow } from "@stepkit/core";

import { type CliCommand, type CliCommandContext, CliUsageError } from "../../command.types.js";
import { loadStepKitConfig } from "../../config/config.js";
import { discoverWorkflows } from "../../discovery/discovery.js";
import { parseWorkflowId } from "../../workflow-reference/workflow-reference.js";
import { loadJsonInput } from "./load-run-input.js";
import { parseRunArgs } from "./parse-run-args.js";
import type { RunCommandArgs } from "./run-command.types.js";

export const runCommand: CliCommand<RunCommandArgs> = {
  name: "run",
  parseArgs(argv: readonly string[]): RunCommandArgs {
    const [workflowId, workflowRunName, ...rest] = argv;
    if (!workflowId || !workflowRunName) {
      throw new CliUsageError("Expected a command or workflow id and workflow run name.");
    }
    const workflow = parseWorkflowId(workflowId);
    const input = parseRunArgs(rest);
    return {
      workflowId,
      workflowRunName,
      workflow,
      ...(input !== undefined ? { input } : {}),
    };
  },
  async run(args: RunCommandArgs, context: CliCommandContext): Promise<number> {
    const { cwd, io } = context;
    const input = await loadJsonInput(args.input, cwd);
    const stepkitConfig = await loadStepKitConfig(cwd);
    const workflows = await discoverWorkflows({ cwd });
    const discoveredWorkflow = workflows.find((workflow) => workflow.id === args.workflowId);

    if (!discoveredWorkflow) {
      io.writeError(
        `Workflow not found: ${args.workflowId}. Run stepkit list to see available workflows.`,
      );
      return 1;
    }

    const result = await runWorkflow({
      workflow: discoveredWorkflow.workflow,
      input,
      runName: args.workflowRunName,
      cwd,
      eventSink: context.eventSink,
      ...(context.processRunner === undefined ? {} : { processRunner: context.processRunner }),
      ...(context.workingAgentProcessRunner === undefined
        ? {}
        : { workingAgentProcessRunner: context.workingAgentProcessRunner }),
      ...(stepkitConfig === undefined ? {} : { stepkitConfig }),
    });

    if (result.status === "success") {
      io.writeLine(`Workflow completed: ${args.workflowId} at ${result.runDir}`);
      return 0;
    }

    io.writeError(
      `Workflow failed: ${args.workflowId} at ${result.runDir}: ${result.failure.message}`,
    );
    return 1;
  },
};
