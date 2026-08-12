import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveAgentTargets } from "../../agent-targeting/resolve-agent-targets/resolve-agent-targets.js";
import type {
  TrailStepAgentTarget,
  TrailStepConfig,
} from "../../agent-targeting/targeting.types.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import type { PlainObject, Schema } from "../../contracts/shapes/shape.types.js";
import { providerRegistry } from "../../known-cli-providers/registry/provider-registry.js";
import type { StepArtifactPaths } from "../../runtime/artifacts/step-artifacts.js";
import {
  isInteractiveCompleted,
  readCompletedInteractiveOutput,
  waitForInteractiveCompletion,
} from "../../runtime/interactive-session/interactive-session-protocol.js";
import type {
  InteractiveProcessResult,
  InteractiveProcessRunner,
} from "../../runtime/run-workflow/run-workflow.types.js";
import { renderCustomProviderArgs } from "../custom-provider/render-custom-provider-args.js";

export async function runInteractiveAgentCommand(options: {
  readonly config: TrailStepConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly stepId: string;
  readonly renderedPrompt: string;
  readonly runDir: string;
  readonly outputSchema: Schema;
  readonly artifactPaths: StepArtifactPaths;
  readonly outputMode: "session-file" | "json";
  readonly runner?: InteractiveProcessRunner;
  readonly signal?: AbortSignal;
}): Promise<{ readonly exitCode: number; readonly output: PlainObject }> {
  const [target] = resolveAgentTargets({
    config: options.config,
    workflowId: options.workflowId,
    roleName: options.roleName,
    roleSize: options.role.size,
  });

  if (!target) {
    throw new TrailStepFailureError({
      code: "agent_targets_unavailable",
      message: `No interactive agent targets found for role ${options.roleName} with size ${options.role.size} in workflow ${options.workflowId}.`,
    });
  }

  return await runInteractiveAgentTarget({ ...options, target });
}

async function runInteractiveAgentTarget(options: {
  readonly config: TrailStepConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly stepId: string;
  readonly renderedPrompt: string;
  readonly runDir: string;
  readonly outputSchema: Schema;
  readonly artifactPaths: StepArtifactPaths;
  readonly outputMode: "session-file" | "json";
  readonly runner?: InteractiveProcessRunner;
  readonly target: TrailStepAgentTarget;
  readonly signal?: AbortSignal;
}): Promise<{ readonly exitCode: number; readonly output: PlainObject }> {
  const files = options.artifactPaths;
  await prepareInteractiveArtifacts({
    files,
    runDir: options.runDir,
    stepId: options.stepId,
    outputSchema: options.outputSchema,
    outputMode: options.outputMode,
  });
  const prompt = buildInteractivePrompt({
    renderedPrompt: options.renderedPrompt,
    files,
    outputSchema: options.outputSchema,
    outputMode: options.outputMode,
  });
  const env = { ...definedProcessEnv(), TRAILSTEP_INTERACTIVE_FILE: files.interactiveFile };

  const abortController = new AbortController();
  options.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const provider = providerRegistry[options.target.provider as keyof typeof providerRegistry];
  if (provider) {
    return await runProcessUntilExitOrCompletion({
      stepId: options.stepId,
      target: options.target.provider,
      interactiveFile: files.interactiveFile,
      abortController,
      readOutput: async () => await readCompletedOutput(options),
      runProcess: async () => {
        await writeFile(files.promptFile, prompt, "utf8");
        return await provider.runInteractive(
          {
            prompt,
            systemPromptFile: files.promptFile,
            cwd: files.stepDir,
            env,
            signal: abortController.signal,
            ...(options.target.model === undefined ? {} : { model: options.target.model }),
            ...(options.target.permissionMode === undefined
              ? {}
              : { permissionMode: options.target.permissionMode }),
          },
          options.runner,
        );
      },
    });
  }

  const agentConfig = options.config.customProviders[options.target.provider];
  if (!agentConfig) {
    throw new TrailStepFailureError({
      code: "agent_provider_unavailable",
      message: `Interactive agent target '${options.target.provider}' does not reference a configured custom agent.`,
      details: { provider: options.target.provider },
    });
  }

  if (!agentConfig.interactiveArgs) {
    throw new TrailStepFailureError({
      code: "agent_provider_interactive_unsupported",
      message: `Custom provider '${options.target.provider}' cannot run interactive agent steps because customProviders.${options.target.provider}.interactiveArgs is not declared.`,
      details: { provider: options.target.provider },
    });
  }

  const thinking = options.target.thinking ?? options.role.thinking;
  const args = renderCustomProviderArgs({
    argv: options.target.args ?? agentConfig.interactiveArgs,
    values: {
      prompt,
      promptFile: files.promptFile,
      ...(options.target.model === undefined ? {} : { model: options.target.model }),
      ...(thinking === undefined ? {} : { thinking }),
    },
    errorCode: "interactive_command_invalid",
    commandDescription: "Interactive agent command",
  });

  if (args.includes(files.promptFile)) {
    await mkdir(dirname(files.promptFile), { recursive: true });
    await writeFile(files.promptFile, prompt, "utf8");
  }

  return await runProcessUntilExitOrCompletion({
    stepId: options.stepId,
    target: options.target.provider,
    interactiveFile: files.interactiveFile,
    abortController,
    readOutput: async () => await readCompletedOutput(options),
    mapSpawnError: (error) =>
      new TrailStepFailureError({
        code: "interactive_command_spawn_error",
        message: `Interactive agent step ${options.stepId} could not start target '${options.target.provider}'.`,
        details: {
          target: options.target.provider,
          ...(options.target.model === undefined ? {} : { model: options.target.model }),
          cause: error instanceof Error ? error.message : String(error),
        },
      }),
    runProcess: async () =>
      await (options.runner ?? spawnInteractiveProcess)({
        command: agentConfig.binary,
        args,
        cwd: files.stepDir,
        shell: false,
        stdio: "inherit",
        env,
        signal: abortController.signal,
      }),
  });
}

function definedProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function runProcessUntilExitOrCompletion(options: {
  readonly stepId: string;
  readonly target: string;
  readonly interactiveFile: string;
  readonly abortController: AbortController;
  readonly runProcess: () => Promise<InteractiveProcessResult>;
  readonly readOutput: () => Promise<PlainObject>;
  readonly mapSpawnError?: (error: unknown) => TrailStepFailureError;
}): Promise<{ readonly exitCode: number; readonly output: PlainObject }> {
  const processPromise = options.runProcess();
  void processPromise.catch(() => undefined);
  const watcherAbortController = new AbortController();

  const winner = await Promise.race<
    | { readonly type: "completed" }
    | { readonly type: "process"; readonly result: InteractiveProcessResult }
    | { readonly type: "processError"; readonly error: unknown }
  >([
    processPromise.then(
      (result) => ({ type: "process", result }) as const,
      (error) => ({ type: "processError", error }) as const,
    ),
    waitForInteractiveCompletion(options.interactiveFile, watcherAbortController.signal).then(
      () => ({ type: "completed" }) as const,
    ),
  ]);

  watcherAbortController.abort();

  if (winner.type === "processError") {
    throw options.mapSpawnError?.(winner.error) ?? winner.error;
  }

  if (winner.type === "process") {
    if (await isInteractiveCompleted(options.interactiveFile)) {
      return { exitCode: 0, output: await options.readOutput() };
    }

    if (winner.result.exitCode !== 0) {
      throw new TrailStepFailureError({
        code: "interactive_session_failed",
        message: `Interactive agent step ${options.stepId} exited with code ${winner.result.exitCode}.`,
        details: { exitCode: winner.result.exitCode, target: options.target },
      });
    }

    return { exitCode: winner.result.exitCode, output: await options.readOutput() };
  }

  options.abortController.abort();
  return { exitCode: 0, output: await options.readOutput() };
}

async function prepareInteractiveArtifacts(options: {
  readonly files: StepArtifactPaths;
  readonly runDir: string;
  readonly stepId: string;
  readonly outputSchema: Schema;
  readonly outputMode: "session-file" | "json";
}): Promise<void> {
  await mkdir(options.files.stepDir, { recursive: true });
  await writeFile(
    options.files.interactiveFile,
    `${JSON.stringify(
      {
        status: "active",
        stepId: options.stepId,
        artifactStepId: options.files.artifactStepId,
        outputMode: options.outputMode,
        runDir: options.runDir,
        stepDir: options.files.stepDir,
        promptFile: options.files.promptFile,
        outputFile: options.files.outputFile,
        interactiveFile: options.files.interactiveFile,
        ...(options.outputMode === "session-file"
          ? {
              sessionDescriptionFile: options.files.sessionDescriptionFile,
              runRelativeSessionDescriptionFile: options.files.runRelativeSessionDescriptionFile,
            }
          : {}),
        runRelativeStepDir: options.files.runRelativeStepDir,
        outputSchema: options.outputSchema.jsonSchema,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function buildInteractivePrompt(options: {
  readonly renderedPrompt: string;
  readonly files: StepArtifactPaths;
  readonly outputSchema: Schema;
  readonly outputMode: "session-file" | "json";
}): string {
  const preamble =
    options.outputMode === "session-file"
      ? [
          "You are running inside a TrailStep interactive step.",
          "Write a dense session description to session-description.md in the current directory.",
          "preserve as much usable context as possible.",
          "describe the conversation rather than aggressively summarize it.",
          "include decisions, rejected options, tradeoffs, constraints, side comments, terminology, open questions, assumptions, file paths, commands, APIs, package names, examples, preferences, reasoning, and abandoned options.",
          "The goal is context preservation, not polish.",
          "Do not omit low-importance details merely because they seem minor.",
          "When complete, run: trailstep continue --session-file session-description.md",
        ]
      : [
          "You are running inside a TrailStep interactive step.",
          "Submit a JSON object matching this schema:",
          JSON.stringify(options.outputSchema.jsonSchema, null, 2),
          "When complete, run one of:",
          "  trailstep continue --json-file output.json",
          `  trailstep continue --json '${JSON.stringify(exampleJsonObject(options.outputSchema.jsonSchema))}'`,
          "If validation fails, update the JSON so it matches the schema and run trailstep continue again.",
        ];

  return [...preamble, "", "## Original prompt", options.renderedPrompt].join("\n");
}

async function readCompletedOutput(options: {
  readonly stepId: string;
  readonly artifactPaths: StepArtifactPaths;
  readonly outputSchema: Schema;
}): Promise<PlainObject> {
  return await readCompletedInteractiveOutput({
    stepId: options.stepId,
    interactiveFile: options.artifactPaths.interactiveFile,
    outputSchema: options.outputSchema,
  });
}

function exampleJsonObject(schema: Record<string, unknown>): Record<string, unknown> {
  const properties =
    typeof schema.properties === "object" &&
    schema.properties !== null &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};

  return Object.fromEntries(
    Object.entries(properties).map(([key, property]) => {
      const type =
        typeof property === "object" && property !== null && "type" in property
          ? (property as { readonly type?: unknown }).type
          : undefined;
      if (type === "boolean") {
        return [key, true];
      }
      if (type === "number") {
        return [key, 1];
      }
      return [key, "string"];
    }),
  );
}

const spawnInteractiveProcess: InteractiveProcessRunner = async ({
  command,
  args,
  cwd,
  env,
  signal,
}) => {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      signal,
      detached: process.platform !== "win32",
      shell: false,
      stdio: "inherit",
    });

    signal?.addEventListener("abort", () => terminateChildProcessTree(child), { once: true });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
  });
};

function terminateChildProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on(
      "error",
      () => {
        child.kill();
      },
    );
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}
