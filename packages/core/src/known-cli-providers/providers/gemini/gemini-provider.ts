import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type {
  InteractiveProcessResult,
  InteractiveProcessRunner,
} from "../../../runtime/run-workflow/run-workflow.types.js";
import { extractEnvelopeOutput, extractEnvelopeText } from "../../envelopes/envelope.js";
import { resolveCliCommandForSpawn } from "../../process/resolve-cli-command.js";
import type {
  ProviderAdapter,
  ProviderInteractiveRequest,
  ProviderSpec,
  ProviderWorkingProcessResult,
  ProviderWorkingRequest,
  ProviderWorkingRunner,
} from "../../registry/provider-registry.types.js";
import { promptFileReference } from "../prompt-file-reference.js";

const GEMINI_BINARY = "gemini";

/**
 * Gemini's envelope field, per the Gemini CLI's documented `--output-format json`
 * shape (`{"response": "...", "stats": {...}}`) — the vendor CLI itself is NOT
 * installed in this environment, so unlike Claude/Codex/Pi this field name is
 * doc-sourced only, not empirically confirmed against a real invocation. Treat
 * this adapter as the least-verified of the four until a real
 * `gemini --version` + end-to-end smoke test is run.
 */
const GEMINI_RESULT_FIELD = "response";

const GEMINI_SPEC: ProviderSpec = {
  id: "gemini",
  displayName: "Gemini",
  model: { supported: true, flag: "-m" },
  thinking: { supported: false },
  working: {
    command: GEMINI_BINARY,
    prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
    baseArgs: ["-p", "@{{promptFile}}", "--yolo", "--output-format", "json"],
    output: {
      style: "stdout-json-envelope",
      parsing: { resultField: GEMINI_RESULT_FIELD },
    },
  },
  interactive: {
    supported: true,
    command: GEMINI_BINARY,
    modelFlag: "-m",
    managedSessionPrompt: { delivery: "visible-prompt", mode: "visible-inline-prompt" },
  },
};

async function runWorking(
  request: ProviderWorkingRequest,
  runner: ProviderWorkingRunner = spawnGeminiCapturingStdout,
): Promise<void> {
  const args = buildGeminiWorkingArgs(request);

  let result: ProviderWorkingProcessResult;
  try {
    result = await runner({
      command: GEMINI_BINARY,
      args,
      cwd: request.cwd,
      signal: request.signal,
    });
  } catch (error) {
    throw new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: "gemini provider process could not be started.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  if (result.exitCode !== 0) {
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `gemini provider process exited with code ${result.exitCode}.`,
      details: { exitCode: result.exitCode },
    });
  }

  if (request.captureMode === "raw-text") {
    let text: string;
    try {
      text = extractEnvelopeText(result.stdout, { resultField: GEMINI_RESULT_FIELD });
    } catch (error) {
      throw new TrailStepFailureError({
        code: "agent_provider_output_invalid",
        message: "gemini provider stdout did not contain a usable result.",
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }

    await writeFile(request.outputFile, text, "utf8");
  } else {
    let output: PlainObject;
    try {
      output = extractEnvelopeOutput(result.stdout, { resultField: GEMINI_RESULT_FIELD });
    } catch (error) {
      throw new TrailStepFailureError({
        code: "agent_provider_output_invalid",
        message: "gemini provider stdout did not contain a usable JSON result.",
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }

    await writeFile(request.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
}

/**
 * Builds `-p @<promptFile> --yolo -m <model> --output-format json`, per the Gemini
 * CLI's documented non-interactive flags (`-p/--prompt`, `-m/--model`,
 * `-o/--output-format`, and `-y/--yolo` to auto-accept actions the way
 * Claude's `--dangerously-skip-permissions` and Codex's
 * `--dangerously-bypass-approvals-and-sandbox` do). This has NOT been
 * confirmed against a real `gemini` binary in this environment — the exact
 * flag set is sourced from Gemini CLI documentation only.
 *
 * `request.thinking` is deliberately a documented no-op here: there is no
 * confirmed Gemini CLI flag for a thinking/reasoning-effort level (unlike
 * Claude's `--effort`, Codex's `-c model_reasoning_effort=...`, or Pi's
 * `--thinking`). Guessing a flag name risks the CLI rejecting the whole
 * invocation, so this adapter intentionally does not pass one — do not add a
 * guessed flag here without first confirming it against the real CLI.
 */
function buildGeminiWorkingArgs(request: ProviderWorkingRequest): string[] {
  const args = ["-p", promptFileReference(request.promptFile), "--yolo"];

  if (request.model) {
    args.push("-m", request.model);
  }

  args.push("--output-format", "json");
  return args;
}

/**
 * `request.permissionMode` is deliberately unread here — no confirmed Gemini
 * CLI flag exists for approval behavior yet. When available, `systemPromptFile`
 * is passed as an @file prompt reference to avoid argv-length limits.
 */
async function runInteractive(
  request: ProviderInteractiveRequest,
  runner: InteractiveProcessRunner = spawnGeminiInteractive,
): Promise<InteractiveProcessResult> {
  const args: string[] = [];

  if (request.model) {
    args.push("-m", request.model);
  }

  args.push(
    request.systemPromptFile ? promptFileReference(request.systemPromptFile) : request.prompt,
  );

  return await runner({
    command: GEMINI_BINARY,
    args,
    cwd: request.cwd,
    shell: false,
    stdio: "inherit",
    env: request.env,
    signal: request.signal,
  });
}

const spawnGeminiCapturingStdout: ProviderWorkingRunner = async ({
  command,
  args,
  cwd,
  signal,
}) => {
  const executable = await resolveCliCommandForSpawn({ command, args });

  return await new Promise((resolve, reject) => {
    const child = spawn(executable.command, executable.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    signal?.addEventListener("abort", () => terminateChildProcessTree(child), { once: true });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
};

const spawnGeminiInteractive: InteractiveProcessRunner = async ({
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

export const geminiProvider: ProviderAdapter = {
  id: "gemini",
  spec: GEMINI_SPEC,
  runWorking,
  runInteractive,
};
