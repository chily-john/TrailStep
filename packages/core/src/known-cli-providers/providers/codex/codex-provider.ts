import { spawn } from "node:child_process";
import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import type {
  InteractiveProcessResult,
  InteractiveProcessRunner,
} from "../../../runtime/run-workflow/run-workflow.types.js";
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

const CODEX_BINARY = "codex";

/**
 * Reasoning levels the installed `codex` CLI's `model_reasoning_effort` config
 * key accepts (see `codex exec --help` / the model catalog in
 * `~/.codex/models_cache.json`, which lists exactly `low`/`medium`/`high`/`xhigh`
 * for every current model). Codex has no `"max"` tier — unlike Claude's
 * `WorkflowAgentThinking`, which does. There is no faithful mapping from
 * TrailStep's `"max"` to a Codex reasoning level, so an unsupported tier is a
 * hard configuration error rather than a silent clamp/guess.
 */
const CODEX_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const SUPPORTED_CODEX_THINKING = new Set<string>(CODEX_THINKING_LEVELS);

const CODEX_SPEC: ProviderSpec = {
  id: "codex",
  displayName: "Codex",
  model: { supported: true, flag: "-m" },
  thinking: {
    supported: true,
    flag: "-c model_reasoning_effort",
    levels: CODEX_THINKING_LEVELS,
  },
  working: {
    command: CODEX_BINARY,
    prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
    baseArgs: [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "-o",
      "{{outputFile}}",
      "@{{promptFile}}",
    ],
    output: { style: "provider-output-file" },
  },
  interactive: {
    supported: true,
    command: CODEX_BINARY,
    modelFlag: "--model",
    managedSessionPrompt: { delivery: "visible-prompt", mode: "visible-inline-prompt" },
  },
};

/**
 * Unlike `claudeProvider.runWorking`, this never captures or parses stdout
 * through `known-cli-providers/envelopes/envelope.ts`: `codex exec`'s `-o/--output-last-message
 * <file>` flag writes the agent's final message straight to `outputFile`
 * itself, so this reuses the same plain inherited-stdio process shape as the
 * `customProviders` fallback runner in `run-working-agent-command.ts` (stdio fully
 * inherited, only the exit code is observed).
 */
async function runWorking(
  request: ProviderWorkingRequest,
  runner: ProviderWorkingRunner = spawnCodexInheritingStdio,
): Promise<void> {
  const args = buildCodexWorkingArgs(request);

  let result: ProviderWorkingProcessResult;
  try {
    result = await runner({
      command: CODEX_BINARY,
      args,
      cwd: request.cwd,
      signal: request.signal,
    });
  } catch (error) {
    throw new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: "codex provider process could not be started.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }

  if (result.exitCode !== 0) {
    throw new TrailStepFailureError({
      code: "agent_provider_failed",
      message: `codex provider process exited with code ${result.exitCode}.`,
      details: { exitCode: result.exitCode },
    });
  }

  // No file write here: `codex exec -o <outputFile>` already wrote
  // `request.outputFile` itself as a side effect of the process above.
}

function buildCodexWorkingArgs(request: ProviderWorkingRequest): string[] {
  const args = ["exec", "--dangerously-bypass-approvals-and-sandbox"];

  if (request.model) {
    args.push("-m", request.model);
  }

  if (request.thinking) {
    if (!SUPPORTED_CODEX_THINKING.has(request.thinking)) {
      throw new TrailStepFailureError({
        code: "agent_provider_thinking_unsupported",
        message: `codex provider does not support thinking level '${request.thinking}'. Codex only supports low|medium|high|xhigh (no "max" tier).`,
        details: { thinking: request.thinking },
      });
    }

    args.push("-c", `model_reasoning_effort="${request.thinking}"`);
  }

  args.push("-o", request.outputFile);
  args.push(promptFileReference(request.promptFile));
  return args;
}

async function runInteractive(
  request: ProviderInteractiveRequest,
  runner: InteractiveProcessRunner = spawnCodexInteractive,
): Promise<InteractiveProcessResult> {
  const args: string[] = [];

  if (request.model) {
    args.push("--model", request.model);
  }

  if (request.thinking) {
    if (!SUPPORTED_CODEX_THINKING.has(request.thinking)) {
      throw new TrailStepFailureError({
        code: "agent_provider_thinking_unsupported",
        message: `codex provider does not support thinking level '${request.thinking}'. Codex only supports low|medium|high|xhigh (no "max" tier).`,
        details: { thinking: request.thinking },
      });
    }

    args.push("-c", `model_reasoning_effort="${request.thinking}"`);
  }

  args.push(
    request.systemPromptFile ? promptFileReference(request.systemPromptFile) : request.prompt,
  );

  return await runner({
    command: CODEX_BINARY,
    args,
    cwd: request.cwd,
    shell: false,
    stdio: "inherit",
    env: request.env,
    signal: request.signal,
  });
}

const spawnCodexInheritingStdio: ProviderWorkingRunner = async ({ command, args, cwd, signal }) => {
  const executable = await resolveCliCommandForSpawn({ command, args });

  return await new Promise((resolve, reject) => {
    const child = spawn(executable.command, executable.args, {
      cwd,
      shell: false,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });

    signal?.addEventListener("abort", () => terminateChildProcessTree(child), { once: true });
    child.on("error", reject);
    // `stdout` is unused: codex's `-o` flag writes `outputFile` directly, so
    // nothing here ever gets parsed as an envelope.
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: "" }));
  });
};

const spawnCodexInteractive: InteractiveProcessRunner = async ({
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

export const codexProvider: ProviderAdapter = {
  id: "codex",
  spec: CODEX_SPEC,
  runWorking,
  runInteractive,
};
