import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentTargets } from "../../../agent-targeting/resolve-agent-targets/resolve-agent-targets.js";
import type {
  StepKitAgentTarget,
  StepKitConfig,
} from "../../../agent-targeting/targeting.types.js";
import { document } from "../../../authoring/document/document.js";
import type { AgentStepRequestConfig } from "../../../authoring/step/agent-step.types.js";
import type { WorkflowAgentRole } from "../../../contracts/agents/agent-role.types.js";
import { StepKitFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { providerRegistry } from "../../../known-cli-providers/registry/provider-registry.js";
import type {
  ProviderAdapter,
  ProviderWorkingRunner,
} from "../../../known-cli-providers/registry/provider-registry.types.js";
import { resolveStepArtifactPaths } from "../../../runtime/artifacts/step-artifacts.js";
import type {
  WorkingAgentProcessResult,
  WorkingAgentProcessRunner,
} from "../../../runtime/run-workflow/run-workflow.types.js";

export interface WorkingAgentFiles {
  readonly stepDir: string;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly usageFile: string;
}

export function resolveStepAgentFiles(options: {
  readonly runDir: string;
  readonly stepId: string;
  readonly stepIndex: number;
}): WorkingAgentFiles {
  const artifactPaths = resolveStepArtifactPaths(options);
  return {
    stepDir: artifactPaths.stepDir,
    promptFile: join(artifactPaths.stepDir, "prompt.md"),
    outputFile: artifactPaths.outputFile,
    usageFile: artifactPaths.usageFile,
  };
}

export function buildWorkingAgentPrompt(options: {
  readonly prompt: string;
  readonly outputFile: string;
  readonly outputSchema: Record<string, unknown>;
  readonly captureMode?: "json" | "raw-text";
}): string {
  if (options.captureMode === "raw-text") {
    return [
      "# StepKit working-agent task",
      "",
      "Run the task described below and write the document content to the output file.",
      "Print the document content directly as your entire response — no JSON wrapper, no surrounding commentary, no markdown fences unless they are literally part of the document content itself.",
      "",
      `Output file: ${options.outputFile}`,
      "",
      "## Original prompt",
      "",
      options.prompt,
      "",
    ].join("\n");
  }

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
  readonly captureMode?: "json" | "raw-text";
}): string {
  if (options.captureMode === "raw-text") {
    return [
      "# StepKit working-agent task",
      "",
      "Print the document content directly as your entire response — no JSON wrapper, no surrounding commentary, no markdown fences unless they are literally part of the document content itself.",
      "Do not write output to a file.",
      "",
      "## Original prompt",
      "",
      options.prompt,
      "",
    ].join("\n");
  }

  return [
    "# StepKit working-agent task",
    "",
    "Respond with exactly one JSON object as your entire final answer, and nothing else.",
    "Do not write output to a file. Do not include prose, markdown fences, or multiple JSON values in your final answer - only the JSON object itself. This instruction applies to your literal final message, not just the work you do to get there.",
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
  readonly cwd: string;
  readonly runner?: WorkingAgentProcessRunner;
  readonly providerWorkingRunner?: ProviderWorkingRunner;
  readonly stepIndex: number;
  readonly files?: WorkingAgentFiles;
}): Promise<TOutput> {
  const targets = resolveAgentTargets({
    config: options.config,
    workflowId: options.workflowId,
    roleName: options.roleName,
    roleSize: options.role.size,
  });

  const files =
    options.files ??
    resolveStepAgentFiles({
      runDir: options.runDir,
      stepId: options.step.id,
      stepIndex: options.stepIndex,
    });
  await mkdir(files.stepDir, { recursive: true });
  await writeFile(
    files.promptFile,
    buildWorkingAgentPrompt({
      prompt: options.renderedPrompt,
      outputFile: files.outputFile,
      outputSchema: options.step.output.jsonSchema,
      captureMode: options.step.output.captureMode,
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
  readonly details?: unknown;
}

async function runWorkingAgentTargetAttempt<TOutput extends PlainObject>(options: {
  readonly config: StepKitConfig;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
  readonly renderedPrompt: string;
  readonly runDir: string;
  readonly cwd: string;
  readonly runner?: WorkingAgentProcessRunner;
  readonly providerWorkingRunner?: ProviderWorkingRunner;
  readonly stepIndex: number;
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
        captureMode: options.step.output.captureMode,
      }),
      "utf8",
    );

    const thinking = resolveWorkingThinking(options.target, options.role);
    try {
      await provider.runWorking(
        {
          promptFile: options.files.promptFile,
          outputFile: options.files.outputFile,
          usageFile: options.files.usageFile,
          cwd: options.cwd,
          ...(options.target.model === undefined ? {} : { model: options.target.model }),
          ...(thinking === undefined ? {} : { thinking }),
          captureMode: options.step.output.captureMode,
        },
        options.providerWorkingRunner,
      );
    } catch (error) {
      const repaired = await attemptProviderOutputRepair({
        provider,
        error,
        model: options.target.model,
        thinking,
        outputSchema: options.step.output.jsonSchema,
        captureMode: options.step.output.captureMode,
        files: options.files,
        cwd: options.cwd,
        providerWorkingRunner: options.providerWorkingRunner,
      });

      if (!repaired) {
        throw error;
      }
    }

    return readWorkingAgentOutput({
      stepId: options.step.id,
      outputFile: options.files.outputFile,
      step: options.step,
    });
  }

  const agentConfig = options.config.customProviders[options.target.provider];
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
      cwd: options.cwd,
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

/**
 * At most one repair attempt: a repair resumes the same CLI session, so a
 * second malformed answer in a row signals something deeper than a one-off
 * formatting slip, and repeatedly resuming risks drifting the session
 * further rather than fixing it. If the repair attempt also fails, this
 * falls through to the normal target-exhaustion path unchanged.
 */
const MAX_OUTPUT_REPAIR_ATTEMPTS = 1;

/**
 * Malformed JSON from a working-agent's final answer commonly follows a real
 * multi-turn agentic turn — file edits, test runs — that already happened
 * before the model's last message failed to parse. Retrying the whole task
 * (a fresh target, or even a fresh run of the same target) would risk
 * duplicating or conflicting with that already-completed work, so instead of
 * a blind retry, providers that can resume their own CLI session (currently
 * only `claude`, via `repairOutput`) get one bounded attempt to resume that
 * exact session and re-emit just the final answer, reformatted. Providers
 * without that capability (`error.failure.details` lacking a `sessionId`, or
 * no `repairOutput` on the adapter at all) fall straight through to today's
 * immediate-failure behavior.
 */
async function attemptProviderOutputRepair(options: {
  readonly provider: ProviderAdapter;
  readonly error: unknown;
  readonly model?: string;
  readonly thinking?: WorkflowAgentRole["thinking"];
  readonly outputSchema: Record<string, unknown>;
  readonly captureMode?: "json" | "raw-text";
  readonly files: WorkingAgentFiles;
  readonly cwd: string;
  readonly providerWorkingRunner?: ProviderWorkingRunner;
}): Promise<boolean> {
  if (!options.provider.repairOutput) {
    return false;
  }

  const repairable = extractRepairableFailure(options.error);
  if (!repairable || MAX_OUTPUT_REPAIR_ATTEMPTS < 1) {
    return false;
  }

  try {
    await options.provider.repairOutput(
      {
        sessionId: repairable.sessionId,
        rawResultText: repairable.rawResultText ?? "",
        outputFile: options.files.outputFile,
        usageFile: options.files.usageFile,
        cwd: options.cwd,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
        outputSchema: options.outputSchema,
        captureMode: options.captureMode,
      },
      options.providerWorkingRunner,
    );
    return true;
  } catch {
    return false;
  }
}

function extractRepairableFailure(
  error: unknown,
): { readonly sessionId: string; readonly rawResultText?: string } | undefined {
  if (!(error instanceof StepKitFailureError)) {
    return undefined;
  }

  if (error.failure.code !== "agent_provider_output_invalid") {
    return undefined;
  }

  const details = error.failure.details;
  if (typeof details !== "object" || details === null) {
    return undefined;
  }

  const sessionId = (details as Record<string, unknown>).sessionId;
  if (typeof sessionId !== "string") {
    return undefined;
  }

  const rawResultText = (details as Record<string, unknown>).rawResultText;
  return {
    sessionId,
    ...(typeof rawResultText === "string" ? { rawResultText } : {}),
  };
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
      ...(error.failure.details === undefined ? {} : { details: error.failure.details }),
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

  if (options.step.output.captureMode === "raw-text") {
    // Delegates to the shared `document(...)` capture path (the same one
    // code-authored steps use), so agent-captured and code-captured
    // documents share one persistence implementation. `document(...)`
    // resolves its target directory and index from the ambient step
    // context (`currentStep`), which is active for the whole duration of
    // this step's dispatch (see `withStepContext` in run-continuation.ts).
    const capturedDocument = await document(raw);

    return options.step.output.assert(capturedDocument, `step ${options.stepId} output`);
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
