import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defineWorkflow, done, step } from "../../authoring/authoring.js";
import { runWorkflow } from "../run-workflow/run-workflow.js";
import {
  acquireRunLock,
  isPidAlive,
  isRunLockLive,
  RUN_LOCK_FILE_NAME,
  readRunLock,
  releaseRunLock,
  runLockPath,
} from "./run-lock.js";

// NOTE: `@trailstep/trailtest` is not a dependency of `@trailstep/core` (trailtest depends on
// core), so this suite uses the local core-test convention of `mkdtemp` + tracked cleanup
// instead of `tmpProject` / `cleanupTmpProjects`.
const createdDirectories: string[] = [];

const FIXED_NOW = (): Date => new Date("2024-01-01T00:00:00.000Z");

async function makeRunDir(): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), "trailstep-run-lock-"));
  createdDirectories.push(runDir);
  return runDir;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5 })),
  );
});

describe("run lock", () => {
  it("acquires the lock in an empty run directory and records the current pid", async () => {
    const runDir = await makeRunDir();

    const result = await acquireRunLock({
      runDir,
      runId: "acquired-run",
      now: FIXED_NOW,
      pidIsAlive: () => false,
    });

    expect(result.status).toBe("acquired");
    if (result.status !== "acquired") {
      throw new Error(`Expected an acquired lock, received ${result.status}.`);
    }

    expect(await readRunLock(runDir)).toEqual({
      schemaVersion: 1,
      runId: "acquired-run",
      pid: process.pid,
      startedAt: "2024-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2024-01-01T00:00:00.000Z",
      nonce: result.lock.nonce,
    });
  });

  it("reports held and leaves the file untouched when the holder pid is alive", async () => {
    const runDir = await makeRunDir();
    const first = await acquireRunLock({
      runDir,
      runId: "contended-run",
      now: FIXED_NOW,
      pidIsAlive: () => false,
    });
    if (first.status !== "acquired") {
      throw new Error(`Expected an acquired lock, received ${first.status}.`);
    }

    const second = await acquireRunLock({
      runDir,
      runId: "contended-run",
      now: () => new Date("2024-06-01T00:00:00.000Z"),
      pidIsAlive: () => true,
    });

    expect(second.status).toBe("held");
    if (second.status !== "held") {
      throw new Error(`Expected a held lock, received ${second.status}.`);
    }
    expect(second.lock.nonce).toBe(first.lock.nonce);

    const onDisk = await readRunLock(runDir);
    expect(onDisk?.nonce).toBe(first.lock.nonce);
    expect(onDisk?.lastHeartbeatAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("replaces a lock left behind by a dead pid", async () => {
    const runDir = await makeRunDir();
    const previous = await acquireRunLock({
      runDir,
      runId: "stale-run",
      now: FIXED_NOW,
      pidIsAlive: () => false,
      pid: 424242,
    });
    if (previous.status !== "acquired") {
      throw new Error(`Expected an acquired lock, received ${previous.status}.`);
    }

    const replacement = await acquireRunLock({
      runDir,
      runId: "stale-run",
      now: () => new Date("2024-02-02T00:00:00.000Z"),
      pidIsAlive: () => false,
    });

    expect(replacement.status).toBe("stale-replaced");
    if (replacement.status !== "stale-replaced") {
      throw new Error(`Expected a replaced lock, received ${replacement.status}.`);
    }
    expect(replacement.previous.nonce).toBe(previous.lock.nonce);
    expect(replacement.previous.pid).toBe(424242);
    expect(replacement.lock.nonce).not.toBe(replacement.previous.nonce);
    expect(replacement.lock.pid).toBe(process.pid);

    const onDisk = await readRunLock(runDir);
    expect(onDisk?.nonce).toBe(replacement.lock.nonce);
  });

  it("releases the lock a process still owns", async () => {
    const runDir = await makeRunDir();
    const result = await acquireRunLock({ runDir, runId: "released-run", now: FIXED_NOW });
    if (result.status !== "acquired") {
      throw new Error(`Expected an acquired lock, received ${result.status}.`);
    }

    await expect(releaseRunLock(runDir, result.lock)).resolves.toBe(true);
    await expect(readRunLock(runDir)).resolves.toBeUndefined();
  });

  it("refuses to release a lock another process has taken over", async () => {
    const runDir = await makeRunDir();
    const slowRunner = await acquireRunLock({ runDir, runId: "takeover-run", now: FIXED_NOW });
    if (slowRunner.status !== "acquired") {
      throw new Error(`Expected an acquired lock, received ${slowRunner.status}.`);
    }

    // The slow runner is declared stale and a second process takes over.
    const takeover = await acquireRunLock({
      runDir,
      runId: "takeover-run",
      now: () => new Date("2024-03-03T00:00:00.000Z"),
      pidIsAlive: () => false,
    });
    if (takeover.status !== "stale-replaced") {
      throw new Error(`Expected a replaced lock, received ${takeover.status}.`);
    }

    await expect(releaseRunLock(runDir, slowRunner.lock)).resolves.toBe(false);
    const onDisk = await readRunLock(runDir);
    expect(onDisk?.nonce).toBe(takeover.lock.nonce);
  });

  it("reads a missing, empty, torn, or version-mismatched lock as absent", async () => {
    const runDir = await makeRunDir();
    await expect(readRunLock(runDir)).resolves.toBeUndefined();

    await writeFile(runLockPath(runDir), "", "utf8");
    await expect(readRunLock(runDir)).resolves.toBeUndefined();

    await writeFile(runLockPath(runDir), "{ not json", "utf8");
    await expect(readRunLock(runDir)).resolves.toBeUndefined();

    await writeFile(
      runLockPath(runDir),
      JSON.stringify({
        schemaVersion: 2,
        runId: "future-run",
        pid: 1,
        startedAt: "2024-01-01T00:00:00.000Z",
        lastHeartbeatAt: "2024-01-01T00:00:00.000Z",
        nonce: "future",
      }),
      "utf8",
    );
    await expect(readRunLock(runDir)).resolves.toBeUndefined();
  });

  it("decides liveness from the pid alone", async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(0)).toBe(false);

    const impossiblePid = isPidAlive(999999999) ? Number.MAX_SAFE_INTEGER : 999999999;
    expect(isPidAlive(impossiblePid)).toBe(false);

    const lock = {
      schemaVersion: 1 as const,
      runId: "liveness-run",
      pid: process.pid,
      startedAt: "2024-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2024-01-01T00:00:00.000Z",
      nonce: "nonce",
    };
    expect(isRunLockLive(lock)).toBe(true);
    expect(isRunLockLive(undefined)).toBe(false);
    expect(isRunLockLive(lock, () => false)).toBe(false);
  });

  it("leaves no temporary file behind after acquiring", async () => {
    const runDir = await makeRunDir();

    await acquireRunLock({ runDir, runId: "clean-run", now: FIXED_NOW });

    await expect(readdir(runDir)).resolves.toEqual([RUN_LOCK_FILE_NAME]);
  });
});

describe("runWorkflow run lock", () => {
  const simpleWorkflow = defineWorkflow<{ task: string }, { answer: string }>({
    id: "run-lock-simple",
    inputShape: { task: "string" },
    outputShape: { answer: "string" },
    start(input) {
      return step({ id: "answer" }).do(() => done({ answer: input.task }))();
    },
  });

  it("fails with run_already_active instead of driving a live-locked run directory", async () => {
    const cwd = await makeRunDir();
    const runDir = join(cwd, ".trailstep", "runs", "locked-run");
    await mkdir(runDir, { recursive: true });

    const seedEvents = join(runDir, "events.jsonl");
    await writeFile(seedEvents, "", "utf8");

    const held = await acquireRunLock({ runDir, runId: "locked-run", now: FIXED_NOW });
    if (held.status !== "acquired") {
      throw new Error(`Expected an acquired lock, received ${held.status}.`);
    }

    const result = await runWorkflow({
      workflow: simpleWorkflow,
      cwd,
      continue: { runDir },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error(`Expected a failure, received ${result.status}.`);
    }
    expect(result.failure.code).toBe("run_already_active");
    expect(result.failure.details).toMatchObject({ holderPid: process.pid });

    // The losing process must not delete the winner's lock, and must not run the workflow:
    // the trail holds only the failure event, never a `workflow.started`.
    const survivor = await readRunLock(runDir);
    expect(survivor?.nonce).toBe(held.lock.nonce);

    const trail = await readFile(seedEvents, "utf8");
    const eventTypes = trail
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(eventTypes).toEqual(["workflow.failed"]);
  });

  it("releases the lock when the run finishes so a later continue can take it", async () => {
    const cwd = await makeRunDir();

    const result = await runWorkflow({
      workflow: simpleWorkflow,
      input: { task: "release" },
      runName: "released-run",
      cwd,
    });

    expect(result.status).toBe("success");
    await expect(readRunLock(result.runDir)).resolves.toBeUndefined();
    await expect(readdir(result.runDir)).resolves.not.toContain(RUN_LOCK_FILE_NAME);
  });
});
