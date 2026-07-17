import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  ContinuationStepConfig,
  PromptTemplateSource,
} from "../authoring/continuation.types.js";
import type { AgentPrompt } from "../shared/agent-selection.types.js";
import type { WorkflowAgentRole } from "../shared/agent-role.types.js";
import { StepKitFailureError } from "../shared/failure.js";
import type { PlainObject, Schema } from "../shared/shape.types.js";
import type { Event, RunWorkflowOptions } from "./engine.types.js";
import { createEvent } from "./run-events.js";
import { renderAgentPrompt, runAgentStep } from "./step-kinds/run-agent-step.js";
import { runWorkingAgentCommand } from "./step-kinds/run-command-agent-step.js";
import { runInteractiveAgentCommand } from "./step-kinds/run-interactive-step.js";

/**
 * Runs a `.prompt(...)` step's agent dispatch: resolves the workflow agent
 * role, renders the prompt, and executes it in adapter, working, or
 * interactive mode. Only called when `config.prompt` is defined — a step
 * with no prompt is never dispatched at all (see `runContinuation` in
 * `engine.ts`, which calls `stepNode.onOutput` directly on the step's input
 * in that case).
 */
export async function dispatchAgentStep(options: {
  readonly config: ContinuationStepConfig & { readonly prompt: NonNullable<ContinuationStepConfig["prompt"]> };
  readonly outputSchema: Schema;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly runDir: string;
  readonly cwd: string;
  readonly stepkitConfig: RunWorkflowOptions["stepkitConfig"];
  readonly workingAgentProcessRunner: RunWorkflowOptions["workingAgentProcessRunner"];
  readonly providerWorkingRunner: RunWorkflowOptions["providerWorkingRunner"];
  readonly processRunner: RunWorkflowOptions["processRunner"];
}): Promise<PlainObject> {
  const { config, outputSchema } = options;

  const resolvedRole = resolveWorkflowAgentRole({
    agent: config.agent,
    workflowAgents: options.workflowAgents,
    workflowId: options.workflowId,
    stepId: config.id,
  });

  const renderedPrompt = await resolvePromptSource(config.prompt, config.input, options.cwd);
  const agentMode = config.agentMode ?? "working";

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
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: config.id,
        type: "interactive.sessionCompleted",
        payload: { exitCode: interactiveResult.exitCode, outputMode: "opaque" },
      }),
    );
    return interactiveResult.output;
  }

  return config.agent && options.stepkitConfig && agentMode === "working"
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

/**
 * Resolves a step's prompt source to a rendered string. A `promptTemplate(...)`
 * source is read from disk relative to the workflow's `cwd`; a thrown/rejected
 * read propagates up through the same try/catch that already wraps step
 * dispatch, so an unreadable file becomes a normal step failure. Any other
 * source (string or callback) renders synchronously via `renderAgentPrompt`.
 */
async function resolvePromptSource<TInput extends PlainObject>(
  source: AgentPrompt<TInput> | PromptTemplateSource,
  input: TInput,
  cwd: string,
): Promise<string> {
  if (isPromptTemplateSource(source)) {
    return await readFile(resolve(cwd, source.path), "utf8");
  }

  return renderAgentPrompt(source, input);
}

function isPromptTemplateSource(
  source: AgentPrompt<PlainObject> | PromptTemplateSource,
): source is PromptTemplateSource {
  return typeof source === "object" && source !== null && source.kind === "promptTemplate";
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
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly workflowId: string;
  readonly stepId: string;
}): WorkflowAgentRole {
  if (!options.agent) {
    throw new Error(
      `step ${options.stepId} with a prompt requires an agent role: declare workflow.agents and reference it with step agent`,
    );
  }

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
