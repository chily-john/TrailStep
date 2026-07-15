import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import { StepKitFailureError } from "../../shared/failure.js";
import type { PlainObject } from "../../shared/shape.types.js";
import type { InteractiveProcessResult, InteractiveProcessRunner } from "../engine.types.js";
import { extractEnvelopeOutput } from "./envelope.js";
import type {
  ProviderAdapter,
  ProviderInteractiveRequest,
  ProviderWorkingProcessResult,
  ProviderWorkingRequest,
  ProviderWorkingRunner,
} from "./provider-adapter.types.js";

const GEMINI_BINARY = "gemini";

/**
 * Gemini's envelope field, per the Gemini CLI's documented `--output-format json`
 * shape (`{"response": "...", "stats": {...}}`) — the vendor CLI itself is NOT
 * installed in this environment, so unlike Claude/Codex/Pi this field name is
 * doc-sourced only, not empirically confirmed against a real invocation. Treat
 * this adapter as the least-verified of the four until a real
 * `gemini --version` + end-to-end smoke test is run (see
 * `mock-local-test/README.md` and `docs/architecture.md`).
 */
const GEMINI_RESULT_FIELD = "response";

async function runWorking(
  request: ProviderWorkingRequest,
  runner: ProviderWorkingRunner = spawnGeminiCapturingStdout,
): Promise<void> {
  const prompt = await readFile(request.promptFile, "utf8");
  const args = buildGeminiWorkingArgs(request, prompt);

  let result: ProviderWorkingProcessResult;
  try {
    result = await runner({ command: GEMINI_BINARY, args, cwd: request.cwd });
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_provider_spawn_error",
      message: "gemini provider process could not be started.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  if (result.exitCode !== 0) {
    throw new StepKitFailureError({
      code: "agent_provider_failed",
      message: `gemini provider process exited with code ${result.exitCode}.`,
      details: { exitCode: result.exitCode },
    });
  }

  let output: PlainObject;
  try {
    output = extractEnvelopeOutput(result.stdout, { resultField: GEMINI_RESULT_FIELD });
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_provider_output_invalid",
      message: "gemini provider stdout did not contain a usable JSON result.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  await writeFile(request.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

/**
 * Builds `-p <prompt> --yolo -m <model> --output-format json`, per the Gemini
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
function buildGeminiWorkingArgs(request: ProviderWorkingRequest, prompt: string): string[] {
  const args = ["-p", prompt, "--yolo"];

  if (request.model) {
    args.push("-m", request.model);
  }

  args.push("--output-format", "json");
  return args;
}

async function runInteractive(
  request: ProviderInteractiveRequest,
  runner: InteractiveProcessRunner = spawnGeminiInteractive,
): Promise<InteractiveProcessResult> {
  const args: string[] = [];

  if (request.model) {
    args.push("-m", request.model);
  }

  args.push(request.prompt);

  return await runner({
    command: GEMINI_BINARY,
    args,
    cwd: request.cwd,
    shell: false,
    stdio: "inherit",
  });
}

const spawnGeminiCapturingStdout: ProviderWorkingRunner = async ({ command, args, cwd }) => {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    });

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
};

const spawnGeminiInteractive: InteractiveProcessRunner = async ({ command, args, cwd }) => {
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

export const geminiProvider: ProviderAdapter = {
  id: "gemini",
  runWorking,
  runInteractive,
};
