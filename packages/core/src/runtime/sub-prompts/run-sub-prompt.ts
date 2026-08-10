import { mkdir, writeFile } from "node:fs/promises";

import { runAgentStep } from "../../agent-execution/adapter-agent/run-adapter-agent-step/run-adapter-agent-step.js";
import {
  resolvePromptSource,
  resolveWorkflowAgentRole,
} from "../../agent-execution/dispatch-agent-step/dispatch-agent-step.js";
import { runWorkingAgentCommand } from "../../agent-execution/working-agent/run-working-agent-command.js";
import { normalizeShape } from "../../authoring/shape/json-schema.js";
import type {
  PromptTemplateSource,
  SubPromptOptions,
} from "../../authoring/step/continuation.types.js";
import type { AgentPrompt } from "../../contracts/agents/agent-adapter.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { createEvent } from "../events/create-run-event.js";
import { runContextStorage } from "../run-context/run-context-storage.js";
import { resolveSubPromptArtifactPaths } from "./sub-prompt-artifacts.js";
import {
  emitSubPromptFailed,
  maxSubPromptsGuardError,
  subPromptFailureError,
  throwMissingSubPromptAgentConfig,
} from "./sub-prompt-failures.js";
import { fingerprintSubPrompt } from "./sub-prompt-fingerprint.js";
import { findCompletedSubPromptEvent } from "./sub-prompt-replay.js";

export function resolveMaxSubPrompts(value: unknown): number {
  if (value === undefined) {
    return 25;
  }

  if (Number.isInteger(value) && typeof value === "number" && value > 0) {
    return value;
  }

  throw new TrailStepFailureError({
    code: "invalid_max_sub_prompts",
    message: "maxSubPrompts must be a positive integer.",
  });
}

export async function runSubPrompt<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(
  source: AgentPrompt<TInput> | PromptTemplateSource,
  options: SubPromptOptions<TOutput>,
  input?: TInput,
): Promise<TOutput> {
  const resolvedInput = (input ?? {}) as TInput;
  const context = runContextStorage.getStore();
  if (!context?.currentStep) {
    throw new TrailStepFailureError({
      code: "sub_prompt_outside_step_context",
      message: "subPrompt requires an active TrailStep step run context.",
    });
  }

  if (!context.workflowId || !context.workflowAgents || !context.cwd || !context.emit) {
    throw new TrailStepFailureError({
      code: "sub_prompt_context_unavailable",
      message: "subPrompt requires a full active TrailStep step run context.",
    });
  }

  const parentStep = context.currentStep;
  if (options.output === undefined) {
    throw new TrailStepFailureError({
      code: "sub_prompt_output_required",
      message: `subPrompt in step ${parentStep.id} with a prompt requires an output shape`,
    });
  }

  const outputSchema = normalizeShape(options.output);
  const ordinal = parentStep.nextSubPromptIndex();
  const maxSubPrompts = resolveMaxSubPrompts(options.maxSubPrompts ?? parentStep.maxSubPrompts);
  if (ordinal > maxSubPrompts) {
    const failureError = maxSubPromptsGuardError(maxSubPrompts);
    await emitSubPromptFailed({
      context,
      parentStepId: parentStep.id,
      ordinal,
      failure: failureError.failure,
    });
    throw failureError;
  }

  const renderedPrompt = await resolvePromptSource(source, resolvedInput, context.cwd);
  const fingerprint = fingerprintSubPrompt({ input: resolvedInput, prompt: renderedPrompt });
  const cachedEvent = findCompletedSubPromptEvent(
    context.events?.() ?? [],
    parentStep.id,
    ordinal,
    fingerprint,
  );
  if (cachedEvent) {
    return outputSchema.assert(cachedEvent.payload.output, "subPrompt output");
  }

  const artifactPaths = resolveSubPromptArtifactPaths({
    runDir: context.path,
    stepDir: parentStep.dir,
    ordinal,
    fingerprint,
  });

  await mkdir(artifactPaths.subPromptDir, { recursive: true });
  await writeFile(artifactPaths.promptFile, renderedPrompt, "utf8");

  const resolvedRole = resolveWorkflowAgentRole({
    agent: options.agent,
    workflowAgents: context.workflowAgents,
    workflowId: context.workflowId,
    stepId: parentStep.id,
  });

  await context.emit(
    createEvent({
      runId: context.id,
      workflowId: context.workflowId,
      stepId: parentStep.id,
      type: "subPrompt.started",
      payload: {
        parentStepId: parentStep.id,
        ordinal,
        fingerprint,
        artifactPaths: artifactPaths.runRelative,
      },
    }),
  );

  try {
    const agentStep = {
      kind: "agent" as const,
      id: `${parentStep.id}.subPrompt.${ordinal}`,
      output: outputSchema,
      prompt: renderedPrompt,
      requirements: resolvedRole.role,
      adapter: options.adapter,
    };

    if (!context.trailstepConfig && options.adapter === undefined) {
      throwMissingSubPromptAgentConfig({
        workflowId: context.workflowId,
        parentStepId: parentStep.id,
        subPromptId: agentStep.id,
        agent: resolvedRole.roleName,
      });
    }

    const rawOutput =
      context.trailstepConfig && options.adapter === undefined
        ? await runWorkingAgentCommand({
            config: context.trailstepConfig,
            workflowId: context.workflowId,
            roleName: resolvedRole.roleName,
            role: resolvedRole.role,
            step: agentStep,
            renderedPrompt,
            runDir: context.path,
            cwd: context.cwd,
            runner: context.workingAgentProcessRunner,
            providerWorkingRunner: context.providerWorkingRunner,
            stepIndex: ordinal,
            files: {
              stepDir: artifactPaths.subPromptDir,
              promptFile: artifactPaths.promptFile,
              outputFile: artifactPaths.outputFile,
              usageFile: artifactPaths.usageFile,
            },
          })
        : await runAgentStep({
            step: agentStep,
            input: resolvedInput,
            onToolCall: async (toolCall) => {
              await context.emit?.(
                createEvent({
                  runId: context.id,
                  workflowId: context.workflowId ?? "",
                  stepId: parentStep.id,
                  type: "agent.toolCall",
                  payload: { ...toolCall },
                }),
              );
            },
          });

    const output = outputSchema.assert(rawOutput, "subPrompt output");
    await writeFile(artifactPaths.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");

    await context.emit(
      createEvent({
        runId: context.id,
        workflowId: context.workflowId,
        stepId: parentStep.id,
        type: "subPrompt.completed",
        payload: {
          parentStepId: parentStep.id,
          ordinal,
          fingerprint,
          output,
          artifactPaths: artifactPaths.runRelative,
        },
      }),
    );

    return output;
  } catch (error) {
    const failureError = subPromptFailureError(error);
    await emitSubPromptFailed({
      context,
      parentStepId: parentStep.id,
      ordinal,
      fingerprint,
      artifactPaths: artifactPaths.runRelative,
      failure: failureError.failure,
    });
    throw failureError;
  }
}
