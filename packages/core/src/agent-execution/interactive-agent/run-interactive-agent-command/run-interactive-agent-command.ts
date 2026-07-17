import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveAgentTargets } from "../../../agent-targeting/resolve-agent-targets/resolve-agent-targets.js";
import type {
  StepKitAgentTarget,
  StepKitConfig,
} from "../../../agent-targeting/targeting.types.js";
import type { WorkflowAgentRole } from "../../../contracts/agents/agent-role.types.js";
import { StepKitFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { providerRegistry } from "../../../known-cli-providers/registry/provider-registry.js";
import type {
  InteractiveProcessResult,
  InteractiveProcessRunner,
} from "../../../runtime/run-workflow/run-workflow.types.js";

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
