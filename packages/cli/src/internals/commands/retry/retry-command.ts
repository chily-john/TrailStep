import { join } from "node:path";

import type { Event, PlainObject, RunWorkflowTrackRetryOptions } from "@trailstep/core";
import { readRunEvents, runWorkflow } from "@trailstep/core";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { loadTrailStepConfig } from "../../config/config.js";
import { promptSelect, promptText, promptYesNo } from "../../prompts/prompt-helpers.js";
import { resolveRunsRoot } from "../../runs-root.js";
import { resolveWorkflowReference } from "../../workflow-resolution/workflow-resolution.js";
import { createTerminalEventLogger } from "../run/terminal-event-logger.js";
import { writeRunWorkflowRef } from "../wait-run-helpers.js";
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
    let retryTarget: {
      readonly workflowId: string;
      readonly workflowRunName: string;
      readonly fresh: boolean;
      readonly track?: RunWorkflowTrackRetryOptions;
    };
    try {
      retryTarget =
        args.mode === "interactive"
          ? { ...(await selectInteractiveRetryTarget(context)), fresh: false }
          : {
              workflowId: args.workflowId,
              workflowRunName: args.workflowRunName,
              fresh: args.fresh,
              ...trackRetryOption(args.filter),
            };
    } catch (error) {
      if (error instanceof NoEligibleRetryRuns) {
        return 0;
      }

      throw error;
    }
    const trailstepConfig = await loadTrailStepConfig(cwd, { homeDir: context.homeDir });
    const resolvedWorkflow = await resolveWorkflowReference(retryTarget.workflowId, {
      cwd,
      homeDir: context.homeDir,
    });

    if (!resolvedWorkflow) {
      io.writeError(
        `Workflow not found: ${retryTarget.workflowId}. Run trailstep workflows to see available workflows.`,
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
      eventSink,
      runsRoot,
      ...(context.processRunner === undefined ? {} : { processRunner: context.processRunner }),
      ...(context.workingAgentProcessRunner === undefined
        ? {}
        : { workingAgentProcessRunner: context.workingAgentProcessRunner }),
      ...(trailstepConfig === undefined ? {} : { trailstepConfig }),
    };

    const result = retryTarget.fresh
      ? await runWorkflow({
          ...sharedRunOptions,
          input: await readOriginalInput(join(runsRoot, retryTarget.workflowRunName)),
          runName: retryTarget.workflowRunName,
        })
      : await runWorkflow({
          ...sharedRunOptions,
          retry: {
            runDir: join(runsRoot, retryTarget.workflowRunName),
            kind: "manual",
            ...(retryTarget.track === undefined ? {} : { track: retryTarget.track }),
          },
        });

    if (retryTarget.fresh) {
      await writeRunWorkflowRef(result.runDir, retryTarget.workflowId);
    }

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
    "An explicit retry target is required in non-interactive mode. Expected trailstep retry <workflow-ref> <runName>.";
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

function trackRetryOption(
  filter: Extract<RetryCommandArgs, { readonly mode: "explicit" }>["filter"],
): { readonly track?: RunWorkflowTrackRetryOptions } {
  if (filter.mode === "default") {
    return {};
  }
  if (filter.mode === "failed-only") {
    return { track: { mode: "failed-only" } };
  }
  return { track: { mode: "branch", branchId: filter.branchId } };
}

async function readOriginalInput(runDir: string): Promise<PlainObject> {
  const events = await readRunEvents(runDir);
  const startedEvent = events.find((event) => event.type === "workflow.started");
  const input = startedEvent?.payload.input;
  if (!isPlainObject(input)) {
    throw new CliUsageError(`Run ${runDir} does not record an object workflow input for --fresh.`);
  }
  return input;
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class NoEligibleRetryRuns extends Error {}
