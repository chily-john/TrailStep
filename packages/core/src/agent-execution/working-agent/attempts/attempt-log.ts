import { appendFile, readFile, writeFile } from "node:fs/promises";

/**
 * Incremental per-attempt audit trail. Every failed spawn appends one record
 * the moment it happens, so a runner that dies mid-cascade still leaves a
 * complete on-disk account of what was attempted and why it moved on.
 */

export interface WorkingAgentAttemptRecord {
  readonly timestamp: string;
  readonly provider: string;
  readonly model?: string;
  readonly phase: string;
  readonly attempt?: number;
  readonly spawnTry?: number;
  readonly exitCode?: number;
  readonly failureCode?: string;
  readonly message: string;
  readonly transient: boolean;
  readonly decision: "retry" | "retryFormat" | "nextTarget" | "fail";
  readonly delayMs?: number;
  readonly stderrTail?: string;
}

export async function appendAttemptLog(
  attemptsFile: string,
  record: WorkingAgentAttemptRecord,
): Promise<void> {
  let attempts: WorkingAgentAttemptRecord[] = [];
  try {
    const existing = JSON.parse(await readFile(attemptsFile, "utf8")) as unknown;
    if (Array.isArray(existing)) {
      attempts = existing as WorkingAgentAttemptRecord[];
    }
  } catch {
    // Missing or unreadable log: start a fresh one.
  }
  attempts.push(record);
  await writeFile(attemptsFile, `${JSON.stringify(attempts, null, 2)}\n`, "utf8");
}

/**
 * Best-effort stderr capture artifact. Appends per phase so a step's stderr
 * file shows every spawn attempt in order; never throws into the failure path.
 */
export async function appendStderrArtifact(
  stderrFile: string,
  entry: { readonly phase: string; readonly spawnTry?: number; readonly exitCode: number },
  stderr: string | undefined,
): Promise<void> {
  try {
    const spawnLabel = entry.spawnTry === undefined ? "" : ` spawn ${entry.spawnTry}`;
    await appendFile(
      stderrFile,
      `--- ${entry.phase}${spawnLabel} (exit ${entry.exitCode}) ---\n${stderr ?? "<no stderr captured>"}\n`,
      "utf8",
    );
  } catch {
    // Artifacts are observability only; never mask the underlying failure.
  }
}
