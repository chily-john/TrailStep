import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ManagedSessionPromptInjectionMode, TrailStepAgentTarget } from "@trailstep/core";

export interface AgentSessionArtifacts {
  readonly id: string;
  readonly dir: string;
  readonly sessionJsonPath: string;
  readonly launchPromptPath: string;
}

export interface AgentSessionRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly requestedName: string | null;
  readonly resolvedTarget: TrailStepAgentTarget;
  readonly provider: string;
  readonly launch: {
    readonly backend: "built-in-provider" | "custom-provider";
    readonly mode: "inherited-stdio";
    readonly promptInjectionMode?: ManagedSessionPromptInjectionMode;
  };
  readonly paths: {
    readonly sessionJson: string;
    readonly launchPrompt: string;
  };
  readonly status: "launching" | "completed" | "failed";
  readonly exitCode?: number;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly failure?: {
    readonly message: string;
    readonly code?: string;
  };
}

export async function createAgentSessionArtifacts(options: {
  readonly cwd: string;
  readonly now?: () => Date;
  readonly randomSuffix?: () => string;
}): Promise<AgentSessionArtifacts> {
  const createdAt = options.now?.() ?? new Date();
  const timestamp = formatSessionTimestamp(createdAt);
  const sessionsRoot = join(options.cwd, ".trailstep", "sessions");
  await mkdir(sessionsRoot, { recursive: true });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = options.randomSuffix?.() ?? Math.random().toString(16).slice(2, 8);
    const id = `session-${timestamp}-${suffix}`;
    const dir = join(sessionsRoot, id);

    try {
      await mkdir(dir, { recursive: false });
      return {
        id,
        dir,
        sessionJsonPath: join(dir, "session.json"),
        launchPromptPath: join(dir, "launch-prompt.md"),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    "Unable to allocate a unique TrailStep agent session directory after 10 attempts.",
  );
}

export async function writeAgentSessionRecord(record: AgentSessionRecord): Promise<void> {
  await writeFile(record.paths.sessionJson, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function writeAgentSessionLaunchPrompt(options: {
  readonly path: string;
  readonly prompt: string;
}): Promise<void> {
  await writeFile(options.path, options.prompt, "utf8");
}

export function formatSessionTimestamp(date: Date): string {
  const compact = date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "");
  return `${compact.slice(0, 8)}-${compact.slice(9)}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
