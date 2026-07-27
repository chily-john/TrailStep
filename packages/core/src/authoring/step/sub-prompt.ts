import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { runAgentStep } from "../../agent-execution/adapter-agent/run-adapter-agent-step/run-adapter-agent-step.js";
import {
  resolvePromptSource,
  resolveWorkflowAgentRole,
} from "../../agent-execution/dispatch-agent-step/dispatch-agent-step.js";
import { runWorkingAgentCommand } from "../../agent-execution/working-agent/run-working-agent-command/run-working-agent-command.js";
import type { AgentPrompt } from "../../contracts/agents/agent-adapter.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import { StepKitFailureError } from "../../contracts/failures/failure.js";
import type { RunContext, RunContextEvent } from "../../contracts/run-context/run-context.types.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { createEvent } from "../../runtime/events/create-run-event.js";
import { runContextStorage } from "../../runtime/run-context/run-context-storage.js";
import { normalizeShape } from "../shape/json-schema.js";
import type {
  PromptTemplateSource,
  SubPromptFactory,
  SubPromptOptions,
} from "./continuation.types.js";

export function subPrompt<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(
  source: AgentPrompt<TInput> | PromptTemplateSource,
  options: SubPromptOptions<TOutput>,
): SubPromptFactory<TInput, TOutput> {
  const run = async (input?: TInput): Promise<TOutput> => {
    const resolvedInput = (input ?? {}) as TInput;
    const context = runContextStorage.getStore();
    if (!context?.currentStep) {
      throw new StepKitFailureError({
        code: "sub_prompt_outside_step_context",
        message: "subPrompt requires an active StepKit step run context.",
      });
    }

    if (!context.workflowId || !context.workflowAgents || !context.cwd || !context.emit) {
      throw new StepKitFailureError({
        code: "sub_prompt_context_unavailable",
        message: "subPrompt requires a full active StepKit step run context.",
      });
    }

    const parentStep = context.currentStep;
    if (options.output === undefined) {
      throw new StepKitFailureError({
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

      if (!context.stepkitConfig && options.adapter === undefined) {
        throwMissingSubPromptAgentConfig({
          workflowId: context.workflowId,
          parentStepId: parentStep.id,
          subPromptId: agentStep.id,
          agent: resolvedRole.roleName,
        });
      }

      const rawOutput =
        context.stepkitConfig && options.adapter === undefined
          ? await runWorkingAgentCommand({
              config: context.stepkitConfig,
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
  };

  return run as SubPromptFactory<TInput, TOutput>;
}

interface CompletedSubPromptEventPayload extends PlainObject {
  readonly parentStepId: string;
  readonly ordinal: number;
  readonly fingerprint: string;
  readonly output: PlainObject;
}

async function emitSubPromptFailed(options: {
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

export function resolveMaxSubPrompts(value: unknown): number {
  if (value === undefined) {
    return 25;
  }

  if (Number.isInteger(value) && typeof value === "number" && value > 0) {
    return value;
  }

  throw new StepKitFailureError({
    code: "invalid_max_sub_prompts",
    message: "maxSubPrompts must be a positive integer.",
  });
}

function maxSubPromptsGuardError(maxSubPrompts: number): StepKitFailureError {
  return new StepKitFailureError({
    code: "max_sub_prompts_exceeded",
    message: `workflow exceeded maxSubPrompts guard (${maxSubPrompts})`,
  });
}

function throwMissingSubPromptAgentConfig(options: {
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

function subPromptFailureError(error: unknown): StepKitFailureError {
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

function isFailureLikeError(error: unknown): error is { readonly failure: Failure } {
  return (
    typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    typeof error.failure === "object" &&
    error.failure !== null &&
    "code" in error.failure &&
    "message" in error.failure
  );
}

function findCompletedSubPromptEvent(
  events: readonly RunContextEvent[],
  parentStepId: string,
  ordinal: number,
  fingerprint: string,
): RunContextEvent<CompletedSubPromptEventPayload> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "subPrompt.completed") {
      continue;
    }

    const payload = event.payload;
    if (
      payload.parentStepId === parentStepId &&
      payload.ordinal === ordinal &&
      payload.fingerprint === fingerprint &&
      isPlainObject(payload.output)
    ) {
      return event as RunContextEvent<CompletedSubPromptEventPayload>;
    }
  }

  return undefined;
}

function fingerprintSubPrompt(options: {
  readonly input: PlainObject;
  readonly prompt: string;
}): string {
  return createHash("sha256").update(stableJsonStringify(options)).digest("hex");
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function resolveSubPromptArtifactPaths(options: {
  readonly runDir: string;
  readonly stepDir: string;
  readonly ordinal: number;
  readonly fingerprint: string;
}): {
  readonly subPromptDir: string;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly usageFile: string;
  readonly runRelative: {
    readonly subPromptDir: string;
    readonly promptFile: string;
    readonly outputFile: string;
  };
} {
  const artifactSubPromptId = `${String(options.ordinal).padStart(4, "0")}-${options.fingerprint.slice(0, 12)}`;
  const subPromptDir = join(options.stepDir, "subPrompts", artifactSubPromptId);
  const promptFile = join(subPromptDir, "prompt.txt");
  const outputFile = join(subPromptDir, "output.json");
  const usageFile = join(subPromptDir, "usage.json");

  return {
    subPromptDir,
    promptFile,
    outputFile,
    usageFile,
    runRelative: {
      subPromptDir: toRunRelativePath(options.runDir, subPromptDir),
      promptFile: toRunRelativePath(options.runDir, promptFile),
      outputFile: toRunRelativePath(options.runDir, outputFile),
    },
  };
}

function toRunRelativePath(runDir: string, path: string): string {
  return relative(runDir, path).replaceAll("\\", "/");
}
