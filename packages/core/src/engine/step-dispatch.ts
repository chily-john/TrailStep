import type { ContinuationStepConfig } from "../authoring/continuation.types.js";
import type { WorkflowAgentRole } from "../shared/agent-role.types.js";
import { StepKitFailureError } from "../shared/failure.js";
import type { PlainObject, Schema } from "../shared/shape.types.js";
import type { Event, RunWorkflowOptions } from "./engine.types.js";
import { createEvent } from "./run-events.js";
import { renderAgentPrompt, runAgentStep } from "./step-kinds/run-agent-step.js";
import { runCodeStep } from "./step-kinds/run-code-step.js";
import { runWorkingAgentCommand } from "./step-kinds/run-command-agent-step.js";
import { runInteractiveAgentCommand } from "./step-kinds/run-interactive-step.js";

/**
 * Routes a continuation `step(...)` node's `config` to the right execution
 * kind: code (`config.run`), agent-adapter-mode, working-mode, or
 * interactive-mode (all under `config.prompt`). This is the single place the
 * `config.run`/`config.prompt`/`config.agentMode` switch lives — the four
 * `step-kinds/*` modules underneath never decide which of themselves to run.
 */
export async function dispatchContinuationStep(options: {
  readonly config: ContinuationStepConfig;
  readonly outputSchema: Schema;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly runDir: string;
  readonly stepkitConfig: RunWorkflowOptions["stepkitConfig"];
  readonly workingAgentProcessRunner: RunWorkflowOptions["workingAgentProcessRunner"];
  readonly providerWorkingRunner: RunWorkflowOptions["providerWorkingRunner"];
  readonly processRunner: RunWorkflowOptions["processRunner"];
}): Promise<{ readonly rawOutput: PlainObject; readonly stepKind: "code" | "agent" }> {
  const { config, outputSchema } = options;
  const hasRun = typeof config.run === "function";
  const hasPrompt = config.prompt !== undefined;

  if (hasRun === hasPrompt) {
    throw new Error(`step ${config.id} must declare exactly one execution mode: run or prompt`);
  }

  if (hasPrompt) {
    const resolvedRole = resolveWorkflowAgentRole({
      agent: config.agent,
      requirements: config.requirements,
      workflowAgents: options.workflowAgents,
      workflowId: options.workflowId,
      stepId: config.id,
    });

    const renderedPrompt = renderAgentPrompt(config.prompt, config.input);
    const agentMode = config.agentMode ?? "working";

    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: config.id,
        type: "step.started",
        payload: { stepName: config.id, kind: "agent" },
      }),
    );

    const agentStep = {
      kind: "agent" as const,
      id: config.id,
      output: outputSchema,
      prompt: renderedPrompt,
      requirements: resolvedRole,
      adapter: config.adapter,
    };

    if (config.agent && !options.stepkitConfig && config.adapter === undefined) {
      throwMissingAgentConfig({
        workflowId: options.workflowId,
        stepId: config.id,
        agent: config.agent,
        mode: agentMode,
      });
    }

    let rawOutput: PlainObject;

    if (config.agent && options.stepkitConfig && agentMode === "interactive") {
      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          stepId: config.id,
          type: "interactive.sessionStarted",
          payload: { roleName: config.agent },
        }),
      );
      const interactiveResult = await runInteractiveAgentCommand({
        config: options.stepkitConfig,
        workflowId: options.workflowId,
        roleName: config.agent,
        role: resolvedRole,
        stepId: config.id,
        renderedPrompt,
        runDir: options.runDir,
        runner: options.processRunner,
      });
      rawOutput = interactiveResult.output;
      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          stepId: config.id,
          type: "interactive.sessionCompleted",
          payload: { exitCode: interactiveResult.exitCode, outputMode: "opaque" },
        }),
      );
    } else {
      rawOutput =
        config.agent && options.stepkitConfig && agentMode === "working"
          ? await runWorkingAgentCommand({
              config: options.stepkitConfig,
              workflowId: options.workflowId,
              roleName: config.agent,
              role: resolvedRole,
              step: agentStep,
              renderedPrompt,
              runDir: options.runDir,
              runner: options.workingAgentProcessRunner,
              providerWorkingRunner: options.providerWorkingRunner,
            })
          : await runAgentStep({
              step: agentStep,
              input: config.input,
              onToolCall: async (toolCall) => {
                await options.emit(
                  createEvent({
                    runId: options.runId,
                    workflowId: options.workflowId,
                    stepId: config.id,
                    type: "agent.toolCall",
                    payload: { ...toolCall },
                  }),
                );
              },
            });
    }

    return { rawOutput, stepKind: "agent" };
  }

  const run = config.run;
  if (!run) {
    throw new Error(`step ${config.id} run-mode requires run`);
  }

  await options.emit(
    createEvent({
      runId: options.runId,
      workflowId: options.workflowId,
      stepId: config.id,
      type: "step.started",
      payload: { stepName: config.id, kind: "code" },
    }),
  );

  const rawOutput = await runCodeStep(run, config.input);

  return { rawOutput, stepKind: "code" };
}

function throwMissingAgentConfig(options: {
  readonly workflowId: string;
  readonly stepId: string;
  readonly agent: string;
  readonly mode: "working" | "interactive";
}): never {
  throw new StepKitFailureError({
    code: "missing_agent_config",
    message: `Missing .stepkit/config.json: workflow ${options.workflowId} step ${options.stepId} needs configured ${options.mode} agent '${options.agent}'.`,
    details: {
      workflowId: options.workflowId,
      stepId: options.stepId,
      agent: options.agent,
      mode: options.mode,
    },
  });
}

function resolveWorkflowAgentRole(options: {
  readonly agent: string | undefined;
  readonly requirements: WorkflowAgentRole | undefined;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly workflowId: string;
  readonly stepId: string;
}): WorkflowAgentRole {
  if (options.agent) {
    const role = options.workflowAgents[options.agent];
    if (!role) {
      throw new StepKitFailureError({
        code: "agent_role_unknown",
        message: `Step ${options.stepId} references unknown agent role '${options.agent}' in workflow ${options.workflowId}. Declare workflow.agents.${options.agent} before referencing it with step agent.`,
        details: {
          workflowId: options.workflowId,
          stepId: options.stepId,
          agent: options.agent,
          declaredAgents: Object.keys(options.workflowAgents),
        },
      });
    }

    return role;
  }

  if (options.requirements) {
    return options.requirements;
  }

  throw new Error(
    `step ${options.stepId} prompt-mode requires a workflow agent role: declare workflow.agents and reference it with step agent`,
  );
}
