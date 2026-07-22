import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveAgentTargets } from "../../../agent-targeting/resolve-agent-targets/resolve-agent-targets.js";
import type {
  StepKitAgentTarget,
  StepKitConfig,
} from "../../../agent-targeting/targeting.types.js";
import type { WorkflowAgentRole } from "../../../contracts/agents/agent-role.types.js";
import { StepKitFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject, Schema } from "../../../contracts/shapes/shape.types.js";
import { providerRegistry } from "../../../known-cli-providers/registry/provider-registry.js";
import type { StepArtifactPaths } from "../../../runtime/artifacts/step-artifacts.js";
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
  readonly outputSchema: Schema;
  readonly artifactPaths: StepArtifactPaths;
  readonly outputMode: "session-file" | "json";
  readonly runner?: InteractiveProcessRunner;
}): Promise<{ readonly exitCode: number; readonly output: PlainObject }> {
  const [target] = resolveAgentTargets({
    config: options.config,
    workflowId: options.workflowId,
    roleName: options.roleName,
    roleSize: options.role.size,
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
  readonly outputSchema: Schema;
  readonly artifactPaths: StepArtifactPaths;
  readonly outputMode: "session-file" | "json";
  readonly runner?: InteractiveProcessRunner;
  readonly target: StepKitAgentTarget;
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
  const env = { ...definedProcessEnv(), STEPKIT_INTERACTIVE_FILE: files.interactiveFile };

  const abortController = new AbortController();

  const provider = providerRegistry[options.target.provider as keyof typeof providerRegistry];
  if (provider) {
    return await runProcessUntilExitOrCompletion({
      stepId: options.stepId,
      target: options.target.provider,
      interactiveFile: files.interactiveFile,
      abortController,
      readOutput: async () => await readCompletedOutput(options),
      runProcess: async () =>
        await provider.runInteractive(
          {
            prompt,
            cwd: options.runDir,
            env,
            signal: abortController.signal,
            ...(options.target.model === undefined ? {} : { model: options.target.model }),
          },
          options.runner,
        ),
    });
  }

  const agentConfig = options.config.customProviders[options.target.provider];
  if (!agentConfig) {
    throw new StepKitFailureError({
      code: "agent_provider_unavailable",
      message: `Interactive agent target '${options.target.provider}' does not reference a configured custom agent.`,
      details: { provider: options.target.provider },
    });
  }

  if (!agentConfig.interactiveArgs) {
    throw new StepKitFailureError({
      code: "agent_provider_interactive_unsupported",
      message: `Custom provider '${options.target.provider}' cannot run interactive agent steps because customProviders.${options.target.provider}.interactiveArgs is not declared.`,
      details: { provider: options.target.provider },
    });
  }

  const args = await substitutePromptPlaceholders({
    argv: options.target.args ?? agentConfig.interactiveArgs,
    prompt,
    promptFile: files.promptFile,
    model: options.target.model,
  });

  return await runProcessUntilExitOrCompletion({
    stepId: options.stepId,
    target: options.target.provider,
    interactiveFile: files.interactiveFile,
    abortController,
    readOutput: async () => await readCompletedOutput(options),
    mapSpawnError: (error) =>
      new StepKitFailureError({
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
        cwd: options.runDir,
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
  readonly mapSpawnError?: (error: unknown) => StepKitFailureError;
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
      throw new StepKitFailureError({
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

export async function waitForInteractiveCompletion(
  interactiveFile: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    if (await isInteractiveCompleted(interactiveFile)) {
      return;
    }

    await delay(100, undefined, { signal }).catch(() => undefined);
  }
}

export async function isInteractiveCompleted(interactiveFile: string): Promise<boolean> {
  try {
    const protocol = await readPlainJsonFile(interactiveFile, {
      readCode: "interactive_session_invalid",
      invalidCode: "interactive_session_invalid",
      message: "Interactive session protocol file is invalid.",
    });
    return protocol.status === "completed" || protocol.status === "cancelled";
  } catch {
    // The process-exit path reports authoritative protocol validation errors.
    // The watcher is intentionally best-effort and only needs to notice completion.
    return false;
  }
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
          "You are running inside a StepKit interactive step.",
          `Step directory: ${options.files.runRelativeStepDir}`,
          "Write a dense session description to session-description.md in the step directory.",
          "preserve as much usable context as possible.",
          "describe the conversation rather than aggressively summarize it.",
          "include decisions, rejected options, tradeoffs, constraints, side comments, terminology, open questions, assumptions, file paths, commands, APIs, package names, examples, preferences, reasoning, and abandoned options.",
          "The goal is context preservation, not polish.",
          "Do not omit low-importance details merely because they seem minor.",
          "When complete, run: stepkit continue --session-file session-description.md",
        ]
      : [
          "You are running inside a StepKit interactive step.",
          `Step directory: ${options.files.runRelativeStepDir}`,
          "Submit a JSON object matching this schema:",
          JSON.stringify(options.outputSchema.jsonSchema, null, 2),
          "When complete, run one of:",
          "  stepkit continue --json-file output.json",
          `  stepkit continue --json '${JSON.stringify(exampleJsonObject(options.outputSchema.jsonSchema))}'`,
          "If validation fails, update the JSON so it matches the schema and run stepkit continue again.",
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

export async function readCompletedInteractiveOutput(options: {
  readonly stepId: string;
  readonly interactiveFile: string;
  readonly outputSchema: Schema;
}): Promise<PlainObject> {
  const protocol = await readPlainJsonFile(options.interactiveFile, {
    readCode: "interactive_session_invalid",
    invalidCode: "interactive_session_invalid",
    message: `Interactive agent step ${options.stepId} has an invalid interactive.json file.`,
  });

  if (protocol.status === "cancelled") {
    throw new StepKitFailureError({
      code: "interactive_session_cancelled",
      message: `Interactive agent step ${options.stepId} was cancelled.`,
      details: {
        status: protocol.status,
        ...(typeof protocol.reason === "string" ? { reason: protocol.reason } : {}),
      },
    });
  }

  if (protocol.status !== "completed") {
    throw new StepKitFailureError({
      code: "interactive_session_incomplete",
      message: `Interactive agent step ${options.stepId} did not complete the file-based protocol.`,
      details: { status: protocol.status },
    });
  }

  const outputFile = requireProtocolString(protocol.outputFile, "outputFile", options.stepId);
  const output = await readPlainJsonFile(outputFile, {
    readCode: "interactive_output_missing",
    invalidCode: "interactive_output_invalid",
    message: `Interactive agent step ${options.stepId} completed without a valid output.json file.`,
  });

  const diagnostics = options.outputSchema.diagnostics(output);
  if (diagnostics.length > 0) {
    throw new StepKitFailureError({
      code: "interactive_output_invalid",
      message: `Interactive agent step ${options.stepId} output.json failed schema validation: ${formatDiagnostics(diagnostics)}`,
      details: { diagnostics },
    });
  }

  return output;
}

async function readPlainJsonFile(
  path: string,
  failure: {
    readonly readCode: string;
    readonly invalidCode: string;
    readonly message: string;
  },
): Promise<PlainObject> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new StepKitFailureError({
      code: failure.readCode,
      message: failure.message,
      details: { path, cause: error instanceof Error ? error.message : String(error) },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new StepKitFailureError({
      code: failure.invalidCode,
      message: failure.message,
      details: { path, cause: error instanceof Error ? error.message : String(error) },
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StepKitFailureError({
      code: failure.invalidCode,
      message: `${failure.message} Expected a plain JSON object.`,
      details: { path },
    });
  }

  return parsed as PlainObject;
}

function requireProtocolString(value: unknown, field: string, stepId: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new StepKitFailureError({
    code: "interactive_session_invalid",
    message: `Interactive agent step ${stepId} interactive.json is missing ${field}.`,
  });
}

function formatDiagnostics(
  diagnostics: readonly { readonly path: string; readonly message: string }[],
): string {
  return diagnostics.map((diagnostic) => `${diagnostic.path} ${diagnostic.message}`).join("; ");
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
