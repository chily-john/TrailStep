import type { Failure } from "../../contracts/failures/failure.js";
import { StepKitFailureError } from "../../contracts/failures/failure.js";
import type { RunContext } from "../../contracts/run-context/run-context.types.js";
import { createEvent } from "../events/create-run-event.js";
import { isFailureLikeError } from "../failures/failure-like.js";

export async function emitSubPromptFailed(options: {
  readonly context: RunContext;
  readonly parentStepId: string;
  readonly ordinal: number;
  readonly fingerprint?: string;
  readonly artifactPaths?: {
    readonly subPromptDir: string;
    readonly promptFile: string;
    readonly outputFile: string;
  };
  readonly failure: Failure;
}): Promise<void> {
  await options.context.emit?.(
    createEvent({
      runId: options.context.id,
      workflowId: options.context.workflowId ?? "",
      stepId: options.parentStepId,
      type: "subPrompt.failed",
      payload: {
        parentStepId: options.parentStepId,
        ordinal: options.ordinal,
        ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
        ...(options.artifactPaths === undefined ? {} : { artifactPaths: options.artifactPaths }),
        failure: options.failure,
      },
    }),
  );
}

export function maxSubPromptsGuardError(maxSubPrompts: number): StepKitFailureError {
  return new StepKitFailureError({
    code: "max_sub_prompts_exceeded",
    message: `workflow exceeded maxSubPrompts guard (${maxSubPrompts})`,
  });
}

export function throwMissingSubPromptAgentConfig(options: {
  readonly workflowId: string;
  readonly parentStepId: string;
  readonly subPromptId: string;
  readonly agent: string;
}): never {
  throw new StepKitFailureError({
    code: "missing_agent_config",
    message: `Missing .stepkit/config.json: workflow ${options.workflowId} parent step ${options.parentStepId} subPrompt ${options.subPromptId} needs configured working agent '${options.agent}'.`,
    details: {
      workflowId: options.workflowId,
      parentStepId: options.parentStepId,
      subPromptId: options.subPromptId,
      agent: options.agent,
      mode: "working",
    },
  });
}

export function subPromptFailureError(error: unknown): StepKitFailureError {
  if (error instanceof StepKitFailureError) {
    if (error.failure.code === "validation_failed") {
      return new StepKitFailureError({
        ...error.failure,
        message: normalizeSubPromptValidationMessage(error.failure.message),
      });
    }

    return error;
  }

  if (isFailureLikeError(error)) {
    return new StepKitFailureError(error.failure);
  }

  return new StepKitFailureError({
    code: "sub_prompt_failed",
    message: error instanceof Error ? error.message : "subPrompt failed.",
    ...(error instanceof Error
      ? { details: { name: error.name } }
      : error === undefined
        ? {}
        : { details: { cause: error } }),
  });
}

function normalizeSubPromptValidationMessage(message: string): string {
  if (message.startsWith("subPrompt output failed schema validation")) {
    return message;
  }

  const diagnostics = message.match(/failed schema validation: (.*)$/)?.[1];
  return diagnostics === undefined
    ? `subPrompt output failed schema validation: ${message}`
    : `subPrompt output failed schema validation: ${diagnostics}`;
}
