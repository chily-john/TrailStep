import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { StepKitFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type {
  InteractiveProcessResult,
  InteractiveProcessRunner,
} from "../../../runtime/run-workflow/run-workflow.types.js";
import { extractEnvelopeOutput } from "../../envelopes/envelope.js";
import type {
  ProviderAdapter,
  ProviderInteractiveRequest,
  ProviderWorkingProcessResult,
  ProviderWorkingRequest,
  ProviderWorkingRunner,
} from "../../registry/provider-registry.types.js";

const PI_BINARY = "pi";

/**
 * Empirically confirmed via `pi -p "..." --mode json` (see
 * `mock-local-test/README.md` for the raw probe transcript): unlike Claude's
 * `--output-format json`, `pi --mode json` does not print a single envelope
 * object. It prints one JSON object per line for the whole session transcript
 * (`session`, `agent_start`, `message_start`, `message_update`, `message_end`,
 * `turn_end`, `agent_end`, `agent_settled`, ...). The field that carries the
 * final answer is `"message"` — present on the last transcript line whose
 * type actually has that field (`turn_end` in every probe run observed here,
 * since the trailing `agent_end`/`agent_settled` lines carry `"messages"`
 * (plural) or no message field at all, and so are skipped by
 * `known-cli-providers/envelopes/envelope.ts`'s reverse-scan fallback).
 *
 * That `"message"` value is not itself the final text — it is a message
 * object shaped like `{role, content: [{type, text}, ...], ...}`, so the
 * actual answer lives in the `content` array's `type: "text"` block(s) (a
 * `"thinking"` block is often present first when `--thinking` is above
 * `"off"`). `known-cli-providers/envelopes/envelope.ts` was extended with a generic
 * content-block-array extraction branch to handle this shape, parameterized
 * the same way as Claude's flat `"result"` string field — proving the
 * envelope's field-name parameterization is not hardcoded to Claude's shape.
 */
const PI_RESULT_FIELD = "message";

async function runWorking(
  request: ProviderWorkingRequest,
  runner: ProviderWorkingRunner = spawnPiCapturingStdout,
): Promise<void> {
  const prompt = await readFile(request.promptFile, "utf8");
  const args = buildPiWorkingArgs(request, prompt);

  let result: ProviderWorkingProcessResult;
  try {
    result = await runner({ command: PI_BINARY, args, cwd: request.cwd });
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_provider_spawn_error",
      message: "pi provider process could not be started.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  if (result.exitCode !== 0) {
    throw new StepKitFailureError({
      code: "agent_provider_failed",
      message: `pi provider process exited with code ${result.exitCode}.`,
      details: { exitCode: result.exitCode },
    });
  }

  let output: PlainObject;
  try {
    output = extractEnvelopeOutput(result.stdout, { resultField: PI_RESULT_FIELD });
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_provider_output_invalid",
      message: "pi provider stdout did not contain a usable JSON result.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  await writeFile(request.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

/**
 * Builds `-p --model <pattern> --thinking <level> <prompt> --mode json`. Pi
 * has no dangerous/approval-bypass flag to pass — the CLI does not gate
 * non-interactive `-p` runs on approval the way Claude and Codex do.
 *
 * Pi's `--thinking` vocabulary (`off|minimal|low|medium|high|xhigh|max`,
 * per `pi --help`) is a strict superset of StepKit's `WorkflowAgentThinking`
 * (`low|medium|high|xhigh|max`), so every StepKit thinking value passes
 * straight through with no mapping or validation needed (unlike Codex, which
 * has no `"max"` tier and must reject it).
 */
function buildPiWorkingArgs(request: ProviderWorkingRequest, prompt: string): string[] {
  const args = ["-p"];

  if (request.model) {
    args.push("--model", request.model);
  }

  if (request.thinking) {
    args.push("--thinking", request.thinking);
  }

  args.push(prompt);
  args.push("--mode", "json");
  return args;
}

async function runInteractive(
  request: ProviderInteractiveRequest,
  runner: InteractiveProcessRunner = spawnPiInteractive,
): Promise<InteractiveProcessResult> {
  const args: string[] = [];

  if (request.model) {
    args.push("--model", request.model);
  }

  args.push(request.prompt);

  return await runner({
    command: PI_BINARY,
    args,
    cwd: request.cwd,
    shell: false,
    stdio: "inherit",
    env: request.env,
    signal: request.signal,
  });
}

const spawnPiCapturingStdout: ProviderWorkingRunner = async ({ command, args, cwd }) => {
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

const spawnPiInteractive: InteractiveProcessRunner = async ({
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

export const piProvider: ProviderAdapter = {
  id: "pi",
  runWorking,
  runInteractive,
};
