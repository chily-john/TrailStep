import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  TrailStepAgentTarget,
  TrailStepConfig,
} from "../../agent-targeting/targeting.types.js";
import type { ManagedSessionPromptInjectionMode } from "../../cli-provider-runtime/catalog/provider-adapter.types.js";
import { resolveCliCommandForSpawn } from "../../cli-provider-runtime/process/resolve-cli-command.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import { errorMessage, isNodeError } from "../../json/guards.js";
import type {
  InteractiveProcessResult,
  InteractiveProcessRunner,
} from "../../runtime/run-workflow/run-workflow.types.js";
import { terminateChildProcessTree } from "../child-process/child-process-termination.js";
import { trackLiveChild } from "../child-process/live-children.js";
import { renderCustomProviderArgs } from "../custom-provider/render-custom-provider-args.js";

export interface LaunchInteractiveAgentTargetOptions {
  readonly config: TrailStepConfig;
  readonly target: TrailStepAgentTarget;
  readonly prompt: string;
  readonly promptFile: string;
  readonly cwd: string;
  readonly runner?: InteractiveProcessRunner;
  readonly signal?: AbortSignal;
}

export type LaunchInteractiveAgentTargetResult = InteractiveProcessResult & {
  readonly promptInjectionMode: ManagedSessionPromptInjectionMode;
};

export async function launchInteractiveAgentTarget(
  options: LaunchInteractiveAgentTargetOptions,
): Promise<LaunchInteractiveAgentTargetResult> {
  const manifestProvider = options.config.providers?.[options.target.provider];
  if (manifestProvider !== undefined && manifestProvider.source.type !== "legacy-custom-provider") {
    const interactive = manifestProvider.manifest.interactive;
    if (!interactive.supported || interactive.command === undefined) {
      throw new TrailStepFailureError({
        code: "agent_provider_interactive_unsupported",
        message: `Provider '${options.target.provider}' does not support interactive launch.`,
        details: { provider: options.target.provider },
      });
    }

    const command = interactive.command;
    const args = renderCustomProviderArgs({
      argv: options.target.args ?? ["{{prompt}}"],
      values: {
        prompt: options.prompt,
        promptFile: options.promptFile,
        ...(options.target.model === undefined ? {} : { model: options.target.model }),
        ...(options.target.thinking === undefined ? {} : { thinking: options.target.thinking }),
      },
      errorCode: "interactive_command_invalid",
      commandDescription: "Manifest interactive provider command",
    });
    const promptInjectionMode: ManagedSessionPromptInjectionMode = args.includes(options.promptFile)
      ? "visible-prompt-file"
      : "visible-inline-prompt";

    if (args.includes(options.promptFile)) {
      await mkdir(dirname(options.promptFile), { recursive: true });
      await writeFile(options.promptFile, options.prompt, "utf8");
    }

    let result: InteractiveProcessResult;
    try {
      result = await (options.runner ?? spawnInteractiveProcess)({
        command,
        args,
        cwd: options.cwd,
        shell: false,
        stdio: "inherit",
        env: definedProcessEnv(),
        signal: options.signal,
      });
    } catch (error) {
      throw mapInteractiveProviderLaunchError({
        error,
        provider: options.target.provider,
        command,
      });
    }

    return { ...result, promptInjectionMode };
  }

  const customProvider = options.config.customProviders[options.target.provider];
  if (!customProvider) {
    throw new TrailStepFailureError({
      code: "agent_provider_unavailable",
      message: `Interactive agent target '${options.target.provider}' does not reference a configured custom provider.`,
      details: { provider: options.target.provider },
    });
  }

  if (!customProvider.interactiveArgs) {
    throw new TrailStepFailureError({
      code: "agent_provider_interactive_unsupported",
      message: `Custom provider '${options.target.provider}' cannot run interactive sessions because customProviders.${options.target.provider}.interactiveArgs is not declared.`,
      details: { provider: options.target.provider },
    });
  }

  const args = renderCustomProviderArgs({
    argv: options.target.args ?? customProvider.interactiveArgs,
    values: {
      prompt: options.prompt,
      promptFile: options.promptFile,
      ...(options.target.model === undefined ? {} : { model: options.target.model }),
      ...(options.target.thinking === undefined ? {} : { thinking: options.target.thinking }),
    },
    errorCode: "interactive_command_invalid",
    commandDescription: "Interactive agent command",
  });
  const promptInjectionMode: ManagedSessionPromptInjectionMode = args.includes(options.promptFile)
    ? "visible-prompt-file"
    : "visible-inline-prompt";

  if (args.includes(options.promptFile)) {
    await mkdir(dirname(options.promptFile), { recursive: true });
    await writeFile(options.promptFile, options.prompt, "utf8");
  }

  const result = await (options.runner ?? spawnInteractiveProcess)({
    command: customProvider.binary,
    args,
    cwd: options.cwd,
    shell: false,
    stdio: "inherit",
    env: { ...definedProcessEnv(), ...customProvider.env },
    signal: options.signal,
  });

  return { ...result, promptInjectionMode };
}

function mapInteractiveProviderLaunchError(options: {
  readonly error: unknown;
  readonly provider: string;
  readonly command: string;
}): unknown {
  if (options.error instanceof TrailStepFailureError) {
    return options.error;
  }

  const message = errorMessage(options.error);
  if (isSpawnEnoentError(options.error, options.command, message)) {
    return new TrailStepFailureError({
      code: "agent_provider_spawn_error",
      message: `Provider '${options.provider}' could not be opened because the '${options.command}' CLI was not found on PATH. Install the CLI or configure a different TrailStep agent target.`,
      details: { provider: options.provider, command: options.command, cause: message },
    });
  }

  return options.error;
}

function isSpawnEnoentError(error: unknown, command: string, message: string): boolean {
  if (isNodeError(error) && error.code === "ENOENT") {
    return true;
  }

  return new RegExp(
    `(?:spawn|ENOENT).*${escapeRegExp(command)}|${escapeRegExp(command)}.*ENOENT`,
    "iu",
  ).test(message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function definedProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

const spawnInteractiveProcess: InteractiveProcessRunner = async ({
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

    const untrack = trackLiveChild(child);
    let termination: Promise<void> | undefined;
    const onAbort = (): void => {
      // Kick off termination once; the completion path awaits the same promise so the
      // caller never races a live child.
      termination ??= terminateChildProcessTree(child).catch(() => undefined);
    };
    if (signal?.aborted === true) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      untrack();
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      void (async () => {
        untrack();
        signal?.removeEventListener("abort", onAbort);
        // Resolve only once an abort-triggered termination has actually finished its child.
        if (termination !== undefined) {
          await termination;
        }
        resolve({ exitCode: code ?? 1 });
      })();
    });
  });
};
