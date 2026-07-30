import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { StepKitConfig } from "../../agent-targeting/targeting.types.js";
import type {
  ContinuationStepConfig,
  PromptTemplateSource,
} from "../../authoring/step/continuation.types.js";
import type { AgentPrompt } from "../../contracts/agents/agent-adapter.types.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import { StepKitFailureError } from "../../contracts/failures/failure.js";
import type { PlainObject, Schema } from "../../contracts/shapes/shape.types.js";
import { resolveStepArtifactPaths } from "../../runtime/artifacts/step-artifacts.js";
import { createEvent } from "../../runtime/events/create-run-event.js";
import type { Event, RunWorkflowOptions } from "../../runtime/run-workflow/run-workflow.types.js";
import {
  renderAgentPrompt,
  runAgentStep,
} from "../adapter-agent/run-adapter-agent-step/run-adapter-agent-step.js";
import { runInteractiveAgentCommand } from "../interactive-agent/run-interactive-agent-command.js";
import { runWorkingAgentCommand } from "../working-agent/run-working-agent-command.js";

/**
 * Runs a `.prompt(...)` step's agent dispatch: resolves the workflow agent
 * role, renders the prompt, and executes it in adapter, working, or
 * interactive mode. Only called when `config.prompt` is defined — a step
 * with no prompt is never dispatched at all (see `runContinuation` in
 * `engine.ts`, which calls `stepNode.onOutput` directly on the step's input
 * in that case).
 */
export async function dispatchAgentStep(options: {
  readonly config: ContinuationStepConfig & {
    readonly prompt: NonNullable<ContinuationStepConfig["prompt"]>;
  };
  readonly outputSchema: Schema;
  readonly interactiveOutputMode: "session-file" | "json";
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly runDir: string;
  readonly cwd: string;
  readonly stepkitConfig: StepKitConfig | undefined;
  readonly workingAgentProcessRunner: RunWorkflowOptions["workingAgentProcessRunner"];
  readonly providerWorkingRunner: RunWorkflowOptions["providerWorkingRunner"];
  readonly processRunner: RunWorkflowOptions["processRunner"];
  readonly stepIndex: number;
}): Promise<PlainObject> {
  const { config, outputSchema } = options;

  const resolvedRole = resolveWorkflowAgentRole({
    agent: config.agent,
    workflowAgents: options.workflowAgents,
    workflowId: options.workflowId,
    stepId: config.id,
  });

  const renderedPrompt = await resolvePromptSource(config.prompt, config.input, options.cwd);
  const agentMode = config.mode ?? "working";

  const agentStep = {
    kind: "agent" as const,
    id: config.id,
    output: outputSchema,
    prompt: renderedPrompt,
    requirements: resolvedRole.role,
    adapter: config.adapter,
  };

  if (!options.stepkitConfig && config.adapter === undefined) {
    throwMissingAgentConfig({
      workflowId: options.workflowId,
      stepId: config.id,
      agent: resolvedRole.roleName,
      mode: agentMode,
    });
  }

  if (options.stepkitConfig && agentMode === "interactive") {
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: config.id,
        type: "interactive.sessionStarted",
        payload: { roleName: resolvedRole.roleName, stepIndex: options.stepIndex },
      }),
    );
    const artifactPaths = resolveStepArtifactPaths({
      runDir: options.runDir,
      stepId: config.id,
      stepIndex: options.stepIndex,
    });
    const interactiveResult = await runInteractiveAgentCommand({
      config: options.stepkitConfig,
      workflowId: options.workflowId,
      roleName: resolvedRole.roleName,
      role: resolvedRole.role,
      stepId: config.id,
      renderedPrompt,
      runDir: options.runDir,
      runner: options.processRunner,
      outputSchema,
      outputMode: options.interactiveOutputMode,
      artifactPaths,
    });
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: config.id,
        type: "interactive.sessionCompleted",
        payload: {
          exitCode: interactiveResult.exitCode,
          outputMode: options.interactiveOutputMode,
          stepDir: artifactPaths.runRelativeStepDir,
        },
      }),
    );
    return interactiveResult.output;
  }

  return options.stepkitConfig && agentMode === "working"
    ? await runWorkingAgentCommand({
        config: options.stepkitConfig,
        workflowId: options.workflowId,
        roleName: resolvedRole.roleName,
        role: resolvedRole.role,
        step: agentStep,
        renderedPrompt,
        runDir: options.runDir,
        cwd: options.cwd,
        runner: options.workingAgentProcessRunner,
        providerWorkingRunner: options.providerWorkingRunner,
        stepIndex: options.stepIndex,
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
export async function resolvePromptSource<TInput extends PlainObject>(
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

const DEFAULT_AGENT_ROLE_NAME = "default";

const BUILTIN_DEFAULT_AGENT_ROLE: WorkflowAgentRole = { size: "default" };

/**
 * A step's `.agent` is optional. With none given, falls back to
 * `workflow.agents.default` if the workflow declares one, else a builtin
 * `{ size: "default" }` role — which `resolveAgentTargets` in turn resolves
 * against `.stepkit/config.json`'s unified `agents.default` mapping. An explicit `.agent(...)` naming an undeclared
 * role is still a hard error (typo protection).
 */
export function resolveWorkflowAgentRole(options: {
  readonly agent: string | undefined;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly workflowId: string;
  readonly stepId: string;
}): { readonly role: WorkflowAgentRole; readonly roleName: string } {
  const roleName = options.agent ?? DEFAULT_AGENT_ROLE_NAME;
  const role = options.workflowAgents[roleName];

  if (role) {
    return { role, roleName };
  }

  if (options.agent === undefined) {
    return { role: BUILTIN_DEFAULT_AGENT_ROLE, roleName: DEFAULT_AGENT_ROLE_NAME };
  }

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
