import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Shared tmp-directory fixtures for the trst_watch suites. Every artifact (run
// dir, events.jsonl, cursor dir) lives in a per-test tmp directory — never the
// repo .trailstep/mcp. Both the behavioural suite and the canonical
// cross-consistency matrix build runs with these same helpers so a fixture
// cannot drift between the two.

export interface TmpSandbox {
  readonly root: string;
  readonly runDir: string;
  readonly cursorDir: string;
  readonly eventsFile: string;
}

export const sandboxes: TmpSandbox[] = [];

export function createSandbox(runId = "run-1"): TmpSandbox {
  const root = mkdtempSync(path.join(tmpdir(), "trst-watch-test-"));
  const runDir = path.join(root, "runs", runId);
  const cursorDir = path.join(root, "mcp-cursor");
  mkdirSync(runDir, { recursive: true });
  const sandbox: TmpSandbox = {
    root,
    runDir,
    cursorDir,
    eventsFile: path.join(runDir, "events.jsonl"),
  };
  sandboxes.push(sandbox);
  return sandbox;
}

export function cleanupSandboxes(): void {
  while (sandboxes.length > 0) {
    const sandbox = sandboxes.pop();
    if (sandbox) {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
}

export function eventLine(
  type: string,
  index: number,
  payload: Record<string, unknown> = {},
  stepId?: string,
): string {
  return JSON.stringify({
    id: `evt-${index}`,
    runId: "run-1",
    workflowId: "wf",
    ...(stepId === undefined ? {} : { stepId }),
    type,
    timestamp: new Date(0).toISOString(),
    schemaVersion: "v0",
    payload,
  });
}

export function waitLine(
  index: number,
  options: {
    readonly waitId: string;
    readonly question?: string;
    readonly branchId?: string;
    readonly answerFile?: string;
    readonly stepId?: string;
  },
): string {
  return eventLine(
    "wait.started",
    index,
    {
      waitId: options.waitId,
      ...(options.question === undefined ? {} : { message: options.question }),
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      ...(options.answerFile === undefined
        ? {}
        : { artifactPaths: { answerFile: options.answerFile } }),
    },
    options.stepId ?? "step-1",
  );
}

export function appendLines(sandbox: TmpSandbox, lines: readonly string[]): void {
  writeFileSync(sandbox.eventsFile, `${lines.join("\n")}\n`, "utf8");
}

export const deadPid = 2_147_483_646;
export const staleOwnerReason =
  "The track still reports running but its owner process is no longer alive.";

/**
 * Writes the durable track signal. The canonical classifier treats a missing
 * track as `unknown`, never `active`, so every open-run fixture needs one.
 */
export function writeTrack(
  sandbox: TmpSandbox,
  status = "running",
  ownerPid: number = process.pid,
): void {
  writeFileSync(
    path.join(sandbox.runDir, "track.json"),
    JSON.stringify({
      runId: path.basename(sandbox.runDir),
      workflowId: "wf",
      status,
      ownerPid,
      branches: [],
      splitOccurred: false,
    }),
    "utf8",
  );
}

/**
 * Writes a run lock held by a LIVE pid (this test process) without a track.
 * The lock alone is direct evidence of liveness, so classification must not
 * depend on track.json existing.
 */
export function writeLiveLockFile(sandbox: TmpSandbox): void {
  writeFileSync(
    path.join(sandbox.runDir, "run.lock"),
    JSON.stringify({
      schemaVersion: 1,
      runId: path.basename(sandbox.runDir),
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      lastHeartbeatAt: new Date(0).toISOString(),
      nonce: "test-live-lock",
    }),
    "utf8",
  );
}

/**
 * Writes a run lock held by a LIVE pid (this test process) plus the running
 * track a published run always has. Mirroring reality (a running continue holds
 * the lock and its track says running with a live owner) is what keeps an
 * in-progress fixture in-progress.
 */
export function writeLiveLock(sandbox: TmpSandbox): void {
  writeLiveLockFile(sandbox);
  writeTrack(sandbox);
}

/** Writes a dead run's leftovers: a dead lock and a running track with a dead owner. */
export function writeDeadLock(sandbox: TmpSandbox): void {
  writeFileSync(
    path.join(sandbox.runDir, "run.lock"),
    JSON.stringify({
      schemaVersion: 1,
      runId: path.basename(sandbox.runDir),
      pid: deadPid,
      startedAt: new Date(0).toISOString(),
      lastHeartbeatAt: new Date(0).toISOString(),
      nonce: "test-dead-lock",
    }),
    "utf8",
  );
  writeTrack(sandbox, "running", deadPid);
}

export function appendMoreLines(sandbox: TmpSandbox, lines: readonly string[]): void {
  writeFileSync(sandbox.eventsFile, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
}

export function quickOptions(sandbox: TmpSandbox, maxWaitMs = 250) {
  return {
    runDir: sandbox.runDir,
    cursorDir: sandbox.cursorDir,
    maxWaitMs,
    pollIntervalMs: 5,
  };
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
