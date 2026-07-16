import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentStepRequestConfig } from "../../authoring/step-kinds/agent-step.types.js";
import type { WorkflowAgentRole } from "../../shared/agent-role.types.js";
import { StepKitFailureError } from "../../shared/failure.js";
import type { PlainObject } from "../../shared/shape.types.js";
import type { WorkingAgentProcessResult, WorkingAgentProcessRunner } from "../engine.types.js";
import { providerRegistry } from "../provider-adapter/provider-adapter.js";
import type { ProviderWorkingRunner } from "../provider-adapter/provider-adapter.types.js";
import type { StepKitAgentTarget, StepKitConfig } from "../targeting/targeting.types.js";

export interface WorkingAgentFiles {
  readonly stepDir: string;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly usageFile: string;
}

export function resolveStepAgentFiles(options: {
  readonly runDir: string;
  readonly stepId: string;
}): WorkingAgentFiles {
  const stepDir = join(options.runDir, "steps", options.stepId);
  return {
    stepDir,
    promptFile: join(stepDir, "prompt.md"),
    outputFile: join(stepDir, "output.json"),
    usageFile: join(stepDir, "usage.json"),
  };
}

export function buildWorkingAgentPrompt(options: {
  readonly prompt: string;
  readonly outputFile: string;
  readonly outputSchema: Record<string, unknown>;
}): string {
  return [
    "# StepKit working-agent task",
    "",
    "Run the task described below and write exactly one JSON object to the output file.",
    "Do not write prose, markdown fences, or multiple JSON values to the output file.",
    "",
    `Output file: ${options.outputFile}`,
    "",
    "The JSON object must match this output schema:",
    "",
    "```json",
    JSON.stringify(options.outputSchema, null, 2),
    "```",
    "",
    "## Original prompt",
    "",
    options.prompt,
    "",
  ].join("\n");
}

/**
 * Prompt for a built-in registry provider's working-mode invocation. Unlike
 * `buildWorkingAgentPrompt`, this never instructs the vendor CLI to write a
 * file itself: a registry provider adapter captures stdout and writes
 * `outputFile` on the runtime's behalf, so the prompt instead asks for the
 * JSON object as the model's entire final answer.
 */
export function buildProviderWorkingPrompt(options: {
  readonly prompt: string;
  readonly outputSchema: Record<string, unknown>;
}): string {
  return [
    "# StepKit working-agent task",
    "",
    "Respond with exactly one JSON object as your entire final answer.",
    "Do not write output to a file. Do not include prose, markdown fences, or multiple JSON values in your final answer - only the JSON object itself.",
    "",
    "The JSON object must match this output schema:",
    "",
    "```json",
    JSON.stringify(options.outputSchema, null, 2),
    "```",
    "",
    "## Original prompt",
    "",
    options.prompt,
    "",
  ].join("\n");
}

export async function runWorkingAgentCommand<TOutput extends PlainObject>(options: {
  readonly config: StepKitConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
  readonly renderedPrompt: string;
  readonly runDir: string;
  readonly runner?: WorkingAgentProcessRunner;
  readonly providerWorkingRunner?: ProviderWorkingRunner;
}): Promise<TOutput> {
  const targets = resolveWorkingAgentFallbackTargets({
    config: options.config,
    workflowId: options.workflowId,
    roleName: options.roleName,
    roleSize: options.role.size,
  });

  if (targets.length === 0) {
    throw new StepKitFailureError({
      code: "agent_targets_unavailable",
      message: `No working agent targets found for role ${options.roleName} with size ${options.role.size} in workflow ${options.workflowId}.`,
    });
  }

  const files = resolveStepAgentFiles({ runDir: options.runDir, stepId: options.step.id });
  await mkdir(files.stepDir, { recursive: true });
  await writeFile(
    files.promptFile,
    buildWorkingAgentPrompt({
      prompt: options.renderedPrompt,
      outputFile: files.outputFile,
      outputSchema: options.step.output.jsonSchema,
    }),
    "utf8",
  );

  const failures: WorkingAgentAttemptFailure[] = [];

  for (const target of targets) {
    try {
      return await runWorkingAgentTargetAttempt({ ...options, target, files });
    } catch (error) {
      failures.push(summarizeWorkingAgentAttemptFailure(target, error));
    }
  }

  throw new StepKitFailureError({
    code: "agent_target_exhausted",
    message: `Working agent step ${options.step.id} for role ${options.roleName} exhausted ${failures.length} target(s).`,
    details: {
      stepId: options.step.id,
      roleName: options.roleName,
      attempts: failures,
    },
  });
}

interface WorkingAgentAttemptFailure {
  readonly target: string;
  readonly model?: string;
  readonly code: string;
  readonly message: string;
}

function resolveWorkingAgentFallbackTargets(options: {
  readonly config: StepKitConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly roleSize: WorkflowAgentRole["size"];
}): readonly StepKitAgentTarget[] {
  const workflowTargets =
    options.config.workflows?.[options.workflowId]?.workingAgents?.[options.roleName];
  const sizeTargets = options.config.workingAgents[options.roleSize];
  const defaultTargets = options.config.workingAgents.default;

  return [workflowTargets, sizeTargets, defaultTargets].flatMap((targets) =>
    targets && targets.length > 0 ? [...targets] : [],
  );
}

async function runWorkingAgentTargetAttempt<TOutput extends PlainObject>(options: {
  readonly config: StepKitConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
  readonly renderedPrompt: string;
  readonly runDir: string;
  readonly runner?: WorkingAgentProcessRunner;
  readonly providerWorkingRunner?: ProviderWorkingRunner;
  readonly target: StepKitAgentTarget;
  readonly files: WorkingAgentFiles;
}): Promise<TOutput> {
  await rm(options.files.outputFile, { force: true });
  await rm(options.files.usageFile, { force: true });

  const provider = providerRegistry[options.target.provider as keyof typeof providerRegistry];
  if (provider) {
    await writeFile(
      options.files.promptFile,
      buildProviderWorkingPrompt({
        prompt: options.renderedPrompt,
        outputSchema: options.step.output.jsonSchema,
      }),
      "utf8",
    );

    const thinking = resolveWorkingThinking(options.target, options.role);
    await provider.runWorking(
      {
        promptFile: options.files.promptFile,
        outputFile: options.files.outputFile,
        usageFile: options.files.usageFile,
        cwd: options.runDir,
        ...(options.target.model === undefined ? {} : { model: options.target.model }),
        ...(thinking === undefined ? {} : { thinking }),
      },
      options.providerWorkingRunner,
    );

    return readWorkingAgentOutput({
      stepId: options.step.id,
      outputFile: options.files.outputFile,
      step: options.step,
    });
  }

  const agentConfig = options.config.customAgents[options.target.provider];
  if (!agentConfig) {
    throw new StepKitFailureError({
      code: "agent_provider_unavailable",
      message: `Working agent target '${options.target.provider}' does not reference a configured custom agent.`,
      details: { provider: options.target.provider },
    });
  }

  const args = buildWorkingAgentArgs({
    argv: options.target.args ?? agentConfig.args,
    promptFile: options.files.promptFile,
    outputFile: options.files.outputFile,
    model: options.target.model,
  });

  let result: WorkingAgentProcessResult;
  try {
    result = await (options.runner ?? spawnWorkingAgentProcess)({
      command: agentConfig.binary,
      args,
      cwd: options.runDir,
      shell: false,
      stdio: "inherit",
      promptFile: options.files.promptFile,
      outputFile: options.files.outputFile,
      ...(options.target.model === undefined ? {} : { model: options.target.model }),
    });
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_provider_spawn_error",
      message: `Working agent step ${options.step.id} could not start target '${options.target.provider}'.`,
      details: {
        target: options.target.provider,
        ...(options.target.model === undefined ? {} : { model: options.target.model }),
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }

  if (result.exitCode !== 0) {
    throw new StepKitFailureError({
      code: "agent_provider_failed",
      message: `Working agent step ${options.step.id} target '${options.target.provider}' exited with code ${result.exitCode}.`,
      details: {
        exitCode: result.exitCode,
        provider: agentConfig.binary,
        target: options.target.provider,
        ...(options.target.model === undefined ? {} : { model: options.target.model }),
      },
    });
  }

  return readWorkingAgentOutput({
    stepId: options.step.id,
    outputFile: options.files.outputFile,
    step: options.step,
  });
}

function resolveWorkingThinking(
  target: StepKitAgentTarget,
  role: WorkflowAgentRole,
): WorkflowAgentRole["thinking"] {
  return target.thinking ?? role.thinking;
}

function summarizeWorkingAgentAttemptFailure(
  target: StepKitAgentTarget,
  error: unknown,
): WorkingAgentAttemptFailure {
  if (error instanceof StepKitFailureError) {
    return {
      target: target.provider,
      ...(target.model === undefined ? {} : { model: target.model }),
      code: error.failure.code,
      message: error.failure.message,
    };
  }

  return {
    target: target.provider,
    ...(target.model === undefined ? {} : { model: target.model }),
    code: "agent_target_failed",
    message: error instanceof Error ? error.message : "Working agent target failed.",
  };
}

export function buildWorkingAgentArgs(options: {
  readonly argv: readonly string[] | undefined;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly model?: string;
}): string[] {
  if (!options.argv) {
    return [
      "--prompt-file",
      options.promptFile,
      "--output-file",
      options.outputFile,
      ...(options.model ? ["--model", options.model] : []),
    ];
  }

  return options.argv.map((arg) => {
    switch (arg) {
      case "{{promptFile}}":
        return options.promptFile;
      case "{{outputFile}}":
        return options.outputFile;
      case "{{model}}":
        return options.model ?? "";
      default:
        if (
          arg.includes("{{promptFile}}") ||
          arg.includes("{{outputFile}}") ||
          arg.includes("{{model}}")
        ) {
          throw new StepKitFailureError({
            code: "agent_provider_invalid",
            message: "Working agent command placeholders must be whole argv values.",
          });
        }
        return arg;
    }
  });
}

export async function readWorkingAgentOutput<TOutput extends PlainObject>(options: {
  readonly stepId: string;
  readonly outputFile: string;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
}): Promise<TOutput> {
  let raw: string;
  try {
    raw = await readFile(options.outputFile, "utf8");
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_output_unreadable",
      message: `Working agent step ${options.stepId} output.json could not be read.`,
      details:
        error instanceof Error
          ? { path: options.outputFile, cause: error.message }
          : { path: options.outputFile },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_output_invalid_json",
      message: `Working agent step ${options.stepId} output.json must contain one JSON object.`,
      details:
        error instanceof Error
          ? { path: options.outputFile, cause: error.message }
          : { path: options.outputFile },
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StepKitFailureError({
      code: "agent_output_invalid_json",
      message: `Working agent step ${options.stepId} output.json must contain one JSON object.`,
      details: { path: options.outputFile },
    });
  }

  return options.step.output.assert(parsed, `step ${options.stepId} output`);
}

const spawnWorkingAgentProcess: WorkingAgentProcessRunner = async ({ command, args, cwd }) => {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
  });
};
