import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InteractiveStep } from "../../authoring/step-kinds/interactive-step.types.js";
import type { WorkflowAgentRole } from "../../shared/agent-role.types.js";
import { StepKitFailureError } from "../../shared/failure.js";
import type { PlainObject } from "../../shared/shape.types.js";
import type { InteractiveProcessResult, InteractiveProcessRunner } from "../engine.types.js";
import { providerRegistry } from "../provider-adapter/provider-adapter.js";
import { resolveAgentTargets } from "../targeting/targeting.js";
import type { StepKitAgentTarget, StepKitConfig } from "../targeting/targeting.types.js";

export async function runInteractiveAgentCommand(options: {
  readonly config: StepKitConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly stepId: string;
  readonly renderedPrompt: string;
  readonly runDir: string;
  readonly runner?: InteractiveProcessRunner;
}): Promise<{ readonly exitCode: number; readonly output: PlainObject }> {
  const [target] = resolveAgentTargets({
    config: options.config,
    workflowId: options.workflowId,
    roleName: options.roleName,
    roleSize: options.role.size,
    mode: "interactive",
  });

  if (!target) {
    throw new StepKitFailureError({
      code: "agent_targets_unavailable",
      message: `No interactive agent targets found for role ${options.roleName} with size ${options.role.size} in workflow ${options.workflowId}.`,
    });
  }

  return await runInteractiveAgentTarget({ ...options, target });
}

export async function runInteractiveStep(options: {
  readonly step: InteractiveStep;
  readonly runDir: string;
  readonly runner?: InteractiveProcessRunner;
}): Promise<{ readonly exitCode: number; readonly output: PlainObject }> {
  const parsed = parseCommandTemplate(options.step.command);
  if (parsed.length === 0) {
    throw new StepKitFailureError({
      code: "interactive_command_invalid",
      message: `Interactive step ${options.step.id} must declare a command.`,
    });
  }

  const stepDir = join(options.runDir, "steps", options.step.id);
  const promptFile = join(stepDir, "prompt.txt");
  const argv = await substitutePromptPlaceholders({
    argv: parsed,
    prompt: options.step.prompt,
    promptFile,
  });
  const [command, ...args] = argv;
  if (!command) {
    throw new StepKitFailureError({
      code: "interactive_command_invalid",
      message: `Interactive step ${options.step.id} must declare a command.`,
    });
  }

  const resultFile = resolveResultFile({ step: options.step, runDir: options.runDir });
  const result = await (options.runner ?? spawnInteractiveProcess)({
    command,
    args,
    cwd: options.runDir,
    shell: false,
    stdio: "inherit",
  });

  if (result.exitCode !== 0) {
    throw new StepKitFailureError({
      code: "interactive_session_failed",
      message: `Interactive step ${options.step.id} exited with code ${result.exitCode}.`,
      details: { exitCode: result.exitCode, outputMode: options.step.outputMode },
    });
  }

  if (options.step.outputMode === "file") {
    return {
      exitCode: result.exitCode,
      output: await readJsonResultFile(options.step.id, resultFile),
    };
  }

  return { exitCode: result.exitCode, output: { exitCode: result.exitCode } };
}

export function parseCommandTemplate(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) {
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new StepKitFailureError({
      code: "interactive_command_invalid",
      message: "Interactive command contains an unterminated quote.",
    });
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function resolveResultFile(options: {
  readonly step: InteractiveStep;
  readonly runDir: string;
}): string | undefined {
  if (options.step.outputMode !== "file") {
    return undefined;
  }

  const resultFileDeclaration = (options.step as { readonly resultFile?: unknown }).resultFile;
  if (typeof resultFileDeclaration !== "string" || resultFileDeclaration.trim().length === 0) {
    throw new StepKitFailureError({
      code: "interactive_result_file_invalid",
      message: `Interactive step ${options.step.id} must declare a result file path for file output.`,
    });
  }

  if (isAbsolute(resultFileDeclaration)) {
    throw new StepKitFailureError({
      code: "interactive_result_file_invalid",
      message: `Interactive step ${options.step.id} result file must be relative to the run directory.`,
    });
  }

  const runDir = resolve(options.runDir);
  const resultFile = resolve(runDir, resultFileDeclaration);
  const relativeToRun = relative(runDir, resultFile);
  if (
    relativeToRun === "" ||
    relativeToRun === ".." ||
    relativeToRun.startsWith(`..${sep}`) ||
    isAbsolute(relativeToRun)
  ) {
    throw new StepKitFailureError({
      code: "interactive_result_file_invalid",
      message: `Interactive step ${options.step.id} result file must stay under the run directory.`,
    });
  }

  return resultFile;
}

async function readJsonResultFile(
  stepId: string,
  resultFile: string | undefined,
): Promise<PlainObject> {
  if (!resultFile) {
    throw new StepKitFailureError({
      code: "interactive_result_file_invalid",
      message: `Interactive step ${stepId} must declare a result file path for file output.`,
    });
  }

  let raw: string;
  try {
    raw = await readFile(resultFile, "utf8");
  } catch (error) {
    throw new StepKitFailureError({
      code: "interactive_result_file_unreadable",
      message: `Interactive step ${stepId} result file could not be read.`,
      details:
        error instanceof Error ? { path: resultFile, cause: error.message } : { path: resultFile },
    });
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as PlainObject;
    }
  } catch (error) {
    throw new StepKitFailureError({
      code: "interactive_result_file_invalid_json",
      message: `Interactive step ${stepId} result file must contain valid JSON object output.`,
      details:
        error instanceof Error ? { path: resultFile, cause: error.message } : { path: resultFile },
    });
  }

  throw new StepKitFailureError({
    code: "interactive_result_file_invalid_json",
    message: `Interactive step ${stepId} result file must contain valid JSON object output.`,
    details: { path: resultFile },
  });
}

async function runInteractiveAgentTarget(options: {
  readonly config: StepKitConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly stepId: string;
  readonly renderedPrompt: string;
  readonly runDir: string;
  readonly runner?: InteractiveProcessRunner;
  readonly target: StepKitAgentTarget;
}): Promise<{ readonly exitCode: number; readonly output: PlainObject }> {
  const provider = providerRegistry[options.target.provider as keyof typeof providerRegistry];
  if (provider) {
    const result = await provider.runInteractive(
      {
        prompt: options.renderedPrompt,
        cwd: options.runDir,
        ...(options.target.model === undefined ? {} : { model: options.target.model }),
      },
      options.runner,
    );

    if (result.exitCode !== 0) {
      throw new StepKitFailureError({
        code: "interactive_session_failed",
        message: `Interactive agent step ${options.stepId} exited with code ${result.exitCode}.`,
        details: { exitCode: result.exitCode, target: options.target.provider },
      });
    }

    return { exitCode: result.exitCode, output: { exitCode: result.exitCode } };
  }

  const agentConfig = options.config.customAgents[options.target.provider];
  if (!agentConfig) {
    throw new StepKitFailureError({
      code: "agent_provider_unavailable",
      message: `Interactive agent target '${options.target.provider}' does not reference a configured custom agent.`,
      details: { provider: options.target.provider },
    });
  }

  const stepDir = join(options.runDir, "steps", options.stepId);
  const promptFile = join(stepDir, "prompt.txt");
  const args = await substitutePromptPlaceholders({
    argv: options.target.args ?? agentConfig.args ?? [],
    prompt: options.renderedPrompt,
    promptFile,
    model: options.target.model,
  });

  let result: InteractiveProcessResult;
  try {
    result = await (options.runner ?? spawnInteractiveProcess)({
      command: agentConfig.binary,
      args,
      cwd: options.runDir,
      shell: false,
      stdio: "inherit",
    });
  } catch (error) {
    throw new StepKitFailureError({
      code: "interactive_command_spawn_error",
      message: `Interactive agent step ${options.stepId} could not start target '${options.target.provider}'.`,
      details: {
        target: options.target.provider,
        ...(options.target.model === undefined ? {} : { model: options.target.model }),
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }

  if (result.exitCode !== 0) {
    throw new StepKitFailureError({
      code: "interactive_session_failed",
      message: `Interactive agent step ${options.stepId} exited with code ${result.exitCode}.`,
      details: { exitCode: result.exitCode, target: options.target.provider },
    });
  }

  return { exitCode: result.exitCode, output: { exitCode: result.exitCode } };
}

async function substitutePromptPlaceholders(options: {
  readonly argv: readonly string[];
  readonly prompt: string;
  readonly promptFile: string;
  readonly model?: string;
}): Promise<string[]> {
  let needsPromptFile = false;
  const substituted = options.argv.map((arg) => {
    if (arg === "{{prompt}}") {
      return options.prompt;
    }

    if (arg === "{{promptFile}}") {
      needsPromptFile = true;
      return options.promptFile;
    }

    if (arg === "{{model}}") {
      return options.model ?? "";
    }

    if (arg.includes("{{prompt}}") || arg.includes("{{promptFile}}") || arg.includes("{{model}}")) {
      throw new StepKitFailureError({
        code: "interactive_command_invalid",
        message: "Interactive prompt placeholders must be whole argv values.",
      });
    }

    return arg;
  });

  if (needsPromptFile) {
    await mkdir(dirname(options.promptFile), { recursive: true });
    await writeFile(options.promptFile, options.prompt, "utf8");
  }

  return substituted;
}

const spawnInteractiveProcess: InteractiveProcessRunner = async ({ command, args, cwd }) => {
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
