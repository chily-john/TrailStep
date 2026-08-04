import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

export interface ActiveInteractiveSessionSummary {
  readonly interactiveFile: string;
  readonly label: string;
}

interface InteractiveSessionRecord {
  readonly status?: unknown;
  readonly runDir?: unknown;
  readonly stepId?: unknown;
  readonly artifactStepId?: unknown;
  readonly outputMode?: unknown;
}

export async function findActiveInteractiveSessions(cwd: string): Promise<readonly ActiveInteractiveSessionSummary[]> {
  const runsDir = join(cwd, ".stepkit", "runs");
  const files = await findInteractiveFiles(runsDir);
  const sessions: ActiveInteractiveSessionSummary[] = [];

  for (const interactiveFile of files) {
    const protocol = await readInteractiveProtocol(interactiveFile);
    if (protocol?.status !== "active") {
      continue;
    }

    sessions.push({
      interactiveFile,
      label: formatSessionLabel(cwd, interactiveFile, protocol),
    });
  }

  return sessions.sort((left, right) => left.label.localeCompare(right.label));
}

async function findInteractiveFiles(dir: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findInteractiveFiles(path)));
    } else if (entry.isFile() && entry.name === "interactive.json") {
      files.push(path);
    }
  }
  return files;
}

async function readInteractiveProtocol(path: string): Promise<InteractiveSessionRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function formatSessionLabel(cwd: string, interactiveFile: string, protocol: InteractiveSessionRecord): string {
  const runId = typeof protocol.runDir === "string" ? basename(protocol.runDir) : inferRunId(cwd, interactiveFile);
  const stepId = typeof protocol.stepId === "string" ? protocol.stepId : "unknown";
  const artifactStepId = typeof protocol.artifactStepId === "string" ? protocol.artifactStepId : "unknown";
  const outputMode = typeof protocol.outputMode === "string" ? protocol.outputMode : "unknown";
  return `run ${runId} | step ${stepId} | artifact ${artifactStepId} | mode ${outputMode}`;
}

function inferRunId(cwd: string, interactiveFile: string): string {
  const parts = relative(join(cwd, ".stepkit", "runs"), interactiveFile).split(/[\\/]/u);
  return parts[0] ?? "unknown";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
