import { join } from "node:path";

import type { Event } from "@stepkit/core";
import { runWorkflow } from "@stepkit/core";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { loadStepKitConfig } from "../../config/config.js";
import { promptSelect, promptText, promptYesNo } from "../../prompts/prompt-helpers.js";
import { resolveRunsRoot } from "../../runs-root.js";
import { resolveWorkflowReference } from "../../workflow-resolution/workflow-resolution.js";
import { createTerminalEventLogger } from "../run/terminal-event-logger.js";
import { listEligibleRetryRuns } from "./eligible-retry-runs.js";
import { parseRetryInvocation } from "./parse-retry-invocation.js";
import type { RetryCommandArgs } from "./retry-command.types.js";

export const retryCommand: CliCommand<RetryCommandArgs> = {
  name: "retry",
  parseArgs(argv: readonly string[]): RetryCommandArgs {
    return parseRetryInvocation(argv);
  },
  async run(args: RetryCommandArgs, context: CliCommandContext): Promise<number> {
    const { cwd, io } = context;
    const runsRoot = resolveRunsRoot(context);
    let retryTarget: { readonly workflowId: string; readonly workflowRunName: string };
    try {
      retryTarget =
        args.mode === "interactive" ? await selectInteractiveRetryTarget(context) : args;
    } catch (error) {
      if (error instanceof NoEligibleRetryRuns) {
        return 0;
      }

      throw error;
    }
    const stepkitConfig = await loadStepKitConfig(cwd);
    const resolvedWorkflow = await resolveWorkflowReference(retryTarget.workflowId, {
      cwd,
      homeDir: context.homeDir,
    });

    if (!resolvedWorkflow) {
      io.writeError(
        `Workflow not found: ${retryTarget.workflowId}. Run stepkit workflows to see available workflows.`,
      );
      return 1;
    }

    const terminalEventLogger = createTerminalEventLogger(io);
    const eventSink = (event: Event): void | Promise<void> => {
      terminalEventLogger(event);
      return context.eventSink?.(event);
    };

    const result = await runWorkflow({
      workflow: resolvedWorkflow.workflow,
      cwd,
      eventSink,
      runsRoot,
      retry: { runDir: join(runsRoot, retryTarget.workflowRunName), kind: "manual" },
      ...(context.processRunner === undefined ? {} : { processRunner: context.processRunner }),
      ...(context.workingAgentProcessRunner === undefined
        ? {}
        : { workingAgentProcessRunner: context.workingAgentProcessRunner }),
      ...(stepkitConfig === undefined ? {} : { stepkitConfig }),
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

async function selectInteractiveRetryTarget(context: CliCommandContext): Promise<{
  readonly workflowId: string;
  readonly workflowRunName: string;
}> {
  const usageHint =
    "An explicit retry target is required in non-interactive mode. Expected stepkit retry <workflow-ref> <runName>.";
  if (context.prompts === undefined) {
    throw new CliUsageError(usageHint);
  }

  const eligibleRuns = await listEligibleRetryRuns({
    cwd: context.cwd,
    runsRoot: resolveRunsRoot(context),
  });
  if (eligibleRuns.length === 0) {
    context.io.writeLine("No eligible failed runs found to retry.");
    return Promise.reject(new NoEligibleRetryRuns());
  }

  const choices = eligibleRuns.map((run) => run.label);
  const selectedLabel = await promptSelect(
    "Select a failed run to retry",
    choices,
    context.prompts,
    usageHint,
  );
  const selectedRun = eligibleRuns.find((run) => run.label === selectedLabel);
  if (!selectedRun) {
    throw new CliUsageError(`Invalid retry selection: ${selectedLabel}`);
  }

  const confirmed = await promptYesNo(
    `Retry run ${selectedRun.runId} for workflow ${selectedRun.workflowId}?`,
    context.prompts,
    usageHint,
  );
  if (!confirmed) {
    context.io.writeLine("Retry cancelled.");
    return Promise.reject(new NoEligibleRetryRuns());
  }

  const workflowId =
    selectedRun.workflowRef ??
    (await promptText(
      `Workflow ref for run ${selectedRun.runId}`,
      undefined,
      context.prompts,
      "Workflow ref is required to retry runs created before workflow refs were persisted.",
    ));

  return { workflowId, workflowRunName: selectedRun.runId };
}

class NoEligibleRetryRuns extends Error {}
