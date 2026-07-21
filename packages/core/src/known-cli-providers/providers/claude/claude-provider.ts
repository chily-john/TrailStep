import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { StepKitFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type {
  InteractiveProcessResult,
  InteractiveProcessRunner,
} from "../../../runtime/run-workflow/run-workflow.types.js";
import { extractEnvelopeMetadata, extractEnvelopeOutput } from "../../envelopes/envelope.js";
import type {
  ProviderAdapter,
  ProviderInteractiveRequest,
  ProviderWorkingProcessResult,
  ProviderWorkingRequest,
  ProviderWorkingRunner,
} from "../../registry/provider-registry.types.js";

const CLAUDE_BINARY = "claude";

async function runWorking(
  request: ProviderWorkingRequest,
  runner: ProviderWorkingRunner = spawnClaudeCapturingStdout,
): Promise<void> {
  const prompt = await readFile(request.promptFile, "utf8");
  const args = buildClaudeWorkingArgs(request, prompt);

  let result: ProviderWorkingProcessResult;
  const startedAt = performance.now();
  try {
    result = await runner({ command: CLAUDE_BINARY, args, cwd: request.cwd });
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_provider_spawn_error",
      message: "claude provider process could not be started.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  const harnessDurationMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (result.exitCode !== 0) {
    throw new StepKitFailureError({
      code: "agent_provider_failed",
      message: `claude provider process exited with code ${result.exitCode}.`,
      details: { exitCode: result.exitCode },
    });
  }

  let output: PlainObject;
  try {
    output = extractEnvelopeOutput(result.stdout, { resultField: "result" });
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_provider_output_invalid",
      message: "claude provider stdout did not contain a usable JSON result.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  await writeFile(request.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  if (request.usageFile) {
    const metadata = extractEnvelopeMetadata(result.stdout, { harnessDurationMs });
    await writeFile(request.usageFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }
}

function buildClaudeWorkingArgs(request: ProviderWorkingRequest, prompt: string): string[] {
  const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];

  if (request.model) {
    args.push("--model", request.model);
  }

  if (request.thinking) {
    args.push("--effort", request.thinking);
  }

  args.push(prompt);
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

  args.push(request.prompt);

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

const spawnClaudeCapturingStdout: ProviderWorkingRunner = async ({ command, args, cwd }) => {
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

const spawnClaudeInteractive: InteractiveProcessRunner = async ({ command, args, cwd, env, signal }) => {
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
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {
      child.kill();
    });
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
  runWorking,
  runInteractive,
};
