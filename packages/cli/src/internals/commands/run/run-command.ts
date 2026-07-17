import { join } from "node:path";

import { runWorkflow } from "@stepkit/core";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { loadStepKitConfig } from "../../config/config.js";
import { resolveWorkflowReference } from "../../workflow-resolution/workflow-resolution.js";
import { generateRunName } from "./generate-run-name.js";
import { loadJsonInput } from "./load-run-input.js";
import { parseRunInvocation } from "./parse-run-invocation.js";
import type { RunCommandArgs } from "./run-command.types.js";

export const runCommand: CliCommand<RunCommandArgs> = {
  name: "run",
  parseArgs(argv: readonly string[]): RunCommandArgs {
    return parseRunInvocation(argv);
  },
  async run(args: RunCommandArgs, context: CliCommandContext): Promise<number> {
    const { cwd, io } = context;
    const input = args.resume ? undefined : await loadJsonInput(args.input, cwd);
    const stepkitConfig = await loadStepKitConfig(cwd);
    const resolvedWorkflow = await resolveWorkflowReference(args.workflowId, {
      cwd,
      homeDir: context.homeDir,
    });

    if (!resolvedWorkflow) {
      io.writeError(
        `Workflow not found: ${args.workflowId}. Run stepkit list to see available workflows.`,
      );
      return 1;
    }

    const sharedRunOptions = {
      workflow: resolvedWorkflow.workflow,
      cwd,
      eventSink: context.eventSink,
      ...(context.processRunner === undefined ? {} : { processRunner: context.processRunner }),
      ...(context.workingAgentProcessRunner === undefined
        ? {}
        : { workingAgentProcessRunner: context.workingAgentProcessRunner }),
      ...(stepkitConfig === undefined ? {} : { stepkitConfig }),
    };

    const workflowRunName =
      args.workflowRunName ??
      generateRunName({
        workflowRef: resolvedWorkflow.workflowRef,
        now: context.runNameClock,
        randomSuffix: context.runNameRandomSuffix,
      });

    const result = args.resume
      ? await runWorkflow({
          ...sharedRunOptions,
          resume: { runDir: join(cwd, ".stepkit", "runs", workflowRunName) },
        })
      : await runWorkflow({
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
