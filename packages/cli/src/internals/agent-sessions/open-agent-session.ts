import type { InteractiveProcessRunner, TrailStepConfig } from "@trailstep/core";
import { launchInteractiveAgentTarget, TrailStepFailureError } from "@trailstep/core";
import {
  type AgentSessionRecord,
  createAgentSessionArtifacts,
  writeAgentSessionLaunchPrompt,
  writeAgentSessionRecord,
} from "./agent-session-artifacts.js";
import {
  AgentSessionTargetResolutionError,
  type ResolvedAgentSessionTarget,
  resolveAgentSessionTarget,
} from "./agent-session-target-resolution.js";
import { buildManagedSessionPrompt } from "./managed-session-prompt.js";

export interface OpenAgentSessionOptions {
  readonly cwd: string;
  readonly config: TrailStepConfig | undefined;
  readonly requestedName?: string;
  readonly runner?: InteractiveProcessRunner;
  readonly now?: () => Date;
  readonly randomSuffix?: () => string;
}

export type OpenAgentSessionResult =
  | {
      readonly ok: true;
      readonly exitCode: number;
      readonly sessionId: string;
      readonly sessionDir: string;
    }
  | {
      readonly ok: false;
      readonly exitCode: number;
      readonly message: string;
      readonly sessionId?: string;
      readonly sessionDir?: string;
    };

export async function openAgentSession(
  options: OpenAgentSessionOptions,
): Promise<OpenAgentSessionResult> {
  let resolved: ResolvedAgentSessionTarget;
  try {
    resolved = resolveAgentSessionTarget({
      config: options.config,
      requestedName: options.requestedName,
    });
  } catch (error) {
    if (error instanceof AgentSessionTargetResolutionError) {
      return { ok: false, exitCode: 1, message: error.message };
    }
    throw error;
  }

  const prompt = buildManagedSessionPrompt();
  let artifacts: Awaited<ReturnType<typeof createAgentSessionArtifacts>>;
  let record: AgentSessionRecord;
  try {
    artifacts = await createAgentSessionArtifacts({
      cwd: options.cwd,
      now: options.now,
      randomSuffix: options.randomSuffix,
    });
    const createdAt = (options.now?.() ?? new Date()).toISOString();
    record = buildRecord({
      id: artifacts.id,
      createdAt,
      resolved,
      sessionJsonPath: artifacts.sessionJsonPath,
      launchPromptPath: artifacts.launchPromptPath,
      status: "launching",
    });

    await writeAgentSessionLaunchPrompt({ path: artifacts.launchPromptPath, prompt });
    await writeAgentSessionRecord(record);
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      message: `Failed to create TrailStep agent session artifacts before launch: ${errorMessage(error)}`,
    };
  }

  let exitCode: number;
  let promptInjectionMode: AgentSessionRecord["launch"]["promptInjectionMode"];
  try {
    const result = await launchInteractiveAgentTarget({
      config: options.config ?? { version: 1, customProviders: {}, agents: {} },
      target: resolved.target,
      prompt,
      promptFile: artifacts.launchPromptPath,
      cwd: options.cwd,
      runner: options.runner,
    });
    exitCode = result.exitCode;
    promptInjectionMode = result.promptInjectionMode;
  } catch (error) {
    const failedRecord: AgentSessionRecord = {
      ...record,
      status: "failed",
      failedAt: (options.now?.() ?? new Date()).toISOString(),
      failure: {
        message: errorMessage(error),
        ...(error instanceof TrailStepFailureError ? { code: error.failure.code } : {}),
      },
    };
    const metadataError = await writeAgentSessionRecordBestEffort(failedRecord);
    const baseMessage =
      error instanceof TrailStepFailureError
        ? error.message
        : `Failed to open TrailStep agent session: ${errorMessage(error)}`;
    return {
      ok: false,
      exitCode: 1,
      message: appendMetadataError(baseMessage, metadataError),
      sessionId: artifacts.id,
      sessionDir: artifacts.dir,
    };
  }

  const completedAt = (options.now?.() ?? new Date()).toISOString();
  const finalRecord: AgentSessionRecord = {
    ...record,
    launch: { ...record.launch, promptInjectionMode },
    status: exitCode === 0 ? "completed" : "failed",
    exitCode,
    ...(exitCode === 0
      ? { completedAt }
      : {
          failedAt: completedAt,
          failure: { message: `Provider exited with code ${exitCode}.` },
        }),
  };
  const metadataError = await writeAgentSessionRecordBestEffort(finalRecord);

  if (exitCode !== 0) {
    return {
      ok: false,
      exitCode,
      message: appendMetadataError(
        `TrailStep agent session ${artifacts.id} exited with code ${exitCode}.`,
        metadataError,
      ),
      sessionId: artifacts.id,
      sessionDir: artifacts.dir,
    };
  }

  return {
    ok: true,
    exitCode,
    sessionId: artifacts.id,
    sessionDir: artifacts.dir,
  };
}

export const openDefaultAgentSession = openAgentSession;

function buildRecord(options: {
  readonly id: string;
  readonly createdAt: string;
  readonly resolved: ResolvedAgentSessionTarget;
  readonly sessionJsonPath: string;
  readonly launchPromptPath: string;
  readonly status: AgentSessionRecord["status"];
  readonly promptInjectionMode?: AgentSessionRecord["launch"]["promptInjectionMode"];
}): AgentSessionRecord {
  return {
    id: options.id,
    createdAt: options.createdAt,
    requestedName: options.resolved.requestedName ?? null,
    resolvedTarget: options.resolved.target,
    provider: options.resolved.providerName,
    launch: {
      backend:
        options.resolved.resolutionKind === "custom-provider"
          ? "custom-provider"
          : "built-in-provider",
      mode: "inherited-stdio",
      ...(options.promptInjectionMode === undefined
        ? {}
        : { promptInjectionMode: options.promptInjectionMode }),
    },
    paths: {
      sessionJson: options.sessionJsonPath,
      launchPrompt: options.launchPromptPath,
    },
    status: options.status,
  };
}

async function writeAgentSessionRecordBestEffort(
  record: AgentSessionRecord,
): Promise<string | undefined> {
  try {
    await writeAgentSessionRecord(record);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function appendMetadataError(message: string, metadataError: string | undefined): string {
  if (metadataError === undefined) {
    return message;
  }
  return `${message} TrailStep could not update session metadata: ${metadataError}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
