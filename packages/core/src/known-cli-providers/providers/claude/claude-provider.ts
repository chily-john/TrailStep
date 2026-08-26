import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type {
  InteractiveProcessResult,
  InteractiveProcessRunner,
} from "../../../runtime/run-workflow/run-workflow.types.js";
import {
  extractEnvelopeMetadata,
  extractEnvelopeOutput,
  extractEnvelopeText,
} from "../../envelopes/envelope.js";
import { resolveCliCommandForSpawn } from "../../process/resolve-cli-command.js";
import type {
  ProviderAdapter,
  ProviderInteractiveRequest,
  ProviderSpec,
  ProviderWorkingProcessResult,
  ProviderWorkingRepairRequest,
  ProviderWorkingRequest,
  ProviderWorkingRunner,
} from "../../registry/provider-registry.types.js";
import { promptFileReference } from "../prompt-file-reference.js";

const CLAUDE_BINARY = "claude";
const CLAUDE_RESULT_FIELD = "result";

const CLAUDE_SPEC: ProviderSpec = {
  id: "claude",
  displayName: "Claude",
  model: { supported: true, flag: "--model" },
  thinking: {
    supported: true,
    flag: "--effort",
    levels: ["low", "medium", "high", "xhigh", "max"],
  },
  working: {
    command: CLAUDE_BINARY,
    prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
    baseArgs: [
      "-p",
      "@{{promptFile}}",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ],
    output: {
      style: "stdout-json-envelope",
      parsing: { resultField: CLAUDE_RESULT_FIELD },
    },
    repair: { supported: true, resumeFlag: "--resume", promptDelivery: "stdin" },
  },
  interactive: {
    supported: true,
    command: CLAUDE_BINARY,
    requiresSystemPromptFile: true,
    systemPromptFileFlag: "--append-system-prompt-file",
    modelFlag: "--model",
    permissionBypassFlag: "--dangerously-skip-permissions",
    managedSessionPrompt: { delivery: "hidden-system-prompt-file" },
  },
};

async function runWorking(
  request: ProviderWorkingRequest,
  runner: ProviderWorkingRunner = spawnClaudeCapturingStdout,
): Promise<void> {
  const args = buildClaudeWorkingArgs(request);

  let result: ProviderWorkingProcessResult;
  const startedAt = performance.now();
  try {
    result = await runner({
      command: CLAUDE_BINARY,
      args,
      cwd: request.cwd,
      signal: request.signal,
    });
  } catch (error) {
    throw new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: "claude provider process could not be started.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  const harnessDurationMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (result.exitCode !== 0) {
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `claude provider process exited with code ${result.exitCode}.`,
      details: { exitCode: result.exitCode },
    });
  }

  await writeCapturedOutput({
    stdout: result.stdout,
    outputFile: request.outputFile,
    usageFile: request.usageFile,
    captureMode: request.captureMode,
    harnessDurationMs,
    context: "working",
  });
}

/**
 * A malformed final answer after a real agentic turn still has a resumable
 * session behind it — the model did whatever file edits/tests it did before
 * producing an unusable answer, and that work already happened. Re-running
 * the whole task on a fresh session would risk redoing or conflicting with
 * those side effects, so this asks the *same* session for a reformat-only
 * reply instead. `sessionId`/`rawResultText` are surfaced here (rather than
 * only on the success path) specifically so the caller can attempt that
 * repair; see `attemptProviderOutputRepair` in run-working-agent-command.ts.
 */
function extractFailureContext(rawStdout: string): {
  readonly sessionId?: string;
  readonly rawResultText?: string;
} {
  const metadata = extractEnvelopeMetadata(rawStdout, { harnessDurationMs: 0 });
  let rawResultText: string | undefined;
  try {
    rawResultText = extractEnvelopeText(rawStdout, { resultField: CLAUDE_RESULT_FIELD });
  } catch {
    rawResultText = undefined;
  }

  return {
    ...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }),
    ...(rawResultText === undefined ? {} : { rawResultText }),
  };
}

async function writeCapturedOutput(options: {
  readonly stdout: string;
  readonly outputFile: string;
  readonly usageFile?: string;
  readonly captureMode?: "json" | "raw-text";
  readonly harnessDurationMs: number;
  readonly context: "working" | "repair";
}): Promise<void> {
  const label = options.context === "repair" ? "repair " : "";

  if (options.captureMode === "raw-text") {
    let text: string;
    try {
      text = extractEnvelopeText(options.stdout, { resultField: CLAUDE_RESULT_FIELD });
    } catch (error) {
      throw new TrailStepFailureError({
        code: "agent_provider_output_invalid",
        message: `claude provider ${label}stdout did not contain a usable result.`,
        details: {
          cause: error instanceof Error ? error.message : String(error),
          ...extractFailureContext(options.stdout),
        },
      });
    }

    await writeFile(options.outputFile, text, "utf8");
  } else {
    let output: PlainObject;
    try {
      output = extractEnvelopeOutput(options.stdout, { resultField: CLAUDE_RESULT_FIELD });
    } catch (error) {
      throw new TrailStepFailureError({
        code: "agent_provider_output_invalid",
        message: `claude provider ${label}stdout did not contain a usable JSON result.`,
        details: {
          cause: error instanceof Error ? error.message : String(error),
          ...extractFailureContext(options.stdout),
        },
      });
    }

    await writeFile(options.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  if (options.usageFile) {
    const metadata = extractEnvelopeMetadata(options.stdout, {
      harnessDurationMs: options.harnessDurationMs,
    });
    await writeFile(options.usageFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }
}

async function repairOutput(
  request: ProviderWorkingRepairRequest,
  runner: ProviderWorkingRunner = spawnClaudeCapturingStdout,
): Promise<void> {
  const prompt = buildClaudeRepairPrompt(request);
  const args = buildClaudeRepairArgs(request);

  let result: ProviderWorkingProcessResult;
  const startedAt = performance.now();
  try {
    result = await runner({
      command: CLAUDE_BINARY,
      args,
      cwd: request.cwd,
      stdin: prompt,
      signal: request.signal,
    });
  } catch (error) {
    throw new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: "claude provider repair process could not be started.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  const harnessDurationMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (result.exitCode !== 0) {
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `claude provider repair process exited with code ${result.exitCode}.`,
      details: { exitCode: result.exitCode },
    });
  }

  await writeCapturedOutput({
    stdout: result.stdout,
    outputFile: request.outputFile,
    usageFile: request.usageFile,
    captureMode: request.captureMode,
    harnessDurationMs,
    context: "repair",
  });
}

// --resume reuses the failed turn's own session (full context, already-done
// work included) rather than starting a fresh one; the prompt built by
// buildClaudeRepairPrompt asks only for a reformatted final answer. The repair
// prompt is still piped through stdin so the resume invocation receives fresh
// reformat-only instructions without adding a second prompt file artifact.
function buildClaudeRepairArgs(request: ProviderWorkingRepairRequest): string[] {
  const args = [
    "--resume",
    request.sessionId,
    "-p",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
  ];

  if (request.model) {
    args.push("--model", request.model);
  }

  if (request.thinking) {
    args.push("--effort", request.thinking);
  }

  return args;
}

function buildClaudeRepairPrompt(request: ProviderWorkingRepairRequest): string {
  if (request.captureMode === "raw-text") {
    return [
      "# TrailStep output repair",
      "",
      "Your previous final answer in this session could not be used as-is.",
      "Do not redo the task or make any further changes - the work is already done.",
      "Reply with the document content only, as your entire final answer: no JSON wrapper, no surrounding commentary, no markdown fences unless they are literally part of the document content itself.",
      "",
      "## Your previous final answer",
      "",
      request.rawResultText,
      "",
    ].join("\n");
  }

  return [
    "# TrailStep output repair",
    "",
    "Your previous final answer in this session was not valid JSON matching the required schema.",
    "Do not redo the task, re-read files, or make any further changes - the work is already done.",
    "Reply with exactly one JSON object as your entire final answer: no prose, no markdown fences, no multiple JSON values.",
    "",
    "The JSON object must match this output schema:",
    "",
    "```json",
    JSON.stringify(request.outputSchema, null, 2),
    "```",
    "",
    "## Your previous final answer",
    "",
    request.rawResultText,
    "",
  ].join("\n");
}

// The rendered prompt content is deliberately NOT appended here: Windows'
// CreateProcess caps the whole argv command-line around 32,767 characters, so
// a large rendered prompt would fail process creation outright. The tiny @file
// reference lets the CLI load the full prompt from disk without expanding argv.
function buildClaudeWorkingArgs(request: ProviderWorkingRequest): string[] {
  const args = [
    "-p",
    promptFileReference(request.promptFile),
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
  ];

  if (request.model) {
    args.push("--model", request.model);
  }

  if (request.thinking) {
    args.push("--effort", request.thinking);
  }

  return args;
}

async function runInteractive(
  request: ProviderInteractiveRequest,
  runner: InteractiveProcessRunner = spawnClaudeInteractive,
): Promise<InteractiveProcessResult> {
  const args: string[] = [];

  if (request.model) {
    args.push("--model", request.model);
  }

  if (request.thinking) {
    args.push("--effort", request.thinking);
  }

  if (request.permissionMode !== "prompt") {
    args.push("--dangerously-skip-permissions");
  }

  if (!request.systemPromptFile) {
    throw new TrailStepFailureError({
      code: "agent_provider_invalid_request",
      message: "claude provider's interactive mode requires systemPromptFile.",
    });
  }

  args.push("--append-system-prompt-file", request.systemPromptFile);

  return await runner({
    command: CLAUDE_BINARY,
    args,
    cwd: request.cwd,
    shell: false,
    stdio: "inherit",
    env: request.env,
    signal: request.signal,
  });
}

const spawnClaudeCapturingStdout: ProviderWorkingRunner = async ({
  command,
  args,
  cwd,
  stdin,
  signal,
}) => {
  const executable = await resolveCliCommandForSpawn({ command, args });

  return await new Promise((resolve, reject) => {
    const hasStdin = stdin !== undefined;
    const child = spawn(executable.command, executable.args, {
      cwd,
      shell: false,
      stdio: [hasStdin ? "pipe" : "ignore", "pipe", "inherit"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stdin?.on("error", reject);
    signal?.addEventListener("abort", () => terminateChildProcessTree(child), { once: true });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));

    if (hasStdin) {
      child.stdin?.end(stdin);
    }
  });
};

const spawnClaudeInteractive: InteractiveProcessRunner = async ({
  command,
  args,
  cwd,
  env,
  signal,
}) => {
  const executable = await resolveCliCommandForSpawn({ command, args, env });

  return await new Promise((resolve, reject) => {
    const child = spawn(executable.command, executable.args, {
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

export const claudeProvider: ProviderAdapter = {
  id: "claude",
  spec: CLAUDE_SPEC,
  runWorking,
  repairOutput,
  runInteractive,
};
