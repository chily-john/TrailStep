import { appendFile, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { describe, expect, it } from "vitest";
import { readRunEvents } from "../artifacts/run-storage.js";
import { classifyRunState } from "../evidence/classify-run-state.js";
import { listRunSummaries } from "../runs/run-summaries.js";
import {
  applyStorageLifecycle,
  archiveRun,
  assessStorageEligibility,
  deleteArchivedRun,
  deleteRun,
  pinRun,
  planStorageLifecycle,
  readStorageLifecycleStatus,
  restoreArchivedRun,
  unpinRun,
} from "./storage-lifecycle.js";

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

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
    // A started-only trail with no track is not evidence of a live run, so the
    // summary projects the classifier's unknown instead of assuming active.
    expect(summaries.map((summary) => `${summary.runId}:${summary.status}`)).toContain(
      "old-active:unknown",
    );
    expect(summaries.map((summary) => `${summary.runId}:${summary.status}`)).toContain(
      "old-pinned:completed",
    );
  });

  it("ignores staging infrastructure in lifecycle status and plan scans", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "old-terminal", "workflow-a", "2026-01-01T00:00:00.000Z");
    await writeTerminalRun(
      runsRoot,
      join(".staging", "phantom"),
      "workflow-a",
      "2026-01-01T00:00:00.000Z",
    );

    await expect(readStorageLifecycleStatus({ cwd, runsRoot })).resolves.toMatchObject({
      hotRuns: 1,
      archivedRuns: 0,
    });

    const actions = await planStorageLifecycle({
      cwd,
      runsRoot,
      policy: { enabled: true, archiveAfterDays: 1, deleteAfterDays: 30 },
      now: new Date("2026-01-10T00:00:00.000Z"),
    });
    expect(actions.map((action) => `${action.action}:${action.runId}`)).toEqual([
      "archive:old-terminal",
    ]);
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

  it("restores a legacy archive without a track as unknown, never as a fresh run", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeLegacyArchiveWithoutTrack(runsRoot, "legacy-no-track", {
      runId: "legacy-no-track",
      workflowId: "workflow-a",
      type: "workflow.started",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    await restoreArchivedRun({ runsRoot, runId: "legacy-no-track" });

    const runDir = join(runsRoot, "legacy-no-track");
    const classification = await classifyRunState({
      runDir,
      events: await readRunEvents(runDir),
    });
    expect(classification.state).toBe("unknown");
    expect(classification.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "missing-source",
    );
    await expect(stat(join(runsRoot, "legacy-no-track", "track.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("archives, restores, and deletes tracked run artifacts as one cleanup unit", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "tracked-run", "workflow-a", "2026-01-01T00:00:00.000Z");
    await writeTrackArtifacts(runsRoot, "tracked-run");

    await applyStorageLifecycle({
      cwd,
      runsRoot,
      policy: { enabled: true, archiveAfterDays: 1 },
      now: new Date("2026-01-03T00:00:00.000Z"),
    });

    await expect(stat(join(runsRoot, "tracked-run"))).rejects.toMatchObject({ code: "ENOENT" });
    const archivedPayload = JSON.parse(
      String(await gunzipAsync(await readFile(join(runsRoot, ".archive", "tracked-run.json.gz")))),
    ) as { readonly files: readonly { readonly path: string }[] };
    expect(archivedPayload.files.map((file) => file.path).sort()).toEqual([
      "branches/branch-1.json",
      "branches/branch-1.state.json",
      "events.jsonl",
      "global-state.json",
      "steps/0001-branch-step/document-1.md",
      "track.json",
    ]);

    await restoreArchivedRun({ runsRoot, runId: "tracked-run" });
    await expect(readFile(join(runsRoot, "tracked-run", "track.json"), "utf8")).resolves.toBe(
      '{"status":"completed"}\n',
    );
    await expect(
      readFile(join(runsRoot, "tracked-run", "branches", "branch-1.json"), "utf8"),
    ).resolves.toBe('{"branchId":"branch-1","status":"done"}\n');
    await expect(
      readFile(join(runsRoot, "tracked-run", "branches", "branch-1.state.json"), "utf8"),
    ).resolves.toBe('{"claimed":true}\n');
    await expect(
      readFile(join(runsRoot, "tracked-run", "global-state.json"), "utf8"),
    ).resolves.toBe('{"counter":1}\n');

    await deleteRun({ runsRoot, runId: "tracked-run" });
    await expect(stat(join(runsRoot, "tracked-run"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(runsRoot, "tracked-run", "branches"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("preserves eventless terminal tracks and refuses automatic/direct archive (D-LOCK-2/D4)", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    // This intentionally inverts the pre-D4 expectation that an eventless
    // terminal track was archive-eligible. D-LOCK-2/D4 treat the track as
    // scheduler metadata, not terminal proof, and preserve the run.
    const eventlessIds = [
      "eventless-completed",
      "eventless-failed",
      "eventless-cancelled",
    ] as const;
    await writeEventlessTerminalRun(runsRoot, eventlessIds[0], "completed", {
      runId: eventlessIds[0],
      workflowId: "workflow-a",
      status: "completed",
    });
    await writeEventlessTerminalRun(runsRoot, eventlessIds[1], "failed", {
      runId: eventlessIds[1],
      workflowId: "workflow-a",
      status: "failed",
    });
    await writeEventlessTerminalRun(runsRoot, eventlessIds[2], "cancelled", {
      runId: eventlessIds[2],
      workflowId: "workflow-a",
      status: "cancelled",
    });

    for (const runId of eventlessIds) {
      await expect(
        assessStorageEligibility({ runDir: join(runsRoot, runId) }),
      ).resolves.toMatchObject({
        eligible: false,
        code: "eventless-terminal-track",
        eventRead: "missing",
        track: "readable",
      });
    }

    const archivePolicy = {
      enabled: true,
      archiveAfterDays: 7,
      deleteAfterDays: 30,
    } as const;
    await expect(
      planStorageLifecycle({
        cwd,
        runsRoot,
        policy: archivePolicy,
        now: new Date("2026-01-10T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
    await expect(
      planStorageLifecycle({
        cwd,
        runsRoot,
        policy: { enabled: true, deleteAfterDays: 7 },
        now: new Date("2026-01-10T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);

    await expect(archiveRun({ runsRoot, runId: eventlessIds[0] })).rejects.toThrow(
      /not storage-eligible.*D-LOCK-2/u,
    );
    await expect(
      applyStorageLifecycle({
        cwd,
        runsRoot,
        policy: archivePolicy,
        now: new Date("2026-01-10T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);

    for (const runId of eventlessIds) {
      await expect(stat(join(runsRoot, runId))).resolves.toBeDefined();
    }
  });

  it("keeps parked failures and superseded terminal cycles out of archive", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeParkedFailureRun(runsRoot, "parked-step-failure", "workflow-a");
    await writeReopenedRun(runsRoot, "reopened-running", "workflow-a");
    // A terminal track written before workflow.completed must not make a run
    // with a non-terminal current cycle eligible, even with no lock at all.
    await writeFinishingRun(runsRoot, "finishing-run", "workflow-a", 999_999_999);

    await expect(
      planStorageLifecycle({
        cwd,
        runsRoot,
        policy: { enabled: true, archiveAfterDays: 7 },
        now: new Date("2026-01-10T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);

    for (const runId of ["parked-step-failure", "reopened-running", "finishing-run"]) {
      await expect(
        assessStorageEligibility({ runDir: join(runsRoot, runId) }),
      ).resolves.toMatchObject({ eligible: false, code: "terminal-missing" });
      await expect(archiveRun({ runsRoot, runId })).rejects.toThrow(/not storage-eligible/u);
      await expect(stat(join(runsRoot, runId))).resolves.toBeDefined();
    }
  });

  it("refuses malformed, partial, unreadable and aborted event trails", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "malformed-events", "workflow-a", "2026-01-01T00:00:00.000Z");
    await appendFile(join(runsRoot, "malformed-events", "events.jsonl"), "{not json}\n", "utf8");
    await writeTerminalRun(runsRoot, "partial-events", "workflow-a", "2026-01-01T00:00:00.000Z");
    await appendFile(join(runsRoot, "partial-events", "events.jsonl"), '{"id":"torn', "utf8");
    await writeTerminalRun(runsRoot, "unreadable-events", "workflow-a", "2026-01-01T00:00:00.000Z");
    await rm(join(runsRoot, "unreadable-events", "events.jsonl"));
    await mkdir(join(runsRoot, "unreadable-events", "events.jsonl"));

    await expect(
      planStorageLifecycle({
        cwd,
        runsRoot,
        policy: { enabled: true, archiveAfterDays: 7, deleteAfterDays: 7 },
        now: new Date("2026-01-10T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);

    await expect(
      assessStorageEligibility({ runDir: join(runsRoot, "malformed-events") }),
    ).resolves.toMatchObject({ eligible: false, code: "events-malformed" });
    await expect(
      assessStorageEligibility({ runDir: join(runsRoot, "partial-events") }),
    ).resolves.toMatchObject({ eligible: false, code: "events-partial" });
    await expect(
      assessStorageEligibility({ runDir: join(runsRoot, "unreadable-events") }),
    ).resolves.toMatchObject({ eligible: false, code: "events-unreadable" });
    await expect(
      assessStorageEligibility({
        runDir: join(runsRoot, "malformed-events"),
        signal: AbortSignal.abort(),
      }),
    ).resolves.toMatchObject({ eligible: false, code: "events-aborted" });

    await expect(archiveRun({ runsRoot, runId: "malformed-events" })).rejects.toThrow(
      /malformed JSON/u,
    );
    await expect(archiveRun({ runsRoot, runId: "partial-events" })).rejects.toThrow(
      /unfinished line/u,
    );
    await expect(archiveRun({ runsRoot, runId: "unreadable-events" })).rejects.toThrow(
      /could not be read/u,
    );
    for (const runId of ["malformed-events", "partial-events", "unreadable-events"]) {
      await expect(stat(join(runsRoot, runId))).resolves.toBeDefined();
    }
  });

  it("refuses a terminal event when the track is missing or unreadable", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "missing-track", "workflow-a", "2026-01-01T00:00:00.000Z");
    await rm(join(runsRoot, "missing-track", "track.json"));
    await writeTerminalRun(runsRoot, "malformed-track", "workflow-a", "2026-01-01T00:00:00.000Z");
    await writeFile(join(runsRoot, "malformed-track", "track.json"), "{not json\n", "utf8");
    await writeTerminalRun(runsRoot, "unreadable-track", "workflow-a", "2026-01-01T00:00:00.000Z");
    await rm(join(runsRoot, "unreadable-track", "track.json"));
    await mkdir(join(runsRoot, "unreadable-track", "track.json"));

    await expect(
      planStorageLifecycle({
        cwd,
        runsRoot,
        policy: { enabled: true, archiveAfterDays: 7, deleteAfterDays: 7 },
        now: new Date("2026-01-10T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);

    await expect(
      assessStorageEligibility({ runDir: join(runsRoot, "missing-track") }),
    ).resolves.toMatchObject({ eligible: false, code: "track-missing" });
    for (const runId of ["malformed-track", "unreadable-track"]) {
      await expect(
        assessStorageEligibility({ runDir: join(runsRoot, runId) }),
      ).resolves.toMatchObject({ eligible: false, code: "track-unreadable", track: "unreadable" });
      await expect(archiveRun({ runsRoot, runId })).rejects.toThrow(
        /track is present but unreadable/u,
      );
      await expect(stat(join(runsRoot, runId))).resolves.toBeDefined();
    }
    await expect(archiveRun({ runsRoot, runId: "missing-track" })).rejects.toThrow(
      /track is missing/u,
    );
    await expect(stat(join(runsRoot, "missing-track"))).resolves.toBeDefined();
  });

  it("requires strict lock ownership evidence for automatic and direct mutation", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    for (const runId of [
      "missing-lock",
      "dead-lock",
      "unknown-lock",
      "malformed-lock",
      "unreadable-lock",
    ]) {
      await writeTerminalRun(runsRoot, runId, "workflow-a", "2026-01-01T00:00:00.000Z");
    }
    await writeRunLockWithPid(join(runsRoot, "dead-lock"), "dead-lock", 999_999_999);
    await writeRunLockWithPid(join(runsRoot, "unknown-lock"), "unknown-lock", 0);
    await writeFile(join(runsRoot, "malformed-lock", "run.lock"), "{not json\n", "utf8");
    await mkdir(join(runsRoot, "unreadable-lock", "run.lock"));

    const actions = await planStorageLifecycle({
      cwd,
      runsRoot,
      policy: { enabled: true, archiveAfterDays: 7, deleteAfterDays: 30 },
      now: new Date("2026-01-10T00:00:00.000Z"),
    });
    expect(actions.map((action) => `${action.action}:${action.runId}`).sort()).toEqual([
      "archive:dead-lock",
      "archive:missing-lock",
    ]);

    await expect(
      assessStorageEligibility({ runDir: join(runsRoot, "missing-lock") }),
    ).resolves.toMatchObject({ eligible: true, code: "eligible", lock: "missing" });
    await expect(
      assessStorageEligibility({ runDir: join(runsRoot, "dead-lock") }),
    ).resolves.toMatchObject({ eligible: true, code: "eligible", lock: "dead" });
    await expect(
      assessStorageEligibility({ runDir: join(runsRoot, "unknown-lock") }),
    ).resolves.toMatchObject({ eligible: false, code: "lock-owner-unknown", lock: "unknown" });
    await expect(
      assessStorageEligibility({ runDir: join(runsRoot, "malformed-lock") }),
    ).resolves.toMatchObject({ eligible: false, code: "lock-malformed", lock: "malformed" });
    await expect(
      assessStorageEligibility({ runDir: join(runsRoot, "unreadable-lock") }),
    ).resolves.toMatchObject({ eligible: false, code: "lock-unreadable", lock: "unreadable" });

    await expect(archiveRun({ runsRoot, runId: "unknown-lock" })).rejects.toThrow(
      /unassessable owner/u,
    );
    await expect(archiveRun({ runsRoot, runId: "malformed-lock" })).rejects.toThrow(/malformed/u);
    await expect(archiveRun({ runsRoot, runId: "unreadable-lock" })).rejects.toThrow(/unreadable/u);
    await expect(deleteRun({ runsRoot, runId: "unknown-lock" })).rejects.toThrow(
      /unassessable lock owner/u,
    );
    await expect(deleteRun({ runsRoot, runId: "malformed-lock" })).rejects.toThrow(
      /malformed run.lock/u,
    );
    await expect(deleteRun({ runsRoot, runId: "unreadable-lock" })).rejects.toThrow(
      /unreadable run.lock/u,
    );
    for (const runId of ["unknown-lock", "malformed-lock", "unreadable-lock"]) {
      await expect(stat(join(runsRoot, runId))).resolves.toBeDefined();
    }

    // Explicit deletion remains available for an unwanted non-terminal run
    // only when ownership is proved safe (no lock here).
    await writeActiveRun(
      runsRoot,
      "unwanted-non-terminal",
      "workflow-a",
      "2026-01-01T00:00:00.000Z",
    );
    await deleteRun({ runsRoot, runId: "unwanted-non-terminal" });
    await expect(stat(join(runsRoot, "unwanted-non-terminal"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await archiveRun({ runsRoot, runId: "missing-lock" });
    await archiveRun({ runsRoot, runId: "dead-lock" });
    await expect(stat(join(runsRoot, "missing-lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(runsRoot, "dead-lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove the hot directory when reading an archive payload fails", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "payload-failure", "workflow-a", "2026-01-01T00:00:00.000Z");

    await expect(
      archiveRun({
        runsRoot,
        runId: "payload-failure",
        readPayload: async () => {
          throw new Error("injected payload read failure");
        },
      }),
    ).rejects.toThrow("injected payload read failure");

    await expect(stat(join(runsRoot, "payload-failure"))).resolves.toBeDefined();
    await expect(stat(join(runsRoot, ".archive", "payload-failure.json.gz"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("never plans or applies archive/delete for a run whose lock is live", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await writeTerminalRun(runsRoot, "locked-terminal", "workflow-a", "2026-01-01T00:00:00.000Z");
    await writeLiveLock(join(runsRoot, "locked-terminal"), "locked-terminal");
    await writeEventlessTerminalRun(runsRoot, "locked-eventless", "completed", {
      runId: "locked-eventless",
      workflowId: "workflow-a",
      status: "completed",
    });
    await writeLiveLock(join(runsRoot, "locked-eventless"), "locked-eventless");

    const actions = await planStorageLifecycle({
      cwd,
      runsRoot,
      policy: { enabled: true, archiveAfterDays: 1, deleteAfterDays: 1 },
      now: new Date("2026-01-10T00:00:00.000Z"),
    });
    expect(actions).toEqual([]);

    await expect(archiveRun({ runsRoot, runId: "locked-terminal" })).rejects.toThrow(
      "held by a live process and cannot be archived",
    );
    await expect(deleteRun({ runsRoot, runId: "locked-eventless" })).rejects.toThrow(
      "held by a live process and cannot be deleted",
    );
    await expect(stat(join(runsRoot, "locked-eventless"))).resolves.toBeDefined();
  });

  it("refuses reserved names in every name-addressed storage operation", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-storage-lifecycle-tests", task.id);
    const runsRoot = join(cwd, ".trailstep", "runs");
    await rm(cwd, { recursive: true, force: true });
    await mkdir(join(runsRoot, ".staging"), { recursive: true });
    await writeFile(join(runsRoot, ".staging", "keep.txt"), "staged", "utf8");
    await mkdir(join(runsRoot, ".archive"), { recursive: true });
    await writeFile(join(runsRoot, ".archive", "keep.txt"), "archived", "utf8");

    const operations = [
      () => archiveRun({ runsRoot, runId: ".staging" }),
      () => restoreArchivedRun({ runsRoot, runId: ".staging" }),
      () => pinRun({ runsRoot, runId: ".staging" }),
      () => unpinRun({ runsRoot, runId: ".staging" }),
      () => deleteRun({ runsRoot, runId: ".staging" }),
      () => deleteArchivedRun({ runsRoot, runId: ".archive" }),
      () => deleteRun({ runsRoot, runId: ".Archive" }),
      // Windows ignores trailing dots/spaces, so these must not alias the
      // reserved entries either.
      () => deleteRun({ runsRoot, runId: ".staging." }),
      () => deleteRun({ runsRoot, runId: ".staging " }),
      () => archiveRun({ runsRoot, runId: ".archive." }),
      () => deleteArchivedRun({ runsRoot, runId: ".archive " }),
      // Dot/space aliases of the runs root or its parent must never reach rm.
      () => deleteRun({ runsRoot, runId: "..." }),
      () => deleteRun({ runsRoot, runId: ".. " }),
      () => archiveRun({ runsRoot, runId: ". " }),
      () => deleteArchivedRun({ runsRoot, runId: ".." }),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({
        message: expect.stringMatching(/reserved for TrailStep storage infrastructure/u),
        failure: { code: "run_name_reserved" },
      });
    }

    await expect(readFile(join(runsRoot, ".staging", "keep.txt"), "utf8")).resolves.toBe("staged");
    await expect(readFile(join(runsRoot, ".archive", "keep.txt"), "utf8")).resolves.toBe(
      "archived",
    );
  });
});

async function writeTerminalRun(
  runsRoot: string,
  runId: string,
  workflowId: string,
  timestamp: string,
): Promise<void> {
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "events.jsonl"),
    `${eventLine({ runId, workflowId, type: "workflow.started", timestamp })}\n${eventLine({
      runId,
      workflowId,
      type: "workflow.completed",
      timestamp,
    })}\n`,
    "utf8",
  );
  // A normal terminal run has scheduler track metadata. D4 still refuses a
  // missing or unreadable track for the conservative mutation gate.
  await writeFile(
    join(runDir, "track.json"),
    `${JSON.stringify({ runId, workflowId, status: "completed" })}\n`,
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

async function writeEventlessTerminalRun(
  runsRoot: string,
  runId: string,
  status: "completed" | "failed" | "cancelled",
  track: { readonly runId: string; readonly workflowId: string; readonly status: string },
): Promise<void> {
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "track.json"), `${JSON.stringify({ ...track, status })}\n`, "utf8");
  const old = new Date("2026-01-01T00:00:00.000Z");
  await utimes(join(runDir, "track.json"), old, old);
  await utimes(runDir, old, old);
}

/** A run the scheduler has marked terminal in its track but whose event trail
 * is still non-terminal: the exact window in which the removed lifecycle
 * disjunct used to archive a live run. */
async function writeFinishingRun(
  runsRoot: string,
  runId: string,
  workflowId: string,
  ownerPid: number,
): Promise<void> {
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "events.jsonl"),
    `${eventLine({
      runId,
      workflowId,
      type: "workflow.started",
      timestamp: "2026-01-01T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "track.json"),
    `${JSON.stringify({ runId, workflowId, status: "completed", ownerPid, branches: [] })}\n`,
    "utf8",
  );
  const old = new Date("2026-01-01T00:00:00.000Z");
  await utimes(join(runDir, "events.jsonl"), old, old);
  await utimes(join(runDir, "track.json"), old, old);
  await utimes(runDir, old, old);
}

async function writeParkedFailureRun(
  runsRoot: string,
  runId: string,
  workflowId: string,
): Promise<void> {
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  const timestamp = "2026-01-01T00:00:00.000Z";
  await writeFile(
    join(runDir, "events.jsonl"),
    `${eventLine({ runId, workflowId, type: "workflow.started", timestamp })}\n${eventLine({
      runId,
      workflowId,
      type: "step.started",
      timestamp,
    })}\n${eventLine({
      runId,
      workflowId,
      type: "step.failed",
      timestamp,
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "track.json"),
    `${JSON.stringify({ runId, workflowId, status: "running", ownerPid: 999_999_999 })}\n`,
    "utf8",
  );
}

async function writeReopenedRun(
  runsRoot: string,
  runId: string,
  workflowId: string,
): Promise<void> {
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  const timestamp = "2026-01-01T00:00:00.000Z";
  await writeFile(
    join(runDir, "events.jsonl"),
    `${eventLine({ runId, workflowId, type: "workflow.started", timestamp })}\n${eventLine({
      runId,
      workflowId,
      type: "workflow.completed",
      timestamp,
    })}\n${eventLine({
      runId,
      workflowId,
      type: "workflow.resumed",
      timestamp,
    })}\n${eventLine({ runId, workflowId, type: "step.started", timestamp })}\n`,
    "utf8",
  );
  // The track still says completed from the superseded cycle. The terminal
  // event in that cycle must not authorize archive of the reopened run.
  await writeFile(
    join(runDir, "track.json"),
    `${JSON.stringify({ runId, workflowId, status: "completed" })}\n`,
    "utf8",
  );
}

async function writeLiveLock(runDir: string, runId: string): Promise<void> {
  await writeRunLockWithPid(runDir, runId, process.pid);
}

async function writeRunLockWithPid(runDir: string, runId: string, pid: number): Promise<void> {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  await writeFile(
    join(runDir, "run.lock"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      pid,
      startedAt: now,
      lastHeartbeatAt: now,
      nonce: `test-lock-${runId}-${pid}`,
    })}\n`,
    "utf8",
  );
}

async function writeLegacyArchiveWithoutTrack(
  runsRoot: string,
  runId: string,
  event: {
    readonly runId: string;
    readonly workflowId: string;
    readonly type: string;
    readonly timestamp: string;
  },
): Promise<void> {
  await mkdir(join(runsRoot, ".archive"), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    runId,
    archivedAt: "2026-01-02T00:00:00.000Z",
    sourceRunDir: join(runsRoot, runId),
    workflowId: event.workflowId,
    lastTimestamp: event.timestamp,
    status: "cancelled",
  };
  const payload = {
    manifest,
    files: [
      {
        path: "events.jsonl",
        contentBase64: Buffer.from(`${eventLine(event)}\n`, "utf8").toString("base64"),
      },
    ],
  };
  await writeFile(
    join(runsRoot, ".archive", `${runId}.json.gz`),
    await gzipAsync(JSON.stringify(payload)),
    "utf8",
  );
  await writeFile(
    join(runsRoot, ".archive", `${runId}.manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function writeTrackArtifacts(runsRoot: string, runId: string): Promise<void> {
  const runDir = join(runsRoot, runId);
  await mkdir(join(runDir, "branches"), { recursive: true });
  await mkdir(join(runDir, "steps", "0001-branch-step"), { recursive: true });
  await writeFile(join(runDir, "track.json"), '{"status":"completed"}\n', "utf8");
  await writeFile(join(runDir, "global-state.json"), '{"counter":1}\n', "utf8");
  await writeFile(
    join(runDir, "branches", "branch-1.json"),
    '{"branchId":"branch-1","status":"done"}\n',
    "utf8",
  );
  await writeFile(join(runDir, "branches", "branch-1.state.json"), '{"claimed":true}\n', "utf8");
  await writeFile(join(runDir, "steps", "0001-branch-step", "document-1.md"), "done", "utf8");
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
