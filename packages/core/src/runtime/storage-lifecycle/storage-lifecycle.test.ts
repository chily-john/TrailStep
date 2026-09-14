import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { listRunSummaries } from "../runs/run-summaries.js";
import {
  applyStorageLifecycle,
  deleteRun,
  pinRun,
  planStorageLifecycle,
  restoreArchivedRun,
  unpinRun,
} from "./storage-lifecycle.js";

describe("storage lifecycle", () => {
  it("does nothing when lifecycle is disabled", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "old-run", "workflow-a", "2026-01-01T00:00:00.000Z");

    await expect(
      planStorageLifecycle({
        cwd,
        runsRoot,
        policy: { enabled: false, archiveAfterDays: 7, deleteAfterDays: 30 },
        now: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
  });

  it("lets workflow false overrides disable default archive and delete actions", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "keep-hot", "workflow-a", "2026-01-01T00:00:00.000Z");
    await writeTerminalRun(runsRoot, "delete-hot", "workflow-b", "2026-01-01T00:00:00.000Z");

    const actions = await planStorageLifecycle({
      cwd,
      runsRoot,
      policy: {
        enabled: true,
        archiveAfterDays: 7,
        deleteAfterDays: 30,
        workflows: {
          "workflow-a": { archiveAfterDays: false, deleteAfterDays: false },
        },
      },
      now: new Date("2026-02-01T00:00:00.000Z"),
    });

    expect(actions.map((action) => `${action.action}:${action.runId}`)).toEqual([
      "delete-hot:delete-hot",
    ]);
  });

  it("archives terminal runs, skips active and pinned runs, and keeps archived runs visible", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "old-terminal", "workflow-a", "2026-01-01T00:00:00.000Z");
    await writeActiveRun(runsRoot, "old-active", "workflow-a", "2026-01-01T00:00:00.000Z");
    await writeTerminalRun(runsRoot, "old-pinned", "workflow-a", "2026-01-01T00:00:00.000Z");
    await pinRun({ runsRoot, runId: "old-pinned" });

    const actions = await applyStorageLifecycle({
      cwd,
      runsRoot,
      policy: { enabled: true, archiveAfterDays: 7, deleteAfterDays: 30 },
      now: new Date("2026-01-10T00:00:00.000Z"),
    });

    expect(actions.map((action) => `${action.action}:${action.runId}`)).toEqual([
      "archive:old-terminal",
    ]);
    await expect(stat(join(runsRoot, "old-terminal"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(runsRoot, ".archive", "old-terminal.manifest.json"), "utf8"),
    ).resolves.toContain('"runId": "old-terminal"');

    const summaries = await listRunSummaries({ cwd, runsRoot });
    expect(summaries.map((summary) => `${summary.runId}:${summary.status}`)).toContain(
      "old-terminal:archived",
    );
    expect(summaries.map((summary) => `${summary.runId}:${summary.status}`)).toContain(
      "old-active:active",
    );
    expect(summaries.map((summary) => `${summary.runId}:${summary.status}`)).toContain(
      "old-pinned:completed",
    );
  });

  it("restores archived run files explicitly and removes archive copies", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "restore-me", "workflow-a", "2026-01-01T00:00:00.000Z");
    await writeFile(join(runsRoot, "restore-me", "artifact.txt"), "hello", "utf8");
    await applyStorageLifecycle({
      cwd,
      runsRoot,
      policy: { enabled: true, archiveAfterDays: 1 },
      now: new Date("2026-01-03T00:00:00.000Z"),
    });

    await restoreArchivedRun({ runsRoot, runId: "restore-me" });

    await expect(readFile(join(runsRoot, "restore-me", "artifact.txt"), "utf8")).resolves.toBe(
      "hello",
    );
    await expect(stat(join(runsRoot, ".archive", "restore-me.json.gz"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(join(runsRoot, ".archive", "restore-me.manifest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to restore over an existing hot run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "restore-conflict", "workflow-a", "2026-01-01T00:00:00.000Z");
    await applyStorageLifecycle({
      cwd,
      runsRoot,
      policy: { enabled: true, archiveAfterDays: 1 },
      now: new Date("2026-01-03T00:00:00.000Z"),
    });
    await writeTerminalRun(runsRoot, "restore-conflict", "workflow-a", "2026-01-04T00:00:00.000Z");

    await expect(restoreArchivedRun({ runsRoot, runId: "restore-conflict" })).rejects.toThrow(
      "already exists in hot storage",
    );
  });

  it("rejects pin and unpin for archived or missing runs", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "archived-run", "workflow-a", "2026-01-01T00:00:00.000Z");
    await applyStorageLifecycle({
      cwd,
      runsRoot,
      policy: { enabled: true, archiveAfterDays: 1 },
      now: new Date("2026-01-03T00:00:00.000Z"),
    });

    await expect(pinRun({ runsRoot, runId: "archived-run" })).rejects.toThrow(
      "archived; restore it before pinning",
    );
    await expect(unpinRun({ runsRoot, runId: "archived-run" })).rejects.toThrow(
      "archived; restore it before unpinning",
    );
    await expect(pinRun({ runsRoot, runId: "missing-run" })).rejects.toThrow("does not exist");
  });

  it("deletes archived runs but protects pinned hot runs", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "archived-delete", "workflow-a", "2026-01-01T00:00:00.000Z");
    await writeTerminalRun(runsRoot, "hot-pinned", "workflow-a", "2026-01-01T00:00:00.000Z");
    await pinRun({ runsRoot, runId: "hot-pinned" });
    await applyStorageLifecycle({
      cwd,
      runsRoot,
      policy: { enabled: true, archiveAfterDays: 1 },
      now: new Date("2026-01-03T00:00:00.000Z"),
    });

    await expect(deleteRun({ runsRoot, runId: "hot-pinned" })).rejects.toThrow(
      "pinned and cannot be deleted",
    );
    await deleteRun({ runsRoot, runId: "archived-delete" });

    await expect(stat(join(runsRoot, ".archive", "archived-delete.json.gz"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      stat(join(runsRoot, ".archive", "archived-delete.manifest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function writeTerminalRun(
  runsRoot: string,
  runId: string,
  workflowId: string,
  timestamp: string,
): Promise<void> {
  await mkdir(join(runsRoot, runId), { recursive: true });
  await writeFile(
    join(runsRoot, runId, "events.jsonl"),
    `${eventLine({ runId, workflowId, type: "workflow.started", timestamp })}\n${eventLine({
      runId,
      workflowId,
      type: "workflow.completed",
      timestamp,
    })}\n`,
    "utf8",
  );
}

async function writeActiveRun(
  runsRoot: string,
  runId: string,
  workflowId: string,
  timestamp: string,
): Promise<void> {
  await mkdir(join(runsRoot, runId), { recursive: true });
  await writeFile(
    join(runsRoot, runId, "events.jsonl"),
    `${eventLine({ runId, workflowId, type: "workflow.started", timestamp })}\n`,
    "utf8",
  );
}

function eventLine(options: {
  readonly runId: string;
  readonly workflowId: string;
  readonly type: string;
  readonly timestamp: string;
}): string {
  return JSON.stringify({
    id: `${options.runId}-${options.type}`,
    runId: options.runId,
    workflowId: options.workflowId,
    type: options.type,
    timestamp: options.timestamp,
    schemaVersion: "v0",
    payload: {},
  });
}
