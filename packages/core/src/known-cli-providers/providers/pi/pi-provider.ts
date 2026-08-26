import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
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
const PI_STDOUT_FALLBACK_TAIL_CHARS = 128_000;

const PI_SPEC: ProviderSpec = {
  id: "pi",
  displayName: "Pi",
  model: {
    supported: true,
    flag: "--model",
    discovery: {
      command: PI_BINARY,
      args: ["--list-models"],
      outputParser: "pi-list-models-table",
    },
  },
  thinking: {
    supported: true,
    flag: "--thinking",
    levels: ["low", "medium", "high", "xhigh", "max"],
  },
  working: {
    command: PI_BINARY,
    prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
    baseArgs: ["-p", "@{{promptFile}}", "--mode", "json"],
    output: {
      style: "stdout-jsonl-transcript",
      parsing: { resultField: PI_RESULT_FIELD },
    },
  },
  interactive: {
    supported: true,
    command: PI_BINARY,
    systemPromptFileFlag: "--append-system-prompt",
    modelFlag: "--model",
    managedSessionPrompt: { delivery: "hidden-system-prompt-file" },
  },
};

async function runWorking(
  request: ProviderWorkingRequest,
  runner: ProviderWorkingRunner = spawnPiCapturingStdout,
): Promise<void> {
  const args = buildPiWorkingArgs(request);

  let result: ProviderWorkingProcessResult;
  try {
    result = await runner({ command: PI_BINARY, args, cwd: request.cwd, signal: request.signal });
  } catch (error) {
    throw new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: "pi provider process could not be started.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  // Pi can return exit code 1 after a tool-using coding turn even when it
  // still prints a valid final answer in the JSON transcript. Treat a usable
  // final envelope as authoritative; if extraction fails, preserve the
  // non-zero process failure.
  if (request.captureMode === "raw-text") {
    let text: string;
    try {
      text = extractEnvelopeText(result.stdout, { resultField: PI_RESULT_FIELD });
    } catch (error) {
      throwPiOutputFailure({ exitCode: result.exitCode, error, json: false });
    }

    await writeFile(request.outputFile, text, "utf8");
    return;
  }

  let output: PlainObject;
  try {
    output = extractEnvelopeOutput(result.stdout, { resultField: PI_RESULT_FIELD });
  } catch (error) {
    throwPiOutputFailure({ exitCode: result.exitCode, error, json: true });
  }

  await writeFile(request.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

/**
 * Builds `-p --model <pattern> --thinking <level> @<promptFile> --mode json`.
 * Pi has no dangerous/approval-bypass flag to pass — the CLI does not gate
 * non-interactive `-p` runs on approval the way Claude and Codex do.
 *
 * Pi's `--thinking` vocabulary (`off|minimal|low|medium|high|xhigh|max`,
 * per `pi --help`) is a strict superset of TrailStep's `WorkflowAgentThinking`
 * (`low|medium|high|xhigh|max`), so every TrailStep thinking value passes
 * straight through with no mapping or validation needed (unlike Codex, which
 * has no `"max"` tier and must reject it).
 */
function throwPiOutputFailure(options: {
  readonly exitCode: number;
  readonly error: unknown;
  readonly json: boolean;
}): never {
  if (options.exitCode !== 0) {
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `pi provider process exited with code ${options.exitCode}.`,
      details: { exitCode: options.exitCode },
    });
  }

  throw new TrailStepFailureError({
    code: "agent_provider_output_invalid",
    message: options.json
      ? "pi provider stdout did not contain a usable JSON result."
      : "pi provider stdout did not contain a usable result.",
    details: {
      cause: options.error instanceof Error ? options.error.message : String(options.error),
    },
  });
}

function buildPiWorkingArgs(request: ProviderWorkingRequest): string[] {
  const args = ["-p"];

  if (request.model) {
    args.push("--model", request.model);
  }

  if (request.thinking) {
    args.push("--thinking", request.thinking);
  }

  args.push(promptFileReference(request.promptFile));
  args.push("--mode", "json");
  return args;
}

/**
 * `request.permissionMode` is deliberately unread here — no confirmed Pi CLI
 * flag exists for approval behavior yet. When available, `systemPromptFile` is
 * passed through Pi's append-system-prompt flag so TrailStep's managed prompt is
 * hidden from the visible chat transcript.
 */
async function runInteractive(
  request: ProviderInteractiveRequest,
  runner: InteractiveProcessRunner = spawnPiInteractive,
): Promise<InteractiveProcessResult> {
  const args: string[] = [];

  if (request.model) {
    args.push("--model", request.model);
  }

  if (request.thinking) {
    args.push("--thinking", request.thinking);
  }

  if (request.systemPromptFile) {
    args.push("--append-system-prompt", request.systemPromptFile);
  } else {
    args.push(request.prompt);
  }

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

const spawnPiCapturingStdout: ProviderWorkingRunner = async ({ command, args, cwd, signal }) => {
  const executable = await resolveCliCommandForSpawn({ command, args });

  return await new Promise((resolve, reject) => {
    const child = spawn(executable.command, executable.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
      detached: process.platform !== "win32",
    });

    const stdout = createPiJsonStreamStdoutCollector();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });

    signal?.addEventListener("abort", () => terminateChildProcessTree(child), { once: true });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: stdout.finish() }));
  });
};

interface PiJsonStreamStdoutCollector {
  append(chunk: Buffer): void;
  finish(): string;
}

/**
 * Pi's JSON mode emits a newline-delimited transcript, including frequent
 * message update events. Some updates carry cumulative assistant text, so
 * retaining the whole transcript can grow quadratically with long answers and
 * eventually exceed V8's maximum string length. Keep only the latest usable
 * result-candidate line plus a small bounded tail for invalid-output diagnostics.
 */
export function createPiJsonStreamStdoutCollector(): PiJsonStreamStdoutCollector {
  const decoder = new StringDecoder("utf8");
  let pendingLine = "";
  let latestResultLine: string | undefined;
  let fallbackTail = "";

  function appendText(text: string): void {
    fallbackTail = trimFallbackTail(`${fallbackTail}${text}`);
    pendingLine += text;

    while (true) {
      const newlineIndex = pendingLine.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = pendingLine.slice(0, newlineIndex).replace(/\r$/u, "");
      rememberLine(line);
      pendingLine = pendingLine.slice(newlineIndex + 1);
    }
  }

  return {
    append(chunk) {
      appendText(decoder.write(chunk));
    },
    finish() {
      appendText(decoder.end());
      rememberLine(pendingLine);
      pendingLine = "";
      return latestResultLine ?? fallbackTail;
    },
  };

  function rememberLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed && isPiResultCandidateLine(trimmed)) {
      latestResultLine = trimmed;
    }
  }
}

function trimFallbackTail(value: string): string {
  if (value.length <= PI_STDOUT_FALLBACK_TAIL_CHARS) {
    return value;
  }

  return value.slice(-PI_STDOUT_FALLBACK_TAIL_CHARS);
}

function isPiResultCandidateLine(line: string): boolean {
  return line.includes(`"${PI_RESULT_FIELD}"`);
}

const spawnPiInteractive: InteractiveProcessRunner = async ({
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

export const piProvider: ProviderAdapter = {
  id: "pi",
  spec: PI_SPEC,
  runWorking,
  runInteractive,
};
